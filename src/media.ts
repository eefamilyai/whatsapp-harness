import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { config } from "./config.js";
import { geminiAnalyze, geminiEnabled } from "./gemini.js";
import type { MediaInfo } from "./incoming.js";
import { log } from "./log.js";

export interface ImageInput {
  mime: string;
  base64: string;
}

export interface Ingested {
  /** What the model is told this turn. */
  prompt: string;
  /** Shorter version kept in conversation history. */
  historyText: string;
  images: ImageInput[];
  /** When set, nothing is sent to the model: tell the user this instead. */
  refusal?: string;
}

const MB = 1024 * 1024;
const MAX_IMAGE = 20 * MB;
const MAX_DOC = 30 * MB;
const MAX_GEMINI = 18 * MB; // inline request limit is ~20 MB
const PROMPT_TEXT_MAX = 30_000;
const HISTORY_TEXT_MAX = 1_200;
const KEEP_DAYS = 14;

// ---------- attachment store: data/media/<id>.<ext> (+ <id>.txt with extracted text) ----------

export function saveAttachment(buf: Buffer, ext: string, extractedText?: string): string {
  const id = `a${randomBytes(3).toString("hex")}`;
  fs.mkdirSync(config.mediaDir, { recursive: true });
  fs.writeFileSync(path.join(config.mediaDir, `${id}.${ext.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin"}`), buf);
  if (extractedText !== undefined) fs.writeFileSync(path.join(config.mediaDir, `${id}.txt`), extractedText);
  return id;
}

/** The original file of an attachment (not its .txt companion). */
export function findAttachment(id: string): { file: string; ext: string } | undefined {
  if (!/^a[0-9a-f]{6}$/.test(id)) return undefined;
  const hit = fs.readdirSync(config.mediaDir).find((f) => f.startsWith(`${id}.`) && !f.endsWith(".txt"));
  return hit ? { file: path.join(config.mediaDir, hit), ext: hit.split(".").pop()! } : undefined;
}

export function readAttachmentText(id: string): string | undefined {
  if (!/^a[0-9a-f]{6}$/.test(id)) return undefined;
  const p = path.join(config.mediaDir, `${id}.txt`);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
}

export function cleanupAttachments(maxAgeDays = KEEP_DAYS): number {
  let n = 0;
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  try {
    for (const f of fs.readdirSync(config.mediaDir)) {
      const p = path.join(config.mediaDir, f);
      if (fs.statSync(p).mtimeMs < cutoff) {
        fs.rmSync(p, { force: true });
        n++;
      }
    }
  } catch {
    /* nothing to clean */
  }
  return n;
}

export const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", "3gp": "video/3gpp",
  ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", aac: "audio/aac",
};

// ---------- document text extraction ----------

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "log", "html", "htm", "css", "svg",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "ps1", "bat", "cmd", "sql", "r", "swift", "lua", "tex", "srt", "vtt", "ics", "vcf", "gitignore",
]);

const extOf = (name?: string): string => (name?.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096);
  if (sample.includes(0)) return false;
  let bad = 0;
  for (const b of sample) if (b < 9 || (b > 13 && b < 32)) bad++;
  return bad / Math.max(1, sample.length) < 0.02;
}

const decodeXml = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

