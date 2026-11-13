import type { ToolSpec } from "../llm.js";

export interface ToolContext {
  /** Ask the owner a yes/no question over WhatsApp and wait for the answer. */
  confirm(question: string): Promise<boolean>;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export const spec = (t: Tool): ToolSpec => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.parameters },
});

export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
export const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}
