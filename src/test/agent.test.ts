import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "wah-"));
process.env.TIMEZONE = "Asia/Singapore";
process.env.LLM_API_KEY = "test";
process.env.SHELL_MODE = "confirm";

const { Agent, systemPrompt } = await import("../agent.js");
const { OpenAiCompatLlm } = await import("../llm.js");
const rem = await import("../reminders.js");
const { setReminder, listReminders } = await import("../tools/reminders.js");
const { shell } = await import("../tools/shell.js");
const notes = await import("../notes.js");
const { remember } = await import("../tools/notes.js");

import type { ChatMessage, Completion, Llm } from "../llm.js";
const ctx = { confirm: async () => true };

function scripted(steps: Completion[], seen: ChatMessage[][] = []): Llm {
  let i = 0;
  return {
    async complete(messages) {
      seen.push(JSON.parse(JSON.stringify(messages)));
      const s = steps[i++];
      if (!s) throw new Error("script exhausted");
      return s;
    },
  };
}
const call = (name: string, args: unknown, id = "c1") => ({ id, type: "function" as const, function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });

test("the agent loop runs a tool, feeds back the result, and returns the final text", async () => {
  const seen: ChatMessage[][] = [];
  const llm = scripted(
    [
      { content: null, toolCalls: [call("set_reminder", { text: "buy milk", at: "2099-01-02T09:00" })] },
      { content: "Done: I'll remind you.", toolCalls: [] },
    ],
    seen,
  );
  const agent = new Agent(llm, [setReminder, listReminders]);
  const out = await agent.reply("remind me to buy milk on 2 Jan 2099 9am", ctx);
  assert.equal(out, "Done: I'll remind you.");
  assert.equal(rem.list().length, 1);
  assert.equal(rem.list()[0]!.text, "buy milk");
  assert.equal(new Date(rem.list()[0]!.dueAt).toISOString(), "2099-01-02T01:00:00.000Z");
  const toolMsg = seen[1]!.find((m) => m.role === "tool") as { content: string };
  assert.match(toolMsg.content, /Created reminder .* Fri 02 Jan 2099, 09:00|Created reminder/);
});

test("history carries into the next turn; tool errors and bad args are returned to the model, not thrown", async () => {
  const seen: ChatMessage[][] = [];
  const llm = scripted(
    [
      { content: null, toolCalls: [call("set_reminder", { text: "past", at: "2001-01-01T00:00" }, "a"), call("nope", {}, "b"), call("set_reminder", "{not json", "c")] },
      { content: "ok handled", toolCalls: [] },
    ],
    seen,
  );
  const agent = new Agent(llm, [setReminder]);
  assert.equal(await agent.reply("second turn", ctx), "ok handled");
  const results = seen[1]!.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
  assert.match(results[0]!, /in the past/);
  assert.match(results[1]!, /unknown tool/);
  assert.match(results[2]!, /could not parse/);
  // The first test's turn is in history, ahead of this one.
  assert.ok(seen[0]!.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("buy milk")));
});

test("shell: declined commands do not run; approved ones do; off mode refuses", async () => {
  const declined = await shell.run({ command: "echo hi" }, { confirm: async () => false });
  assert.match(declined, /declined/);
  const ran = await shell.run({ command: process.platform === "win32" ? "Write-Output hi-there" : "echo hi-there" }, { confirm: async () => true });
  assert.match(ran, /hi-there[\s\S]*exit code 0/);
  const slow = await shell.run({ command: process.platform === "win32" ? "Start-Sleep 5" : "sleep 5", timeout_seconds: 1 }, ctx);
  assert.match(slow, /killed after 1s/);
});

test("memory notes show up in the system prompt", async () => {
  await remember.run({ text: "prefers 24h time" }, ctx);
  assert.match(systemPrompt(), /prefers 24h time/);
  assert.equal(notes.all().length, 1);
});

test("OpenAiCompatLlm talks to an OpenAI-style endpoint, retries a 500, and sends tools", async () => {
  let hits = 0;
  let lastBody: { tools?: unknown[]; model?: string } = {};
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      hits++;
      lastBody = JSON.parse(b);
      assert.equal(req.headers.authorization, "Bearer k");
      if (hits === 1) return void res.writeHead(500).end("oops");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call("get_time", {})] } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const llm = new OpenAiCompatLlm(`http://127.0.0.1:${port}`, "k", "m");
  const out = await llm.complete([{ role: "user", content: "hi" }], [{ type: "function", function: { name: "get_time", description: "d", parameters: { type: "object" } } }]);
  server.close();
  assert.equal(hits, 2);
  assert.equal(out.toolCalls[0]!.function.name, "get_time");
  assert.equal(lastBody.model, "m");
  assert.equal(lastBody.tools?.length, 1);
});
