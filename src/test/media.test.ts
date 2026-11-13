import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { zipSync, strToU8 } from "fflate";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "wah-"));
process.env.GEMINI_API_KEY = "";

const media = await import("../media.js");
const { config } = await import("../config.js");
const { attachmentTools } = await import("../tools/attachments.js");

/** A minimal single-page PDF with real text, built with correct xref offsets. */
function pdf(lines: string[]): Buffer {
  const content = `BT /F1 18 Tf 72 720 Td ${lines.map((l, i) => `${i ? "0 -24 Td " : ""}(${l.replace(/[()\\]/g, "\\$&")}) Tj`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

const docxFile = zipSync({
  "[Content_Types].xml": strToU8("<Types/>"),
  "word/document.xml": strToU8(
    `<w:document><w:body><w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p><w:p><w:r><w:t>Revenue &amp; costs</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
  ),
});
const xlsxFile = zipSync({
  "xl/workbook.xml": strToU8(`<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>`),
  "xl/sharedStrings.xml": strToU8(`<sst><si><t>Item</t></si><si><t>Coffee &amp; tea</t></si></sst>`),
  "xl/worksheets/sheet1.xml": strToU8(
    `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Cost</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>4.5</v></c></row></sheetData></worksheet>`,
  ),
});
const pptxFile = zipSync({
  "ppt/slides/slide1.xml": strToU8(`<p:sld><a:p><a:r><a:t>Welcome</a:t></a:r></a:p><a:p><a:r><a:t>Agenda</a:t></a:r></a:p></p:sld>`),
  "ppt/slides/slide2.xml": strToU8(`<p:sld><a:p><a:r><a:t>Numbers</a:t></a:r></a:p></p:sld>`),
});

test("PDF text is extracted page by page", async () => {
  const r = await media.extractDocument(pdf(["Invoice 42", "Total: $1,234.50"]), "application/pdf", "inv.pdf");
  assert.ok("text" in r, JSON.stringify(r));
  assert.match(r.text, /Invoice 42/);
  assert.match(r.text, /Total: \$1,234\.50/);
  assert.match(r.label, /1 page/);
});

test("Word, Excel and PowerPoint files are read", async () => {
  const d = await media.extractDocument(Buffer.from(docxFile), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "r.docx");
  assert.ok("text" in d);
  assert.match(d.text, /Quarterly report\nRevenue & costs/);
  assert.match(d.text, /A\tB/);
  const x = await media.extractDocument(Buffer.from(xlsxFile), "application/octet-stream", "b.xlsx");
  assert.ok("text" in x);
  assert.equal(x.text, "--- Sheet: Budget ---\nItem\tCost\nCoffee & tea\t\t4.5");
  const p = await media.extractDocument(Buffer.from(pptxFile), "application/octet-stream", "s.pptx");
  assert.ok("text" in p);
  assert.match(p.text, /Slide 1 ---\nWelcome\nAgenda\n\n--- Slide 2 ---\nNumbers/);
});

test("text and code files are read; binary, archives and old Office formats are refused politely", async () => {
  const t = await media.extractDocument(Buffer.from("a,b\n1,2\n"), "text/csv", "d.csv");
  assert.ok("text" in t && t.text.startsWith("a,b"));
  const c = await media.extractDocument(Buffer.from("print('hi')"), "application/octet-stream", "x.py");
  assert.ok("text" in c);
  const bin = await media.extractDocument(Buffer.from([0, 1, 2, 3, 0, 0, 255]), "application/octet-stream", "x.dat");
  assert.ok("unreadable" in bin);
  assert.match(((await media.extractDocument(Buffer.from("PK"), "application/zip", "a.zip")) as any).unreadable, /archive/);
  assert.match(((await media.extractDocument(Buffer.from("x"), "application/msword", "old.doc")) as any).unreadable, /\.docx or PDF/);
  assert.match(((await media.extractDocument(Buffer.from("not a pdf"), "application/pdf", "bad.pdf")) as any).unreadable, /couldn't read/);
});

test("ingest: image goes to the vision model; without vision or Gemini it is refused", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
  const ok = await media.ingest({ kind: "image", mime: "image/png", caption: "what colour?" }, async () => png);
  assert.equal(ok.images.length, 1);
  assert.equal(ok.images[0]!.mime, "image/png");
  assert.match(ok.prompt, /Image attached, id a[0-9a-f]{6}.*what colour\?/s);
  assert.match(ok.historyText, /Image sent, id a[0-9a-f]{6}\] what colour\?/);
  const sticker = await media.ingest({ kind: "sticker", mime: "image/webp" }, async () => png);
  assert.match(sticker.prompt, /Sticker attached/);
  config.llm.vision = false;
  const no = await media.ingest({ kind: "image", mime: "image/png" }, async () => png);
  assert.match(no.refusal ?? "", /can't look at images/);
  config.llm.vision = true;
});

test("ingest: voice notes and videos explain what is missing when there is no Gemini key", async () => {
  const a = await media.ingest({ kind: "audio", mime: "audio/ogg", voiceNote: true }, async () => Buffer.alloc(1));
  assert.match(a.refusal ?? "", /GEMINI_API_KEY/);
  const v = await media.ingest({ kind: "video", mime: "video/mp4" }, async () => Buffer.alloc(1));
  assert.match(v.refusal ?? "", /GEMINI_API_KEY/);
});

test("ingest: documents become prompt text, long ones are truncated with a way to read on", async () => {
  const short = await media.ingest({ kind: "document", mime: "application/pdf", fileName: "inv.pdf", caption: "total?" }, async () => pdf(["Total: 99"]));
  assert.match(short.prompt, /File "inv\.pdf" attached: PDF, 1 page/);
  assert.match(short.prompt, /Total: 99/);
  assert.match(short.prompt, /total\?/);
  const long = "line of text\n".repeat(5000);
  const big = await media.ingest({ kind: "document", mime: "text/plain", fileName: "big.txt" }, async () => Buffer.from(long));
  assert.match(big.prompt, /truncated: \d+ characters in total/);
  assert.ok(big.historyText.length < 1500);
  const id = /id (a[0-9a-f]{6})/.exec(big.prompt)![1]!;
  const tools = attachmentTools({ complete: async () => ({ content: "x", toolCalls: [] }) });
  const read = tools.find((t) => t.name === "read_attachment")!;
  const part = await read.run({ id, offset: 30_000, length: 500 }, { confirm: async () => true });
  assert.match(part, /continue with offset 30500/);
  assert.ok(existsSync(path.join(config.mediaDir, `${id}.txt`)));
  await assert.rejects(() => read.run({ id: "../../etc/passwd" }, { confirm: async () => true }), /No extracted text/);
});

test("ingest: location and contact are passed as text; a photo sent as a file is still a photo", async () => {
  const loc = await media.ingest({ kind: "location", mime: "text/plain", inline: "Shared location: Cafe (1.3, 103.8)" }, async () => Buffer.alloc(0));
  assert.match(loc.prompt, /Cafe/);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
  const asDoc = await media.ingest({ kind: "document", mime: "image/png", fileName: "scan.png" }, async () => png);
  assert.equal(asDoc.images.length, 1);
});
