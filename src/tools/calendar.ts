import { config } from "../config.js";
import { gcal } from "../google.js";
import { formatWhen, parseWhen, toIsoWithOffset } from "../time.js";
import { num, str, type Tool } from "./types.js";

interface GEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

function when(e: GEvent): string {
  const s = e.start;
  const en = e.end;
  if (s?.date) return en?.date && en.date !== s.date ? `${s.date} (all day, to ${en.date})` : `${s.date} (all day)`;
  const a = s?.dateTime ? Date.parse(s.dateTime) : NaN;
  const b = en?.dateTime ? Date.parse(en.dateTime) : NaN;
  if (Number.isNaN(a)) return "?";
  const end = Number.isNaN(b) ? "" : ` → ${formatWhen(b, config.timezone).split(", ").pop()}`;
  return `${formatWhen(a, config.timezone)}${end}`;
}

function line(e: GEvent): string {
  return `[${e.id}] ${when(e)} — ${e.summary ?? "(no title)"}${e.location ? ` @ ${e.location}` : ""}`;
}

/** Turn a local string into a Google start/end object. Date-only strings are all-day. */
function timeField(input: string, allDay: boolean): { dateTime?: string; date?: string; timeZone?: string } {
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(input.trim())) return { date: input.trim().slice(0, 10) };
  const ms = parseWhen(input, config.timezone);
  if (ms === undefined) throw new Error(`Could not read time "${input}". Use e.g. 2026-11-14T15:00.`);
  return { dateTime: toIsoWithOffset(ms, config.timezone), timeZone: config.timezone };
}

const tzNote = "Times are local to the user's time zone as 2026-11-14T15:00, no offset. A date alone (2026-11-14) is an all-day event.";

export const calendarList: Tool = {
  name: "calendar_list_events",
  description: `List Google Calendar events between two times (default: now to 7 days ahead). ${tzNote}`,
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Start of range, local ISO. Default now." },
      to: { type: "string", description: "End of range, local ISO. Default from + 7 days." },
      query: { type: "string", description: "Free-text filter." },
      max_results: { type: "integer", description: "Default 25, max 100" },
    },
  },
  async run(args) {
    const from = str(args.from) ? parseWhen(str(args.from)!, config.timezone) : Date.now();
    if (from === undefined) throw new Error("Could not read `from`.");
    const to = str(args.to) ? parseWhen(str(args.to)!, config.timezone) : from + 7 * 86_400_000;
    if (to === undefined) throw new Error("Could not read `to`.");
    const res = await gcal<{ items?: GEvent[] }>("GET", "/events", {
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.min(100, Math.max(1, Math.round(num(args.max_results) ?? 25)))),
      ...(str(args.query) ? { q: str(args.query)! } : {}),
    });
    const items = (res.items ?? []).filter((e) => e.status !== "cancelled");
    return items.length ? items.map(line).join("\n") : "No events in that range.";
  },
};

export const calendarCreate: Tool = {
  name: "calendar_create_event",
  description: `Create a Google Calendar event. ${tzNote} If end is omitted a timed event lasts 1 hour.`,
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Title" },
      start: { type: "string" },
      end: { type: "string" },
      all_day: { type: "boolean" },
      location: { type: "string" },
      description: { type: "string" },
      reminder_minutes: { type: "integer", description: "Popup reminder N minutes before (Google-side)." },
    },
    required: ["summary", "start"],
  },
  async run(args) {
    const summary = str(args.summary);
    const start = str(args.start);
    if (!summary || !start) throw new Error("summary and start are required");
    const allDay = args.all_day === true;
    const s = timeField(start, allDay);
    let e: ReturnType<typeof timeField>;
    if (s.date) {
      const endStr = str(args.end) ?? s.date;
      const endDate = timeField(endStr, true).date!;
      // Google's all-day end date is exclusive.
      const d = new Date(`${endDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      e = { date: d.toISOString().slice(0, 10) };
    } else if (str(args.end)) {
      e = timeField(str(args.end)!, false);
    } else {
      e = { dateTime: toIsoWithOffset(Date.parse(s.dateTime!) + 3_600_000, config.timezone), timeZone: config.timezone };
    }
    const rm = num(args.reminder_minutes);
    const ev = await gcal<GEvent>("POST", "/events", undefined, {
      summary,
      start: s,
      end: e,
      ...(str(args.location) ? { location: str(args.location) } : {}),
      ...(str(args.description) ? { description: str(args.description) } : {}),
      ...(rm !== undefined ? { reminders: { useDefault: false, overrides: [{ method: "popup", minutes: Math.round(rm) }] } } : {}),
    });
    return `Created: ${line(ev)}`;
  },
};

export const calendarUpdate: Tool = {
  name: "calendar_update_event",
  description: `Change an existing Google Calendar event (get ids from calendar_list_events). ${tzNote}`,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" },
      summary: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      location: { type: "string" },
      description: { type: "string" },
    },
    required: ["id"],
  },
  async run(args) {
    const id = str(args.id);
    if (!id) throw new Error("id is required");
    const patch: Record<string, unknown> = {};
    if (str(args.summary)) patch.summary = str(args.summary);
    if (str(args.location)) patch.location = str(args.location);
    if (str(args.description)) patch.description = str(args.description);
    if (str(args.start)) patch.start = timeField(str(args.start)!, false);
    if (str(args.end)) patch.end = timeField(str(args.end)!, false);
    if (!Object.keys(patch).length) throw new Error("Nothing to change.");
    const ev = await gcal<GEvent>("PATCH", `/events/${encodeURIComponent(id)}`, undefined, patch);
    return `Updated: ${line(ev)}`;
  },
};

export const calendarDelete: Tool = {
  name: "calendar_delete_event",
  description: "Delete a Google Calendar event by id (get ids from calendar_list_events). Confirm with the user first if there is any doubt which event they mean.",
  parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  async run(args) {
    const id = str(args.id);
    if (!id) throw new Error("id is required");
    await gcal("DELETE", `/events/${encodeURIComponent(id)}`);
    return `Deleted event ${id}.`;
  },
};
