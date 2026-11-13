// Time-zone helpers built on Intl only (no date library).

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock components of an instant in a zone. */
export function toLocalParts(ms: number, tz: string): LocalParts {
  const o: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) {
    if (p.type !== "literal") o[p.type] = Number(p.value);
  }
  return {
    year: o.year!,
    month: o.month!,
    day: o.day!,
    hour: o.hour! % 24,
    minute: o.minute!,
    second: o.second!,
  };
}

/** Offset (ms) of the zone from UTC at an instant: local - utc. */
export function zoneOffsetMs(ms: number, tz: string): number {
  const p = toLocalParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the zone's wall clock reads the given components. */
export function localToUtc(p: Partial<LocalParts> & Pick<LocalParts, "year" | "month" | "day">, tz: string): number {
  const naive = Date.UTC(p.year, p.month - 1, p.day, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
  let guess = naive - zoneOffsetMs(naive, tz);
  // Second pass handles offsets that differ between the guess and the result (DST edges).
  guess = naive - zoneOffsetMs(guess, tz);
  return guess;
}

const ISO_LOCAL =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Parse a date/time the model gave us. Accepts "2026-11-14T09:30", "2026-11-14 09:30",
 * "2026-11-14" (midnight) and anything with an explicit Z or +08:00 offset.
 * A string with no offset is read as wall-clock time in `tz`.
 * Returns undefined if it cannot be understood.
 */
export function parseWhen(input: string, tz: string): number | undefined {
  const s = input.trim();
  const m = ISO_LOCAL.exec(s);
  if (!m) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? undefined : t;
  }
  const [, y, mo, d, h, mi, sec, off] = m;
  const parts = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: h ? Number(h) : 0,
    minute: mi ? Number(mi) : 0,
    second: sec ? Number(sec) : 0,
  };
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31 || parts.hour > 23 || parts.minute > 59) {
    return undefined;
  }
  if (off) {
    if (off.toUpperCase() === "Z") return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const sign = off.startsWith("-") ? -1 : 1;
    const digits = off.replace(/[^0-9]/g, "");
    const offMin = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - sign * offMin * 60_000;
  }
  return localToUtc(parts, tz);
}

/** "Fri 14 Nov 2026, 09:30" in the zone. */
export function formatWhen(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date(ms))
    .replace(",", "")
    .replace(/(\d{4}) /, "$1, ");
}

/** ISO-8601 string with the zone's numeric offset, e.g. 2026-11-14T09:30:00+08:00. */
export function toIsoWithOffset(ms: number, tz: string): string {
  const p = toLocalParts(ms, tz);
  const off = Math.round(zoneOffsetMs(ms, tz) / 60_000);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}:${two(p.second)}${sign}${two(Math.floor(a / 60))}:${two(a % 60)}`;
}

export function humanDuration(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return rm ? `${h}h ${rm}m` : `${h}h`;
  return `${Math.round(h / 24)} days`;
}

/** Shift a wall-clock instant by whole days/months in the zone (keeps the time of day). */
export function addLocal(ms: number, tz: string, add: { days?: number; months?: number }): number {
  const p = toLocalParts(ms, tz);
  const base = new Date(Date.UTC(p.year, p.month - 1 + (add.months ?? 0), 1));
  const dim = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(p.day, dim) + (add.days ?? 0);
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), day));
  return localToUtc(
    {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: p.hour,
      minute: p.minute,
      second: p.second,
    },
    tz,
  );
}

export function weekdayIndex(ms: number, tz: string): number {
  const p = toLocalParts(ms, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0 = Sunday
}
