import fs from "node:fs";
import { geminiAnalyze, geminiEnabled } from "../gemini.js";
import { config } from "../config.js";
import type { Llm } from "../llm.js";
import { findAttachment, MIME_BY_EXT, readAttachmentText } from "../media.js";
import { clip, num, str, type Tool } from "./types.js";

export function attachmentTools(llm: Llm): Tool[] {
  const readAttachment: Tool = {
    name: "read_attachment",
    description:
      "Read more of the extracted text of a file the user sent earlier (PDF, Word, Excel, text...), by its attachment id, starting at a character offset. Use when the text in the chat was truncated.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Attachment id like a1b2c3" },
        offset: { type: "integer", description: "Start character, default 0" },
        length: { type: "integer", description: "Characters to return, default 20000, max 30000" },
      },
      required: ["id"],
    },
    async run(args) {
      const id = str(args.id);
      if (!id) throw new Error("id is required");
      const text = readAttachmentText(id);
      if (text === undefined) throw new Error(`No extracted text for ${id} (expired, or not a text document).`);
      const offset = Math.max(0, Math.round(num(args.offset) ?? 0));
      const length = Math.min(30_000, Math.max(100, Math.round(num(args.length) ?? 20_000)));
      const part = text.slice(offset, offset + length);
      const end = offset + part.length;
      return `${part}${end < text.length ? `\n…[characters ${offset}-${end} of ${text.length}; continue with offset ${end}]` : "\n[end]"}`;
    },
  };

  const analyzeAttachment: Tool = {
    name: "analyze_attachment",
    description:
      "Look again at an image, video, audio or PDF the user sent earlier (by attachment id) and answer a specific question about it, e.g. read a particular number, or describe a region.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, question: { type: "string" } },
      required: ["id", "question"],
    },
    async run(args) {
      const id = str(args.id);
      const question = str(args.question);
      if (!id || !question) throw new Error("id and question are required");
      const att = findAttachment(id);
      if (!att) throw new Error(`No attachment ${id} (they are kept for 14 days).`);
      const mime = MIME_BY_EXT[att.ext] ?? "application/octet-stream";
      const data = fs.readFileSync(att.file);
      if (mime.startsWith("image/") && config.llm.vision) {
        const out = await llm.complete(
          [{ role: "user", content: [{ type: "text", text: question }, { type: "image_url", image_url: { url: `data:${mime};base64,${data.toString("base64")}` } }] }],
          [],
        );
        return clip(out.content ?? "(no answer)", 6000);
      }
      if (!geminiEnabled()) throw new Error("This needs a vision/video model; set GEMINI_API_KEY.");
      return clip(await geminiAnalyze(mime, data, question), 6000);
    },
  };
  return [readAttachment, analyzeAttachment];
}
