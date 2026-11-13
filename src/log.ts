import { config } from "./config.js";

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;
const threshold = levels[(config.logLevel as Level) in levels ? (config.logLevel as Level) : "info"];

function emit(level: Level, msg: string, extra?: unknown): void {
  if (levels[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (extra instanceof Error) out(line, extra.stack ?? extra.message);
  else if (extra !== undefined) out(line, extra);
  else out(line);
}

export const log = {
  debug: (m: string, e?: unknown) => emit("debug", m, e),
  info: (m: string, e?: unknown) => emit("info", m, e),
  warn: (m: string, e?: unknown) => emit("warn", m, e),
  error: (m: string, e?: unknown) => emit("error", m, e),
};
