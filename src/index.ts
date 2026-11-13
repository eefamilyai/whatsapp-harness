import { Agent } from "./agent.js";
import { runCommand } from "./commands.js";
import { config, validateConfig } from "./config.js";
import { isDismiss, isNo, isYes, parseSnooze } from "./incoming.js";
import { OpenAiCompatLlm } from "./llm.js";
import { log } from "./log.js";
import { cleanupAttachments, ingest } from "./media.js";
import * as rem from "./reminders.js";
import { Scheduler } from "./scheduler.js";
import { loadSettings } from "./settings.js";
import * as attachments from "./tools/attachments.js";
import * as calendar from "./tools/calendar.js";
import * as notesTools from "./tools/notes.js";
import * as reminderTools from "./tools/reminders.js";
import { shell } from "./tools/shell.js";
import { getTime } from "./tools/time.js";
import type { Tool, ToolContext } from "./tools/types.js";
import * as web from "./tools/web.js";
import { WhatsApp, type IncomingMessage } from "./whatsapp.js";

loadSettings();
const wa = new WhatsApp();

// `node dist/index.js --link`: pair WhatsApp, save the login, exit. Used by the installer.
if (process.argv.includes("--link")) {
  wa.onConnected = () => {
    setTimeout(() => {
      log.info(`Linked as ${wa.user() ?? "?"}. The login is saved in ${config.authDir}.`);
      void wa.stop().finally(() => process.exit(0));
    }, 6000);
  };
  log.info("Link mode: waiting for you to scan the QR code / enter the pairing code in WhatsApp...");
  setTimeout(() => {
    log.error("Gave up after 15 minutes without a link. Run install.bat again to retry.");
    process.exit(1);
  }, 15 * 60_000).unref();
  await wa.start();
} else {
  await run();
}

async function run(): Promise<void> {
  const problems = validateConfig();
  if (problems.length) {
    for (const p of problems) log.error(p);
    process.exit(1);
  }

  const llm = new OpenAiCompatLlm();
  const tools: Tool[] = [
    getTime,
    web.webSearch,
    web.webFetch,
    reminderTools.setReminder,
    reminderTools.setAlarm,
    reminderTools.scheduleTask,
    reminderTools.listReminders,
    reminderTools.updateReminder,
    reminderTools.cancelReminder,
    calendar.calendarList,
    calendar.calendarCreate,
    calendar.calendarUpdate,
    calendar.calendarDelete,
    notesTools.remember,
    notesTools.forget,
    ...attachments.attachmentTools(llm),
    shell, // checks SHELL_MODE / the /shell setting every time it runs
  ];
  const agent = new Agent(llm, tools);

  // ---- one-at-a-time work queue (a turn can take a while; messages must not interleave) ----
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const next = queue.then(job, job);
    queue = next.catch(() => undefined);
    return next;
  };

  // ---- yes/no approvals (shell confirm mode) ----
  let pendingApproval: ((ok: boolean) => void) | undefined;
  const ctx: ToolContext = {
    confirm: async (question) => {
      await wa.send(question);
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pendingApproval = undefined;
          void wa.send("No answer in 5 minutes, so I did not run it.").catch(() => undefined);
          resolve(false);
        }, 5 * 60_000);
        pendingApproval = (ok) => {
          clearTimeout(timer);
          pendingApproval = undefined;
          resolve(ok);
        };
      });
    },
  };

  async function converse(prompt: string, opts: Parameters<Agent["reply"]>[2] = {}): Promise<void> {
    await wa.typing(true);
    try {
      await wa.send(await agent.reply(prompt, ctx, opts));
    } catch (err) {
      log.error("turn failed", err as Error);
      await wa.send(`⚠️ Something went wrong: ${(err as Error).message}`).catch(() => undefined);
    } finally {
      await wa.typing(false);
    }
  }

  async function handleMedia(m: IncomingMessage): Promise<void> {
    const media = m.media!;
    await wa.typing(true);
    try {
      const ing = await ingest(media, m.download ?? (async () => Promise.reject(new Error("nothing to download"))));
      if (ing.refusal) {
        await wa.send(ing.refusal);
        return;
      }
      await converse(ing.prompt, { images: ing.images, historyText: ing.historyText });
    } catch (err) {
      log.error("could not process attachment", err as Error);
      await wa.send(`⚠️ I couldn't process that ${media.kind}: ${(err as Error).message}`).catch(() => undefined);
    } finally {
      await wa.typing(false);
    }
  }

  async function handleIncoming(m: IncomingMessage): Promise<void> {
    const text = m.text ?? "";

    // 1. Answer to a pending yes/no question. Bypasses the queue: the turn that asked is waiting on it.
    if (pendingApproval) {
      const resolve = pendingApproval;
      if (!m.media && isYes(text)) return resolve(true);
      resolve(false);
      if (!m.media && isNo(text)) return;
      // Anything else counts as "no" and is then handled as a new message below.
    }

    // 2. Alarm control, without spending an LLM call.
    if (!m.media && rem.ringing().length) {
      const snooze = parseSnooze(text);
      if (snooze !== undefined) {
        const items = rem.snoozeRinging(snooze);
        await wa.send(`😴 Snoozed ${items.length > 1 ? `${items.length} alarms` : `"${items[0]?.text}"`} for ${snooze} min.`);
        return;
      }
      if (isDismiss(text)) {
        const done = rem.dismissRinging();
        await wa.send(`✅ Dismissed: ${done.map((d) => d.text).join(", ")}`);
        return;
      }
    }

    // 3. Attachments.
    if (m.media) {
      await enqueue(() => handleMedia(m));
      return;
    }

    // 4. Slash commands answer at once, even while a long turn is running.
    const reply = runCommand(text);
    if (reply !== undefined) {
      await wa.send(reply);
      return;
    }

    // 5. The assistant.
    await enqueue(() => converse(text));
  }

  wa.onMessage = (m) => {
    void handleIncoming(m).catch((err) => log.error("handler error", err as Error));
  };

  const scheduler = new Scheduler({
    online: () => wa.online(),
    send: (t) => wa.send(t),
    runTask: (prompt) =>
      enqueue(async () => {
        await wa.typing(true);
        try {
          await wa.send(await agent.reply(`[Scheduled task, running now] ${prompt}`, ctx));
        } finally {
          await wa.typing(false);
        }
      }),
  });

  log.info(`whatsapp-harness starting: model ${config.llm.model}, tz ${config.timezone}, shell ${config.shell.mode}, ${tools.length} tools, gemini ${config.gemini.apiKey ? "on" : "off"}`);
  const removed = cleanupAttachments();
  if (removed) log.info(`removed ${removed} old attachment files`);
  setInterval(() => cleanupAttachments(), 24 * 3_600_000).unref();
  await wa.start();
  scheduler.start();

  const shutdown = (sig: string) => {
    log.info(`${sig}: shutting down`);
    scheduler.stop();
    void wa.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

process.on("unhandledRejection", (err) => log.error("unhandled rejection", err as Error));
process.on("uncaughtException", (err) => log.error("uncaught exception", err));
