import * as notes from "../notes.js";
import { num, str, type Tool } from "./types.js";

export const remember: Tool = {
  name: "remember",
  description: "Save a short durable fact or preference about the user. It is shown to you in every future conversation.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  async run(args) {
    const text = str(args.text);
    if (!text) throw new Error("text is required");
    return `Saved as note ${notes.add(text.slice(0, 400))}.`;
  },
};

export const forget: Tool = {
  name: "forget",
  description: "Delete a remembered note by its id.",
  parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  async run(args) {
    const id = num(args.id);
    if (id === undefined) throw new Error("id is required");
    return notes.remove(id) ? `Deleted note ${id}.` : `No note ${id}.`;
  },
};
