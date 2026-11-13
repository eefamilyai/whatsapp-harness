import fs from "node:fs";
import { resetHistory } from "./agent.js";
import { config } from "./config.js";
import * as google from "./google.js";
import * as notes from "./notes.js";
import * as rem from "./reminders.js";
import { overridden, resetSettings, setSetting, SettingError } from "./settings.js";
import { formatWhen } from "./time.js";

const version = (() => {
  try {
    return (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "?";
  }
})();

interface Command {
  name: string;
  usage: string;
  summary: string;
  detail?: string;
  run(args: string): string;
}

const val = (s: string) => `*${s}*`;

function change(key: string, args: string, show: () => string, ok: (v: string) => string): string {
  if (!args.trim()) return show();
  try {
    setSetting(key, args);
    return ok(args.trim());
  } catch (err) {
    if (err instanceof SettingError) return `⚠️ ${err.message}`;
    throw err;
  }
}

const COMMANDS: Command[] = [
  {
    name: "help",
    usage: "/help [command]",
    summary: "this list, or details of one command",
    run: (a) => {
      const q = a.trim().replace(/^\//, "").toLowerCase();
      if (q) {
        const c = COMMANDS.find((x) => x.name === q);
        return c ? `${val(c.usage)}\n${c.summary}${c.detail ? `\n\n${c.detail}` : ""}` : `No command /${q}. Try /help.`;
      }
      return [
        "*Commands*",
        ...COMMANDS.map((c) => `${c.usage} - ${c.summary}`),
        "",
        "While an alarm rings: *stop* or *snooze 10*.",
        "Anything else is a normal message to the assistant. You can also send photos, stickers, PDFs, Word/Excel/PowerPoint, text files, voice notes and videos (voice and video need a GEMINI_API_KEY).",
      ].join("\n");
    },
  },
  {
    name: "status",
    usage: "/status",
    summary: "what's running and how it's set up",
    run: () => {
      const items = rem.list();
      return [
        `*Status* (v${version})`,
        `Model: ${config.llm.model}, thinking: ${config.llm.thinking || "provider default"}, vision: ${config.llm.vision ? "on" : "off"}`,
        `Time: ${formatWhen(Date.now(), config.timezone)} (${config.timezone})`,
        `Scheduled: ${items.length}  |  Notes: ${notes.all().length}`,
        `Shell: ${config.shell.mode}`,
        `Google Calendar: ${google.isConfigured() ? "connected" : "not connected"}`,
        `Voice/video (Gemini): ${config.gemini.apiKey ? "on" : "off"}`,
        `Host: ${process.platform}, node ${process.version}, up ${Math.round(process.uptime() / 60)} min`,
      ].join("\n");
    },
  },
  {
    name: "settings",
    usage: "/settings [reset]",
    summary: "show settings you can change; 'reset' restores the .env values",
    run: (a) => {
      if (a.trim().toLowerCase() === "reset") {
        resetSettings();
        return "All settings are back to the values in .env.";
      }
      const o = new Set(overridden());
      const mark = (k: string) => (o.has(k) ? " (changed)" : "");
      return [
        "*Settings*",
        `/model: ${config.llm.model}${mark("model")}`,
        `/thinking: ${config.llm.thinking || "provider default"}${mark("thinking")}`,
        `/shell: ${config.shell.mode}${mark("shell")}`,
        `/timezone: ${config.timezone}${mark("timezone")}`,
        `/vision: ${config.llm.vision ? "on" : "off"}${mark("vision")}`,
        `/alarm: re-ping every ${config.alarm.repeatSeconds}s, up to ${config.alarm.maxPings} times${mark("alarmRepeat")}${mark("alarmPings")}`,
        "",
        "The API key and WhatsApp number are not changeable from chat, on purpose.",
      ].join("\n");
    },
  },
  {
    name: "model",
    usage: "/model [id]",
    summary: "show or change the chat model",
    detail: "Examples: /model deepseek-flash, /model deepseek-v4-pro (stronger, no image input). Applies from the next message.",
    run: (a) => change("model", a, () => `Model: ${val(config.llm.model)}`, (v) => `Model is now ${val(v)}.${/pro/i.test(v) ? " Note: that model can't read images." : ""}`),
  },
  {
    name: "thinking",
    usage: "/thinking [off|low|high|max|default]",
    summary: "DeepSeek reasoning effort",
    detail: "off = fastest and cheapest (default). high/max = slower, better on hard problems.",
    run: (a) => change("thinking", a, () => `Thinking: ${val(config.llm.thinking || "provider default")}`, (v) => `Thinking is now ${val(v.toLowerCase())}.`),
  },
  {
    name: "shell",
    usage: "/shell [confirm|auto|off]",
    summary: "whether the assistant may run commands on the host",
    detail: "confirm = I ask you yes/no before every command (default). auto = run without asking. off = never.",
    run: (a) =>
      change("shell", a, () => `Shell: ${val(config.shell.mode)}`, (v) =>
        v.toLowerCase() === "auto"
          ? "Shell is now *auto*: commands run WITHOUT asking you. Switch back with /shell confirm."
          : `Shell is now ${val(v.toLowerCase())}.`,
      ),
  },
  {
    name: "timezone",
    usage: "/timezone [Area/City]",
    summary: "time zone used for reminders, alarms and the calendar",
    run: (a) => change("timezone", a, () => `Time zone: ${val(config.timezone)} (now ${formatWhen(Date.now(), config.timezone)})`, () => `Time zone is now ${val(config.timezone)}; it is ${formatWhen(Date.now(), config.timezone)}. Existing reminders keep their absolute time.`),
  },
  {
    name: "vision",
    usage: "/vision [on|off]",
    summary: "send images to the chat model",
    run: (a) => change("vision", a, () => `Vision: ${val(config.llm.vision ? "on" : "off")}`, (v) => `Vision is now ${val(v.toLowerCase())}.`),
  },
  {
    name: "alarm",
    usage: "/alarm [repeat <seconds> | pings <count>]",
    summary: "how persistently an unanswered alarm rings",
    run: (a) => {
      const m = /^(repeat|pings)\s+(\S+)$/i.exec(a.trim());
      if (!a.trim()) return `Alarms re-ping every ${val(`${config.alarm.repeatSeconds}s`)}, up to ${val(String(config.alarm.maxPings))} times.`;
      if (!m) return "Use: /alarm repeat 30   or   /alarm pings 5";
      const which = m[1]!.toLowerCase();
      return change(which === "repeat" ? "alarmRepeat" : "alarmPings", m[2]!, () => "", (v) => (which === "repeat" ? `Alarms now re-ping every ${val(`${v}s`)}.` : `Alarms now ring up to ${val(v)} times.`));
    },
  },
  {
    name: "reminders",
    usage: "/reminders",
    summary: "list reminders, alarms and scheduled tasks",
    run: () => {
      const items = rem.list();
      return items.length ? items.map((r) => `${r.id} [${r.kind}] ${formatWhen(r.dueAt, config.timezone)} (${rem.describeRepeat(r.repeat)}): ${r.text}`).join("\n") : "Nothing scheduled.";
    },
  },
  {
    name: "cancel",
    usage: "/cancel <id>",
    summary: "delete a reminder/alarm/task (ids from /reminders)",
    run: (a) => {
      if (!a.trim()) return "Use: /cancel <id>  (see /reminders)";
      const r = rem.remove(a.trim());
      return r ? `Cancelled ${r.kind} ${r.id}: ${r.text}` : `No item with id ${a.trim()}.`;
    },
  },
  {
    name: "notes",
    usage: "/notes",
    summary: "what I remember about you",
    run: () => (notes.all().length ? notes.all().map((n) => `${n.id}. ${n.text}`).join("\n") : "I have no notes about you yet. Tell me something to remember."),
  },
  {
    name: "forget",
    usage: "/forget <note number>",
    summary: "delete one remembered note",
    run: (a) => {
      const id = Number(a.trim());
      if (!Number.isInteger(id)) return "Use: /forget <number>  (see /notes)";
      return notes.remove(id) ? `Forgot note ${id}.` : `No note ${id}.`;
    },
  },
  {
    name: "reset",
    usage: "/reset",
    summary: "clear this conversation (reminders, notes and settings are kept)",
    run: () => {
      resetHistory();
      return "Conversation cleared.";
    },
  },
];

/**
 * Run a slash command. Returns the reply, or undefined when the text is not a command
 * (so it goes to the assistant; e.g. a pasted path like /usr/bin/x).
 */
export function runCommand(text: string): string | undefined {
  const t = text.trim();
  if (/^help$/i.test(t)) return COMMANDS[0]!.run("");
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(t);
  if (!m) return undefined;
  const cmd = COMMANDS.find((c) => c.name === m[1]!.toLowerCase());
  if (!cmd) return `Unknown command /${m[1]}. Send /help to see what I know.`;
  try {
    return cmd.run(m[2] ?? "");
  } catch (err) {
    return `⚠️ /${cmd.name} failed: ${(err as Error).message}`;
  }
}

export const commandNames = (): string[] => COMMANDS.map((c) => c.name);
