import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "wah-"));
process.env.TIMEZONE = "Asia/Singapore";
process.env.ALARM_REPEAT_SECONDS = "60";
process.env.ALARM_MAX_PINGS = "3";

const rem = await import("../reminders.js");
const { Scheduler } = await import("../scheduler.js");
const { parseWhen } = await import("../time.js");

function harness() {
  const sent: string[] = [];
  const tasks: string[] = [];
  let online = true;
  const s = new Scheduler({
    online: () => online,
    send: async (t) => void sent.push(t),
    runTask: async (p) => void tasks.push(p),
  });
  return { s, sent, tasks, setOnline: (v: boolean) => (online = v) };
}
const reset = () => {
  rem.store.data.items.length = 0;
};

test("nextOccurrence: weekdays skip the weekend, monthly clamps, interval skips the past", () => {
  const fri = parseWhen("2026-11-13T08:00", "Asia/Singapore")!;
  const mon = rem.nextOccurrence(fri, { type: "weekdays" }, fri)!;
  assert.equal(new Date(mon).toISOString(), "2026-11-16T00:00:00.000Z");
  const jan31 = parseWhen("2026-01-31T08:00", "Asia/Singapore")!;
  assert.equal(new Date(rem.nextOccurrence(jan31, { type: "monthly" }, jan31)!).toISOString(), "2026-02-28T00:00:00.000Z");
  const t = 1_000_000;
  assert.equal(rem.nextOccurrence(t, { type: "interval", everyMinutes: 10 }, t + 25 * 60_000), t + 30 * 60_000);
  assert.equal(rem.nextOccurrence(t, { type: "none" }, t), undefined);
});

test("one-shot reminder fires once, is removed, and notes lateness", async () => {
  reset();
  const h = harness();
  const now = Date.now();
  rem.add({ kind: "reminder", text: "call mum", dueAt: now - 10 * 60_000 });
  rem.add({ kind: "reminder", text: "later", dueAt: now + 3_600_000 });
  await h.s.tick(now);
  await h.s.tick(now);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /Reminder: call mum.*late/);
  assert.equal(rem.list().length, 1);
});

test("nothing fires while offline; it fires after reconnect", async () => {
  reset();
  const h = harness();
  h.setOnline(false);
  rem.add({ kind: "reminder", text: "x", dueAt: Date.now() - 1000 });
  await h.s.tick();
  assert.equal(h.sent.length, 0);
  h.setOnline(true);
  await h.s.tick();
  assert.equal(h.sent.length, 1);
});

test("a recurring reminder moves to its next occurrence", async () => {
  reset();
  const h = harness();
  const now = Date.now();
  const r = rem.add({ kind: "reminder", text: "standup", dueAt: now - 1000, repeat: { type: "daily" } });
  await h.s.tick(now);
  assert.equal(h.sent.length, 1);
  assert.ok(rem.list()[0]!.dueAt > now && rem.list()[0]!.id === r.id);
});

test("alarm rings, re-pings, gives up, and can be dismissed or snoozed", async () => {
  reset();
  const h = harness();
  const t0 = Date.now();
  rem.add({ kind: "alarm", text: "wake up", dueAt: t0 - 1000 });
  await h.s.tick(t0);
  assert.equal(h.sent.length, 1);
  assert.equal(rem.ringing().length, 1);
  await h.s.tick(t0 + 30_000); // too soon
  assert.equal(h.sent.length, 1);
  await h.s.tick(t0 + 61_000);
  await h.s.tick(t0 + 122_000);
  assert.equal(h.sent.length, 3);
  await h.s.tick(t0 + 183_000); // pings exhausted
  assert.match(h.sent[3]!, /never dismissed/);
  assert.equal(rem.list().length, 0);

  rem.add({ kind: "alarm", text: "gym", dueAt: Date.now() - 1000 });
  await h.s.tick();
  const snoozed = rem.snoozeRinging(10);
  assert.equal(snoozed.length, 1);
  assert.equal(rem.ringing().length, 0);
  assert.ok(rem.list()[0]!.dueAt > Date.now() + 9 * 60_000);

  rem.list()[0]!.dueAt = Date.now() - 1;
  await h.s.tick();
  assert.equal(rem.dismissRinging().length, 1);
  assert.equal(rem.list().length, 0);
});

test("scheduled tasks hand their prompt to the agent runner exactly once", async () => {
  reset();
  const h = harness();
  rem.add({ kind: "task", text: "morning briefing", dueAt: Date.now() - 1 });
  await h.s.tick();
  await h.s.tick();
  assert.deepEqual(h.tasks, ["morning briefing"]);
  assert.equal(rem.list().length, 0);
});

test("a failed send is retried on the next tick (not lost)", async () => {
  reset();
  let fail = true;
  const sent: string[] = [];
  const s = new Scheduler({
    online: () => true,
    send: async (t) => {
      if (fail) throw new Error("boom");
      sent.push(t);
    },
    runTask: async () => undefined,
  });
  rem.add({ kind: "reminder", text: "keep me", dueAt: Date.now() - 1 });
  await s.tick();
  assert.equal(rem.list().length, 1);
  fail = false;
  await s.tick();
  assert.equal(sent.length, 1);
  assert.equal(rem.list().length, 0);
});
