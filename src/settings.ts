import { config, type ShellMode, type Thinking } from "./config.js";
import { JsonStore } from "./store.js";

/** Settings the owner can change from WhatsApp. They override .env and survive restarts (data/settings.json). */
interface Overrides {
  model?: string;
  thinking?: Thinking;
  shell?: ShellMode;
  timezone?: string;
  vision?: boolean;
  alarmRepeat?: number;
  alarmPings?: number;
}

const store = new JsonStore<Overrides>("settings.json", () => ({}));

const defaults = {
  model: config.llm.model,
  thinking: config.llm.thinking,
  shell: config.shell.mode,
  timezone: config.timezone,
  vision: config.llm.vision,
  alarmRepeat: config.alarm.repeatSeconds,
  alarmPings: config.alarm.maxPings,
};

function apply(o: Overrides): void {
  config.llm.model = o.model ?? defaults.model;
  config.llm.thinking = o.thinking ?? defaults.thinking;
  config.shell.mode = o.shell ?? defaults.shell;
  config.timezone = o.timezone ?? defaults.timezone;
  config.llm.vision = o.vision ?? defaults.vision;
  config.alarm.repeatSeconds = o.alarmRepeat ?? defaults.alarmRepeat;
  config.alarm.maxPings = o.alarmPings ?? defaults.alarmPings;
}

export function loadSettings(): void {
  apply(store.data);
}

export class SettingError extends Error {}

const intIn = (raw: string, lo: number, hi: number, what: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new SettingError(`${what} must be a whole number from ${lo} to ${hi}.`);
  return n;
};

/** Validate and change one setting. Returns a human confirmation. */
export function setSetting(key: string, raw: string): string {
  const v = raw.trim();
  if (!v) throw new SettingError("Give a value.");
  switch (key) {
    case "model":
      if (!/^[\w.:/@+-]{1,100}$/.test(v)) throw new SettingError("That doesn't look like a model id (no spaces).");
      store.data.model = v;
      break;
    case "thinking": {
      const t = v.toLowerCase();
      if (t === "default") delete store.data.thinking;
      else if (["off", "low", "high", "max"].includes(t)) store.data.thinking = t as Thinking;
      else throw new SettingError("thinking is one of: off, low, high, max, default.");
      break;
    }
    case "shell": {
      const m = v.toLowerCase();
      if (!["confirm", "auto", "off"].includes(m)) throw new SettingError("shell is one of: confirm, auto, off.");
      store.data.shell = m as ShellMode;
      break;
    }
    case "timezone":
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
      } catch {
        throw new SettingError(`"${v}" is not an IANA time zone. Examples: Asia/Singapore, Europe/London, America/New_York.`);
      }
      store.data.timezone = v;
      break;
    case "vision": {
      const b = v.toLowerCase();
      if (!["on", "off"].includes(b)) throw new SettingError("vision is on or off.");
      store.data.vision = b === "on";
      break;
    }
    case "alarmRepeat":
      store.data.alarmRepeat = intIn(v, 10, 3600, "Seconds");
      break;
    case "alarmPings":
      store.data.alarmPings = intIn(v, 1, 60, "Pings");
      break;
    default:
      throw new SettingError(`Unknown setting ${key}.`);
  }
  store.save();
  apply(store.data);
  return "ok";
}

export function resetSettings(): void {
  for (const k of Object.keys(store.data)) delete (store.data as Record<string, unknown>)[k];
  store.save();
  apply(store.data);
}

export function overridden(): string[] {
  return Object.keys(store.data);
}
