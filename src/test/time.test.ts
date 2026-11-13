import assert from "node:assert/strict";
import { test } from "node:test";
import { addLocal, formatWhen, parseWhen, toIsoWithOffset, weekdayIndex } from "../time.js";

test("parseWhen reads wall-clock time in the zone", () => {
  assert.equal(new Date(parseWhen("2026-11-14T08:00", "Asia/Singapore")!).toISOString(), "2026-11-14T00:00:00.000Z");
  assert.equal(new Date(parseWhen("2026-11-14 08:00", "Asia/Singapore")!).toISOString(), "2026-11-14T00:00:00.000Z");
  assert.equal(new Date(parseWhen("2026-11-14", "Asia/Singapore")!).toISOString(), "2026-11-13T16:00:00.000Z");
  // New York is UTC-5 in November (EST), UTC-4 in July (EDT)
  assert.equal(new Date(parseWhen("2026-11-14T08:00", "America/New_York")!).toISOString(), "2026-11-14T13:00:00.000Z");
  assert.equal(new Date(parseWhen("2026-07-14T08:00", "America/New_York")!).toISOString(), "2026-07-14T12:00:00.000Z");
});

test("parseWhen honours explicit offsets and rejects junk", () => {
  assert.equal(new Date(parseWhen("2026-11-14T08:00:00+08:00", "UTC")!).toISOString(), "2026-11-14T00:00:00.000Z");
  assert.equal(new Date(parseWhen("2026-11-14T08:00:00Z", "Asia/Singapore")!).toISOString(), "2026-11-14T08:00:00.000Z");
  assert.equal(parseWhen("tomorrow-ish", "UTC"), undefined);
  assert.equal(parseWhen("2026-13-40T99:99", "UTC"), undefined);
});

test("formatting round-trips", () => {
  const t = parseWhen("2026-11-14T09:30", "Asia/Singapore")!;
  assert.equal(toIsoWithOffset(t, "Asia/Singapore"), "2026-11-14T09:30:00+08:00");
  assert.match(formatWhen(t, "Asia/Singapore"), /Sat 14 Nov 2026, 09:30/);
  assert.equal(weekdayIndex(t, "Asia/Singapore"), 6);
});

test("addLocal keeps the wall-clock time across DST and clamps month ends", () => {
  const before = parseWhen("2026-03-07T09:00", "America/New_York")!; // day before US DST starts
  assert.equal(toIsoWithOffset(addLocal(before, "America/New_York", { days: 1 }), "America/New_York"), "2026-03-08T09:00:00-04:00");
  const jan31 = parseWhen("2026-01-31T10:00", "Asia/Singapore")!;
  assert.equal(toIsoWithOffset(addLocal(jan31, "Asia/Singapore", { months: 1 }), "Asia/Singapore"), "2026-02-28T10:00:00+08:00");
});
