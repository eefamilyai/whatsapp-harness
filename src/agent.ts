import { config } from "./config.js";
import { log } from "./log.js";
import type { ChatMessage, ContentPart, Llm } from "./llm.js";
import type { ImageInput } from "./media.js";
import * as notes from "./notes.js";
import { JsonStore } from "./store.js";
import { formatWhen } from "./time.js";
import { spec, type Tool, type ToolContext } from "./tools/types.js";

interface History {
  messages: { role: "user" | "assistant"; content: string; reasoning?: string }[];
}

const MAX_HISTORY = 30; // messages kept between turns
const MAX_STEPS = 12; // tool-call rounds per turn

const history = new JsonStore<History>("history.json", () => ({ messages: [] }));

export function resetHistory(): void {
  history.data.messages = [];
  history.save();
}

export function systemPrompt(now = Date.now()): string {
  const mem = notes.all();
  return `You are the user's personal assistant, living inside WhatsApp. You talk to exactly one person: your owner, in their own chat.

Current date and time: ${formatWhen(now, config.timezone)} (${config.timezone}).
Host: ${process.platform}; the shell tool runs ${process.platform === "win32" ? "PowerShell" : "bash"}.

Style:
- This is a chat on a phone. Be concise and direct; no preamble, no sign-off. Short paragraphs.
- WhatsApp formatting only: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`, "- " bullets. Never use Markdown headings, tables or **double asterisks**.
- Reply in the language the user writes in.

How to work:
- Use tools whenever they help; do not guess at things you can look up or compute. For current events, prices, weather, news, or anything after your training data, use web_search (and web_fetch to read a page).
- Times: the user speaks in ${config.timezone} local time. Convert phrases like "tomorrow 8am" or "in 2 hours" yourself using the current time above, and pass local ISO times like 2026-11-14T08:00 (no offset) or use in_minutes.
- Reminders vs alarms: set_reminder sends one message at the time. set_alarm keeps re-pinging until the user replies "stop" (use it for wake-ups and things that must not be missed). schedule_task runs an instruction of yours at a time (e.g. "every weekday 8:00 summarise my calendar and the weather") and sends the result.
- After scheduling anything, confirm back with the exact local time you set.
- Calendar events are in Google Calendar (calendar_* tools). If a time is ambiguous (am/pm, which day), ask one short question instead of guessing.
- Attachments: the user can send images, stickers, PDFs, Word/Excel/PowerPoint and text files, voice notes and videos. Images arrive as pictures; documents arrive as extracted text; voice notes are already transcribed (treat them as the user's message); videos arrive as a description. Each has an id: use read_attachment to read more of a long document, analyze_attachment to look again at an image, video or audio with a specific question. Files are kept on the host for 14 days.
- The shell tool runs real commands on the machine the bot lives on. Prefer read-only commands; never run destructive commands unless explicitly asked. Depending on the owner's setting the user is asked to approve each command, so state clearly what it does.
- If a tool fails, say what failed in a sentence and what you will try or what the user needs to do. Never claim to have done something a tool did not confirm.
- Use remember for durable facts or preferences the user tells you ("my gym is at ...", "I prefer 24h time"); do not store secrets.
- Chat commands exist (/help, /model, /shell, /timezone, ...). If the user asks to change those settings, tell them the command rather than pretending to do it yourself.
${
  mem.length
    ? `\nWhat you remember about the user:\n${mem.map((n) => `- [${n.id}] ${n.text}`).join("\n")}\n`
    : ""
}`;
}

export interface ReplyOptions {
  persist?: boolean;
  /** Images to show the model this turn (not kept in history; their ids are in the text). */
  images?: ImageInput[];
  /** What to remember of this user message afterwards (defaults to the message itself). */
  historyText?: string;
}

export class Agent {
  constructor(
    private readonly llm: Llm,
    private readonly tools: Tool[],
  ) {}

  /** Run one conversational turn and return the text to send back. */
  async reply(userText: string, ctx: ToolContext, opts: ReplyOptions = {}): Promise<string> {
    const persist = opts.persist !== false;
    const thinking = !!config.llm.thinking && config.llm.thinking !== "off";
    const hist: ChatMessage[] = history.data.messages.map((m) =>
      m.role === "assistant" && thinking && m.reasoning ? { role: "assistant", content: m.content, reasoning_content: m.reasoning } : { role: m.role, content: m.content },
    );
    const userMessage = (withImages: boolean): ChatMessage => {
      if (!withImages || !opts.images?.length) return { role: "user", content: userText };
      const parts: ContentPart[] = [{ type: "text", text: userText }];
      for (const im of opts.images) parts.push({ type: "image_url", image_url: { url: `data:${im.mime};base64,${im.base64}` } });
      return { role: "user", content: parts };
    };
    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt() }, ...hist, userMessage(true)];
    const specs = this.tools.map(spec);
    let answer = "";
    let finalReasoning: string | undefined;
    let strippedImages = false;

    for (let step = 0; step < MAX_STEPS; step++) {
      let out;
      try {
        out = await this.llm.complete(messages, specs);
      } catch (err) {
        // The model refused the picture (unsupported format/size): carry on with the text alone.
        if (opts.images?.length && !strippedImages && /HTTP 4\d\d/.test((err as Error).message) && !/HTTP 4(01|02|29)/.test((err as Error).message)) {
          log.warn(`model rejected the image (${(err as Error).message}); retrying without it`);
          strippedImages = true;
          messages[messages.findLastIndex((m) => m.role === "user")] = {
            role: "user",
            content: `${userText}\n\n(The image itself could not be processed by the model, so you cannot see it. Say so.)`,
          };
          step--;
          continue;
        }
        throw err;
      }
      if (!out.toolCalls.length) {
        answer = (out.content ?? "").trim();
        finalReasoning = out.reasoning;
        break;
      }
      messages.push({ role: "assistant", content: out.content, tool_calls: out.toolCalls, ...(out.reasoning ? { reasoning_content: out.reasoning } : {}) });
      for (const call of out.toolCalls) {
        const result = await this.runTool(call.function.name, call.function.arguments, ctx);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      if (step === MAX_STEPS - 1) {
        answer = "I ran out of steps before finishing. Ask me to continue, or break it into smaller parts.";
      }
    }
    if (!answer) answer = "(no reply)";

    if (persist) {
      history.data.messages.push(
        { role: "user", content: opts.historyText ?? userText },
        { role: "assistant", content: answer, ...(thinking && finalReasoning ? { reasoning: finalReasoning } : {}) },
      );
      if (history.data.messages.length > MAX_HISTORY) {
        history.data.messages = history.data.messages.slice(-MAX_HISTORY);
        // Never start the window on an assistant message.
        while (history.data.messages[0]?.role === "assistant") history.data.messages.shift();
      }
      history.save();
    }
    return answer;
  }

  private async runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return `Error: unknown tool "${name}".`;
    let args: Record<string, unknown>;
    try {
      args = rawArgs?.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("arguments must be an object");
    } catch (err) {
      return `Error: could not parse arguments for ${name}: ${(err as Error).message}`;
    }
    const started = Date.now();
    try {
      const result = await tool.run(args, ctx);
      log.info(`tool ${name} ok (${Date.now() - started}ms)`);
      return result;
    } catch (err) {
      log.warn(`tool ${name} failed`, err as Error);
      return `Error: ${(err as Error).message}`;
    }
  }
}
