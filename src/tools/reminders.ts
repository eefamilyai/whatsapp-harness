import { config } from "../config.js";
import * as rem from "../reminders.js";
import { formatWhen, humanDuration, parseWhen } from "../time.js";
import { num, str, type Tool } from "./types.js";

const repeatSchema = {
  repeat: {
    type: "string",
    enum: ["none", "daily", "weekdays", "weekly", "monthly", "interval"],
    description: "Recurrence, default none. 'interval' needs every_minutes.",
  },
  every_minutes: { type: "integer", description: "For repeat=interval: minutes between occurrences." },
};

const whenSchema = {
  at: { type: "string", description: "Local date-time in the user's time zone, e.g. 2026-11-14T08:00. No offset." },
  in_minutes: { type: "number", description: "Alternative to `at`: fire this many minutes from now." },
};

function parseRepeat(args: Record<string, unknown>): rem.Repeat {
  const t = str(args.repeat) ?? "none";
  if (t === "interval") {
    const m = num(args.every_minutes);
    if (!m || m < 1) throw new Error("repeat=interval needs every_minutes >= 1");
    return { type: "interval", everyMinutes: Math.round(m) };
  }
  if (t === "none" || t === "daily" || t === "weekdays" || t === "weekly" || t === "monthly") return { type: t };
  throw new Error(`Unknown repeat "${t}"`);
}

function parseDue(args: Record<string, unknown>): number {
  const inMin = num(args.in_minutes);
  const at = str(args.at);
  let due: number | undefined;
  if (inMin !== undefined) due = Date.now() + Math.round(inMin * 60_000);
  else if (at) {
    due = parseWhen(at, config.timezone);
    if (due === undefined) throw new Error(`Could not read time "${at}". Use e.g. 2026-11-14T08:00.`);
  } else throw new Error("Give either `at` or `in_minutes`.");
  if (due < Date.now() - 30_000) {
    throw new Error(`That time (${formatWhen(due, config.timezone)}) is in the past. Check the date.`);
  }
  return Math.max(due, Date.now() + 1000);
}

function create(kind: rem.Kind, name: string, description: string, textDesc: string): Tool {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: textDesc }, ...whenSchema, ...repeatSchema },
      required: ["text"],
    },
    async run(args) {
      const text = str(args.text);
      if (!text) throw new Error("text is required");
      const repeat = parseRepeat(args);
      const dueAt = parseDue(args);
      const r = rem.add({ kind, text, dueAt, repeat });
      return `Created ${kind} ${r.id}: "${text}" at ${formatWhen(dueAt, config.timezone)} (in ${humanDuration(dueAt - Date.now())}), repeats: ${rem.describeRepeat(repeat)}.`;
    },
  };
}

export const setReminder = create(
  "reminder",
  "set_reminder",
  "Send the user a WhatsApp message with this text at a given time (one-off or recurring).",
  "What to remind them of, phrased as the message they will read.",
);
export const setAlarm = create(
  "alarm",
  "set_alarm",
  "Set an alarm: at the time, the user is pinged repeatedly until they reply 'stop'. Use for wake-ups and must-not-miss things.",
  "Alarm label.",
);
export const scheduleTask = create(
  "task",
  "schedule_task",
  "Schedule an instruction for yourself. At the time you run it (with all tools) and send the user the result. E.g. 'Give me a morning briefing: today's calendar and Singapore weather'.",
  "The full self-contained instruction to carry out when it fires.",
);

export const listReminders: Tool = {
  name: "list_reminders",
  description: "List all pending reminders, alarms and scheduled tasks with their ids.",
  parameters: { type: "object", properties: {} },
  async run() {
    const items = rem.list();
    if (!items.length) return "Nothing scheduled.";
    return items
      .map(
        (r) =>
          `${r.id} [${r.kind}] ${formatWhen(r.dueAt, config.timezone)} (${rem.describeRepeat(r.repeat)})${r.ringing ? " RINGING" : ""}: ${r.text}`,
      )
      .join("\n");
  },
};

export const cancelReminder: Tool = {
  name: "cancel_reminder",
  description: "Delete a reminder, alarm or scheduled task by id (see list_reminders).",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  async run(args) {
    const id = str(args.id);
    if (!id) throw new Error("id is required");
    const r = rem.remove(id);
    return r ? `Cancelled ${r.kind} ${r.id}: "${r.text}".` : `No item with id ${id}.`;
  },
};

export const updateReminder: Tool = {
  name: "update_reminder",
  description: "Change the text, time or recurrence of an existing reminder/alarm/task.",
  parameters: {
    type: "object",
    properties: { id: { type: "string" }, text: { type: "string" }, ...whenSchema, ...repeatSchema },
    required: ["id"],
  },
  async run(args) {
    const id = str(args.id);
    if (!id) throw new Error("id is required");
    const patch: Parameters<typeof rem.update>[1] = {};
    if (str(args.text)) patch.text = str(args.text)!;
    if (str(args.at) || num(args.in_minutes) !== undefined) patch.dueAt = parseDue(args);
    if (str(args.repeat)) patch.repeat = parseRepeat(args);
    const r = rem.update(id, patch);
    if (!r) return `No item with id ${id}.`;
    return `Updated ${r.kind} ${r.id}: "${r.text}" at ${formatWhen(r.dueAt, config.timezone)}, repeats: ${rem.describeRepeat(r.repeat)}.`;
  },
};
