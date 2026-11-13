import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "wah-"));
process.env.LLM_API_KEY = "k";

const { runCommand, commandNames } = await import("../commands.js");
const { config } = await import("../config.js");
const { loadSettings } = await import("../settings.js");
const rem = await import("../reminders.js");
const notes = await import("../notes.js");

test("/help lists every command and /help <cmd> explains one", () => {
  const help = runCommand("/help")!;
  for (const n of commandNames()) assert.match(help, new RegExp(`/${n}\\b`), n);
  assert.equal(runCommand("help"), help);
  assert.match(runCommand("/help shell")!, /confirm = I ask you yes\/no/);
  assert.match(runCommand("/help nope")!, /No command/);
});

test("defaults: deepseek-flash, thinking off for DeepSeek, vision on", () => {
  assert.equal(config.llm.model, "deepseek-flash");
  assert.equal(config.llm.thinking, "off");
  assert.equal(config.llm.vision, true);
});

test("settings change at runtime, validate input, and persist", () => {
  assert.match(runCommand("/model deepseek-v4-pro")!, /can't read images/);
  assert.equal(config.llm.model, "deepseek-v4-pro");
  assert.match(runCommand("/model")!, /deepseek-v4-pro/);
  assert.match(runCommand("/model has spaces")!, /⚠️/);
  assert.equal(config.llm.model, "deepseek-v4-pro");

  assert.match(runCommand("/thinking high")!, /high/);
  assert.equal(config.llm.thinking, "high");
  assert.match(runCommand("/thinking turbo")!, /⚠️/);
  runCommand("/thinking default");
  assert.equal(config.llm.thinking, "off");

  assert.match(runCommand("/shell auto")!, /WITHOUT asking/);
  assert.equal(config.shell.mode, "auto");
  assert.match(runCommand("/shell yolo")!, /⚠️/);
  runCommand("/shell off");
  assert.equal(config.shell.mode, "off");

  assert.match(runCommand("/timezone Europe/London")!, /Europe\/London/);
  assert.equal(config.timezone, "Europe/London");
  assert.match(runCommand("/timezone Mars/Olympus")!, /not an IANA/);
  assert.equal(config.timezone, "Europe/London");

  assert.match(runCommand("/alarm repeat 30")!, /30s/);
  assert.match(runCommand("/alarm pings 5")!, /5/);
  assert.equal(config.alarm.repeatSeconds, 30);
  assert.equal(config.alarm.maxPings, 5);
  assert.match(runCommand("/alarm repeat 1")!, /⚠️/);
  assert.match(runCommand("/alarm bogus")!, /Use:/);

  assert.match(runCommand("/vision off")!, /off/);
  assert.equal(config.llm.vision, false);

  const shown = runCommand("/settings")!;
  assert.match(shown, /deepseek-v4-pro \(changed\)/);
  assert.match(shown, /Europe\/London \(changed\)/);

  // overrides survive a restart: reload them over a fresh copy of the defaults
  config.llm.model = "x";
  config.timezone = "UTC";
  loadSettings();
  assert.equal(config.llm.model, "deepseek-v4-pro");
  assert.equal(config.timezone, "Europe/London");

  runCommand("/settings reset");
  assert.equal(config.llm.model, "deepseek-flash");
  assert.equal(config.timezone, "Asia/Singapore");
  assert.equal(config.shell.mode, "confirm");
  assert.equal(config.llm.vision, true);
  assert.equal(config.alarm.repeatSeconds, 60);
});

test("/reminders, /cancel, /notes, /forget, /status, /reset", () => {
  const r = rem.add({ kind: "reminder", text: "buy eggs", dueAt: Date.now() + 3_600_000 });
  assert.match(runCommand("/reminders")!, new RegExp(`${r.id} \\[reminder\\].*buy eggs`));
  assert.match(runCommand(`/cancel ${r.id}`)!, /Cancelled/);
  assert.equal(runCommand("/reminders"), "Nothing scheduled.");
  assert.match(runCommand("/cancel zzzz")!, /No item/);
  const id = notes.add("likes oat milk");
  assert.match(runCommand("/notes")!, /likes oat milk/);
  assert.match(runCommand(`/forget ${id}`)!, /Forgot/);
  assert.match(runCommand("/status")!, /Model: deepseek-flash/);
  assert.equal(runCommand("/reset"), "Conversation cleared.");
});

test("non-commands go to the assistant; unknown slash words get a hint", () => {
  assert.equal(runCommand("what's the weather"), undefined);
  assert.equal(runCommand("/usr/local/bin/node --version"), undefined);
  assert.match(runCommand("/frobnicate")!, /Unknown command/);
});
