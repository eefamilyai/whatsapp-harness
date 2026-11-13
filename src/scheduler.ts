import { config } from "./config.js";
import { log } from "./log.js";
import * as rem from "./reminders.js";
import { humanDuration } from "./time.js";

export interface SchedulerHooks {
  /** True when the WhatsApp socket can send right now. */
  online(): boolean;
  /** Send a text to the owner. Must throw if it could not be sent. */
  send(text: string): Promise<void>;
  /** Run an agent prompt and send the answer. Must throw on failure. */
  runTask(prompt: string): Promise<void>;
}

const TICK_MS = 5_000;

/** Fires reminders, alarms and scheduled agent tasks. State lives in reminders.json. */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly hooks: SchedulerHooks) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposed for tests. */
  async tick(now = Date.now()): Promise<void> {
    if (this.busy || !this.hooks.online()) return;
    this.busy = true;
    try {
      for (const r of [...rem.store.data.items]) {
        try {
          await this.step(r, now);
        } catch (err) {
          log.warn(`scheduler: ${r.kind} ${r.id} failed, will retry`, err as Error);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async step(r: rem.Reminder, now: number): Promise<void> {
    // 1. Alarm that is already ringing: re-ping until dismissed or out of pings.
    if (r.ringing) {
      if (now < r.ringing.nextPingAt) return;
      if (r.ringing.pings >= config.alarm.maxPings) {
        await this.hooks.send(`⏰ Alarm "${r.text}" was never dismissed, so I stopped ringing.`);
        rem.dismissRinging(r);
        return;
      }
      r.ringing.pings += 1;
      r.ringing.nextPingAt = now + config.alarm.repeatSeconds * 1000;
      rem.store.save();
      await this.hooks.send(`⏰ ALARM (${r.ringing.pings}/${config.alarm.maxPings}): ${r.text}\n\nReply *stop* to dismiss, or *snooze 10* to snooze.`);
      return;
    }

    // 2. Not due yet.
    if (now < r.dueAt) return;

    const late = now - r.dueAt;
    const lateNote = late > 90_000 ? ` _(${humanDuration(late)} late: I was offline)_` : "";

    if (r.kind === "task") {
      advance(r, now);
      // Run after advancing so a crash never makes a task fire twice.
      await this.hooks.runTask(r.text);
      return;
    }

    if (r.kind === "reminder") {
      await this.hooks.send(`⏰ Reminder: ${r.text}${lateNote}`);
      advance(r, now);
      return;
    }

    // Alarm: first ping. It keeps ringing until dismissed.
    await this.hooks.send(`⏰ ALARM: ${r.text}${lateNote}\n\nReply *stop* to dismiss, or *snooze 10* to snooze.`);
    r.ringing = { pings: 1, nextPingAt: now + config.alarm.repeatSeconds * 1000 };
    rem.store.save();
  }
}

/** Move a fired item to its next occurrence, or delete it if it was one-shot. */
function advance(r: rem.Reminder, now: number): void {
  const next = rem.nextOccurrence(r.dueAt, r.repeat, now);
  if (next === undefined) {
    const i = rem.store.data.items.indexOf(r);
    if (i >= 0) rem.store.data.items.splice(i, 1);
  } else {
    r.dueAt = next;
  }
  rem.store.save();
}
