import fs from "node:fs";
import os from "node:os";
import path from "node:path";

try {
  process.loadEnvFile(path.resolve(".env"));
} catch {
  /* no .env file: rely on the real environment */
}

const env = process.env;
const str = (k: string, d = ""): string => (env[k] ?? "").trim() || d;
const int = (k: string, d: number): number => {
  const n = Number.parseInt(str(k), 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export type ShellMode = "confirm" | "auto" | "off";
export type Thinking = "off" | "low" | "high" | "max" | "";

const bool = (k: string, d: boolean): boolean => {
  const v = str(k).toLowerCase();
  return v ? ["1", "true", "yes", "on"].includes(v) : d;
};
const baseUrl = str("LLM_BASE_URL", "https://api.deepseek.com").replace(/\/+$/, "");
const thinkingRaw = str("LLM_THINKING").toLowerCase();

const shellMode = str("SHELL_MODE", "confirm").toLowerCase();
const dataDir = path.resolve(str("DATA_DIR", "./data"));

export const config = {
  llm: {
    baseUrl,
    apiKey: str("LLM_API_KEY") || str("DEEPSEEK_API_KEY"),
    model: str("LLM_MODEL", "deepseek-flash"),
    /** Does the chat model accept images? deepseek-flash does. */
    vision: bool("LLM_VISION", true),
    /** DeepSeek thinks by default; for a chat assistant we default it off (faster, cheaper). Other providers: unset = send nothing. */
    thinking: (["off", "low", "high", "max"].includes(thinkingRaw)
      ? thinkingRaw
      : baseUrl.includes("deepseek.com")
        ? "off"
        : "") as Thinking,
  },
  /** Optional: Gemini reads voice notes, videos and scanned PDFs, which DeepSeek cannot. */
  gemini: {
    apiKey: str("GEMINI_API_KEY"),
    model: str("GEMINI_MODEL", "gemini-2.5-flash"),
  },
  mediaDir: path.join(dataDir, "media"),
  ownerNumber: str("OWNER_NUMBER").replace(/\D/g, ""),
  pairingNumber: str("PAIRING_NUMBER").replace(/\D/g, ""),
  timezone: str("TIMEZONE", "Asia/Singapore"),
  dataDir,
  authDir: path.join(dataDir, "auth"),
  shell: {
    mode: (["confirm", "auto", "off"].includes(shellMode) ? shellMode : "confirm") as ShellMode,
    cwd: str("SHELL_CWD") || os.homedir(),
  },
  alarm: {
    repeatSeconds: int("ALARM_REPEAT_SECONDS", 60),
    maxPings: int("ALARM_MAX_PINGS", 10),
  },
  maxMessageAgeMs: int("MAX_MESSAGE_AGE_MINUTES", 30) * 60_000,
  searxngUrl: str("SEARXNG_URL").replace(/\/+$/, ""),
  google: {
    clientFile: path.resolve(str("GOOGLE_CLIENT_FILE", path.join(dataDir, "google-client.json"))),
    tokenFile: path.resolve(str("GOOGLE_TOKEN_FILE", path.join(dataDir, "google-token.json"))),
    calendarId: str("GOOGLE_CALENDAR_ID", "primary"),
  },
  logLevel: str("LOG_LEVEL", "info"),
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.mediaDir, { recursive: true });

export function validateConfig(): string[] {
  const problems: string[] = [];
  if (!config.llm.apiKey) problems.push("LLM_API_KEY is not set (see .env.example)");
  try {
    new Intl.DateTimeFormat("en", { timeZone: config.timezone });
  } catch {
    problems.push(`TIMEZONE "${config.timezone}" is not a valid IANA time zone`);
  }
  return problems;
}
