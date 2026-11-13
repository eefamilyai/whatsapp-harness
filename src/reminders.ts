import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { JsonStore } from "./store.js";
import { addLocal, weekdayIndex } from "./time.js";

export type Kind = "reminder" | "alarm" | "task";

/** How an item recurs. "none" fires once. */
export type Repeat =
  | { type: "none" }
  | { type: "daily" }
  | { type: "weekdays" }
  | { type: "weekly" }
  | { type: "monthly" }
  | { type: "interval"; everyMinutes: number };

export interface Reminder {
  id: string;
  kind: Kind;
  /** reminder/alarm: the message. task: the instruction the agent runs when it fires. */
  text: string;
  /** Next fire time, epoch ms. */
  dueAt: number;
  repeat: Repeat;
  createdAt: number;
  /** Alarm only: set once it has started ringing, until the user dismisses it. */
  ringing?: { pings: number; nextPingAt: number };
  /** Set when the item was missed because the bot was offline. */
  lateByMs?: number;
}

interface Db {
  items: Reminder[];
}

export const store = new JsonStore<Db>("reminders.json", () => ({ items: [] }));

const newId = () => randomBytes(3).toString("hex");

export function add(input: { kind: Kind; text: string; dueAt: number; repeat?: Repeat }): Reminder {
  const r: Reminder = {
    id: newId(),
    kind: input.kind,
    text: input.text,
    dueAt: input.dueAt,
    repeat: input.repeat ?? { type: "none" },
    createdAt: Date.now(),
  };
  store.data.items.push(r);
  store.save();
  return r;
}

export function list(): Reminder[] {
  return [...store.data.items].sort((a, b) => a.dueAt - b.dueAt);
}

export function remove(id: string): Reminder | undefined {
  const i = store.data.items.findIndex((r) => r.id === id.trim().toLowerCase());
  if (i < 0) return undefined;
  const [r] = store.data.items.splice(i, 1);
  store.save();
  return r;
}

export function update(id: string, patch: Partial<Pick<Reminder, "text" | "dueAt" | "repeat">>): Reminder | undefined {
  const r = store.data.items.find((x) => x.id === id.trim().toLowerCase());
  if (!r) return undefined;
  if (patch.text !== undefined) r.text = patch.text;
  if (patch.dueAt !== undefined) {
    r.dueAt = patch.dueAt;
    delete r.ringing;
    delete r.lateByMs;
  }
  if (patch.repeat !== undefined) r.repeat = patch.repeat;
  store.save();
  return r;
}

export function ringing(): Reminder[] {
  return store.data.items.filter((r) => r.ringing);
}

/** Next occurrence strictly after `after`, or undefined for one-shot items. */
export function nextOccurrence(dueAt: number, repeat: Repeat, after: number, tz = config.timezone): number | undefined {
  const step = (from: number): number | undefined => {
    switch (repeat.type) {
      case "none":
        return undefined;
      case "daily":
        return addLocal(from, tz, { days: 1 });
      case "weekly":
        return addLocal(from, tz, { days: 7 });
      case "monthly":
        return addLocal(from, tz, { months: 1 });
      case "weekdays": {
        let n = addLocal(from, tz, { days: 1 });
        for (let i = 0; i < 7; i++) {
          const wd = weekdayIndex(n, tz);
          if (wd !== 0 && wd !== 6) break;
          n = addLocal(n, tz, { days: 1 });
        }
        return n;
      }
      case "interval":
        return from + Math.max(1, repeat.everyMinutes) * 60_000;
    }
  };
  let n = step(dueAt);
  // Skip occurrences already in the past (bot was offline for a while).
  let guard = 0;
  while (n !== undefined && n <= after && guard++ < 5000) n = step(n);
  return n;
}

export function describeRepeat(r: Repeat): string {
  switch (r.type) {
    case "none":
      return "once";
    case "interval":
      return `every ${r.everyMinutes} min`;
    default:
      return r.type;
  }
}

/** Dismiss every ringing alarm. Returns what was dismissed. */
export function dismissRinging(only?: Reminder): Reminder[] {
  const done: Reminder[] = [];
  const now = Date.now();
  for (const r of only ? [only] : ringing()) {
    done.push({ ...r });
    delete r.ringing;
    const next = nextOccurrence(r.dueAt, r.repeat, now);
    if (next === undefined) store.data.items.splice(store.data.items.indexOf(r), 1);
    else r.dueAt = next;
  }
  if (done.length) store.save();
  return done;
}

/** Snooze every ringing alarm by N minutes (it rings again then). */
export function snoozeRinging(minutes: number): Reminder[] {
  const out: Reminder[] = [];
  const now = Date.now();
  for (const r of ringing()) {
    delete r.ringing;
    // Keep the series: put the snoozed ring in a one-shot copy and advance the original.
    const next = nextOccurrence(r.dueAt, r.repeat, now);
    if (next === undefined) {
      r.dueAt = now + minutes * 60_000;
      r.repeat = { type: "none" };
      out.push(r);
    } else {
      r.dueAt = next;
      const copy = add({ kind: "alarm", text: r.text, dueAt: now + minutes * 60_000 });
      out.push(copy);
    }
  }
  if (out.length) store.save();
  return out;
}