/** Word: paragraphs, tabs and line breaks kept; tables flatten to tab-separated rows. */
export function docxText(files: Record<string, Uint8Array>): string {
  const xml = files["word/document.xml"];
  if (!xml) throw new Error("not a valid .docx (no word/document.xml)");
  return decodeXml(
    strFromU8(xml)
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:br\/>/g, "\n")
      .replace(/<\/w:p>\s*<\/w:tc>/g, "\t")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function pptxText(files: Record<string, Uint8Array>): string {
  const slides = Object.keys(files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  if (!slides.length) throw new Error("not a valid .pptx (no slides)");
  return slides
    .map((f, i) => {
      const paras = strFromU8(files[f]!)
        .split(/<\/a:p>/)
        .map((p) => decodeXml([...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join("")))
        .filter((t) => t.trim());
      return `--- Slide ${i + 1} ---\n${paras.join("\n")}`;
    })
    .join("\n\n");
}

const colIndex = (ref: string): number => {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? "") n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

export function xlsxText(files: Record<string, Uint8Array>): string {
  const wb = files["xl/workbook.xml"];
  if (!wb) throw new Error("not a valid .xlsx (no workbook)");
  const shared = files["xl/sharedStrings.xml"]
    ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
        decodeXml([...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
      )
    : [];
  const names = [...strFromU8(wb).matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]!));
  const sheetFiles = Object.keys(files)
    .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  return sheetFiles
    .map((f, i) => {
      const rows: string[] = [];
      for (const row of strFromU8(files[f]!).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells: string[] = [];
        for (const c of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1]!;
          const inner = c[2] ?? "";
          const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
          const type = /t="(\w+)"/.exec(attrs)?.[1];
          let v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
          if (type === "s") v = shared[Number(v)] ?? "";
          else if (type === "inlineStr") v = decodeXml([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
          else v = decodeXml(v);
          if (ref) cells[colIndex(ref)] = v;
        }
        if (cells.some((c) => c)) rows.push(Array.from(cells, (c) => c ?? "").join("\t"));
      }
      return `--- Sheet: ${names[i] ?? `Sheet${i + 1}`} ---\n${rows.join("\n")}`;
    })
    .join("\n\n");
}

export async function pdfText(buf: Buffer): Promise<{ text: string; pages: number }> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map((t, i) => `--- Page ${i + 1} ---\n${t.trim()}`);
  return { text: (text as string[]).every((t) => !t.trim()) ? "" : pages.join("\n\n"), pages: totalPages };
}

type Extracted = { text: string; label: string } | { unreadable: string };

/** Turn a document into text, locally. Returns `unreadable` with the reason when it cannot. */
export async function extractDocument(buf: Buffer, mime: string, fileName?: string): Promise<Extracted> {
  const ext = extOf(fileName);
  try {
    if (mime === "application/pdf" || ext === "pdf") {
      const { text, pages } = await pdfText(buf);
      if (text) return { text, label: `PDF, ${pages} page${pages === 1 ? "" : "s"}` };
      if (geminiEnabled() && buf.length <= MAX_GEMINI) {
        const t = await geminiAnalyze("application/pdf", buf, "This PDF has no text layer (scanned). Transcribe all of its text faithfully, page by page, marking pages as '--- Page N ---'. Describe figures briefly in [brackets].");
        return { text: t, label: `scanned PDF, ${pages} page${pages === 1 ? "" : "s"}, read by Gemini` };
      }
      return { unreadable: "This PDF has no selectable text (it looks scanned). Send photos of the pages instead, or add a GEMINI_API_KEY so I can read scanned PDFs." };
    }
    if (["docx", "xlsx", "pptx"].includes(ext) || /officedocument\.(wordprocessingml|spreadsheetml|presentationml)/.test(mime)) {
      const files = unzipSync(new Uint8Array(buf));
      if (ext === "xlsx" || /spreadsheetml/.test(mime)) return { text: xlsxText(files), label: "Excel workbook" };
      if (ext === "pptx" || /presentationml/.test(mime)) return { text: pptxText(files), label: "PowerPoint" };
      return { text: docxText(files), label: "Word document" };
    }
    if (mime.startsWith("text/") || TEXT_EXT.has(ext) || mime === "application/json" || mime === "application/xml" || (mime === "application/octet-stream" && looksLikeText(buf))) {
      if (!looksLikeText(buf)) return { unreadable: "That file looks binary, not text." };
      return { text: buf.toString("utf8"), label: ext ? `${ext} text file` : "text file" };
    }
    if (["doc", "xls", "ppt"].includes(ext)) return { unreadable: `Old binary .${ext} files can't be read. Save it as .${ext}x or PDF and resend.` };
    if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return { unreadable: "I can't open archives. Send the file inside it." };
    if (MIME_BY_EXT[ext]?.startsWith("image/")) return { unreadable: "image" }; // handled by the caller as an image
    return { unreadable: `I can't read ${ext ? `.${ext}` : mime} files.` };
  } catch (err) {
    return { unreadable: `I couldn't read that file: ${(err as Error).message}` };
  }
}

// ---------- turning an incoming attachment into a model turn ----------

const clock = (s?: number): string => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "");
const cut = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`);

function refuse(why: string): Ingested {
  return { prompt: "", historyText: "", images: [], refusal: why };
}

const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export async function ingest(info: MediaInfo, download: () => Promise<Buffer>): Promise<Ingested> {
  const caption = info.caption;
  const ask = caption ? `\nThe user's message with it: ${caption}` : "\n(The user gave no instruction with it; say briefly what it is and offer useful next steps.)";

  if (info.inline) return { prompt: `[${info.kind}] ${info.inline}${caption ? `\n${caption}` : ""}`, historyText: cut(info.inline, HISTORY_TEXT_MAX), images: [] };

  if (info.sizeBytes && info.sizeBytes > MAX_DOC * 2) return refuse(`That ${info.kind} is too large for me (${Math.round(info.sizeBytes / MB)} MB).`);

  // ----- images and stickers: straight to the vision model -----
  if (info.kind === "image" || info.kind === "sticker") {
    if (info.sizeBytes && info.sizeBytes > MAX_IMAGE) return refuse("That image is too large (over 20 MB).");
    const buf = await download();
    const mime = IMAGE_MIMES.has(info.mime) ? info.mime : "image/jpeg";
    const id = saveAttachment(buf, mime.split("/")[1]!.replace("jpeg", "jpg"));
    const what = info.kind === "sticker" ? "Sticker" : "Image";
    if (config.llm.vision) {
      return {
        prompt: `[${what} attached, id ${id}]${ask}`,
        historyText: `[${what} sent, id ${id}]${caption ? ` ${caption}` : ""}`,
        images: [{ mime, base64: buf.toString("base64") }],
      };
    }
    if (geminiEnabled()) {
      const d = await geminiAnalyze(mime, buf, "Describe this image in detail and transcribe any text in it exactly.");
      return { prompt: `[${what} attached, id ${id}; described by a vision model: ${d}]${ask}`, historyText: `[${what} sent, id ${id}: ${cut(d, 300)}]${caption ? ` ${caption}` : ""}`, images: [] };
    }
    return refuse(`I can't look at images with the current model (LLM_VISION is off). Set LLM_MODEL=deepseek-flash, or add a GEMINI_API_KEY.`);
  }

  // ----- audio / voice notes: transcribe -----
  if (info.kind === "audio") {
    if (!geminiEnabled()) return refuse("I can't listen to voice notes yet: DeepSeek has no audio input. Add a GEMINI_API_KEY to .env (free tier works) and I will transcribe them. For now, type it.");
    if (info.sizeBytes && info.sizeBytes > MAX_GEMINI) return refuse("That audio is too long for me (over 18 MB).");
    const buf = await download();
    const id = saveAttachment(buf, info.mime.includes("mpeg") ? "mp3" : info.mime.split("/")[1] ?? "ogg");
    const t = await geminiAnalyze(info.mime, buf, "Transcribe this audio verbatim, in its original language. If it is not English, add an English translation after it in [brackets]. Output only the transcript. If there is no speech, describe the sounds in one line.");
    return {
      prompt: `[${info.voiceNote ? "Voice note" : "Audio"} ${clock(info.seconds)}, transcribed${info.voiceNote ? "; treat it as the user's message" : ""}, id ${id}]\n${t}`,
      historyText: `[${info.voiceNote ? "Voice note" : "Audio"}] ${cut(t, HISTORY_TEXT_MAX)}`,
      images: [],
    };
  }

  // ----- video: Gemini or nothing -----
  if (info.kind === "video") {
    if (!geminiEnabled()) return refuse("I can't watch videos: DeepSeek has no video input. Add a GEMINI_API_KEY to .env and I will describe and transcribe videos up to ~18 MB. Or send a screenshot of the part you mean.");
    if (info.sizeBytes && info.sizeBytes > MAX_GEMINI) return refuse(`That video is too big for me (${Math.round(info.sizeBytes / MB)} MB, limit 18 MB). Trim it or send a shorter clip.`);
    const buf = await download();
    const id = saveAttachment(buf, info.mime.includes("quicktime") ? "mov" : info.mime.split("/")[1] ?? "mp4");
    const d = await geminiAnalyze(info.mime, buf, `Describe this video: what happens, who/what is shown, any on-screen text, and transcribe any speech. ${caption ? `The user asks: ${caption}` : ""}`);
    return {
      prompt: `[${info.gif ? "GIF" : "Video"} ${clock(info.seconds)}, analysed by a video model, id ${id}]\n${d}${ask}`,
      historyText: `[${info.gif ? "GIF" : "Video"} sent, id ${id}: ${cut(d, 500)}]${caption ? ` ${caption}` : ""}`,
      images: [],
    };
  }

  // ----- documents -----
  if (info.sizeBytes && info.sizeBytes > MAX_DOC) return refuse("That file is too large (over 30 MB).");
  const buf = await download();
  const name = info.fileName ?? "document";
  const ext = extOf(name) || (info.mime.split("/")[1] ?? "bin");
  // A photo sent "as a document" is still a photo.
  if (IMAGE_MIMES.has(info.mime) || IMAGE_MIMES.has(MIME_BY_EXT[ext] ?? "")) {
    return ingest({ ...info, kind: "image", mime: IMAGE_MIMES.has(info.mime) ? info.mime : MIME_BY_EXT[ext]! }, async () => buf);
  }
  const ex = await extractDocument(buf, info.mime, info.fileName);
  if ("unreadable" in ex) {
    const id = saveAttachment(buf, ext);
    return refuse(`${ex.unreadable} (Saved on the host as ${id}.${ext} in case a command can handle it.)`);
  }
  const full = ex.text.trim();
  const id = saveAttachment(buf, ext, full);
  const truncated = full.length > PROMPT_TEXT_MAX;
  const body = truncated
    ? `${full.slice(0, PROMPT_TEXT_MAX)}\n…[truncated: ${full.length} characters in total. Use read_attachment with id ${id} and offset ${PROMPT_TEXT_MAX} to read on.]`
    : full || "(empty)";
  log.info(`ingested document ${name}: ${full.length} chars (${ex.label})`);
  return {
    prompt: `[File "${name}" attached: ${ex.label}, id ${id}]${ask}\n\n--- file content ---\n${body}`,
    historyText: `[File "${name}" sent (${ex.label}), id ${id}; content: ${cut(full.replace(/\s+/g, " "), HISTORY_TEXT_MAX)}]${caption ? ` ${caption}` : ""}`,
    images: [],
  };
}
