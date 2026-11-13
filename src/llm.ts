import { config } from "./config.js";
import { log } from "./log.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Completion {
  content: string | null;
  /** DeepSeek thinking mode: must be sent back on the assistant message in later requests that carry tools. */
  reasoning?: string;
  toolCalls: ToolCall[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface Llm {
  complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<Completion>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal OpenAI-compatible chat-completions client (DeepSeek, OpenAI, OpenRouter, Ollama, ...). */
export class OpenAiCompatLlm implements Llm {
  /** Explicit values win (used by tests); otherwise settings are read per call so /model takes effect at once. */
  constructor(
    private readonly baseUrlOverride?: string,
    private readonly apiKeyOverride?: string,
    private readonly modelOverride?: string,
  ) {}
  private get baseUrl() {
    return this.baseUrlOverride ?? config.llm.baseUrl;
  }
  private get apiKey() {
    return this.apiKeyOverride ?? config.llm.apiKey;
  }
  private get model() {
    return this.modelOverride ?? config.llm.model;
  }

  async complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<Completion> {
    const body = JSON.stringify({
      model: this.model,
      messages,
      ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      ...(config.llm.thinking === "off"
        ? { thinking: { type: "disabled" }, temperature: 0.3 }
        : config.llm.thinking
          ? { thinking: { type: "enabled" }, reasoning_effort: config.llm.thinking }
          : { temperature: 0.3 }),
    });
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(1500 * 2 ** (attempt - 1));
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body,
          signal: AbortSignal.timeout(180_000),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
          log.warn(`llm: ${String(lastErr)}; retrying`);
          continue;
        }
        if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
        const json = (await res.json()) as {
          choices?: { message?: { content?: string | null; tool_calls?: ToolCall[]; reasoning_content?: string | null } }[];
          usage?: Completion["usage"];
        };
        const msg = json.choices?.[0]?.message;
        if (!msg) throw new Error("LLM returned no message");
        return { content: msg.content ?? null, reasoning: msg.reasoning_content ?? undefined, toolCalls: msg.tool_calls ?? [], usage: json.usage };
      } catch (err) {
        // 4xx other than 429 is not worth retrying.
        if (err instanceof Error && /^LLM HTTP 4\d\d/.test(err.message) && !/HTTP 429/.test(err.message)) throw err;
        lastErr = err;
        log.warn(`llm: attempt ${attempt + 1} failed: ${(err as Error).message}`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
