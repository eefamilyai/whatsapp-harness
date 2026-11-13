import { normalizeMessageContent, type proto } from "@whiskeysockets/baileys";

/** Prefix on everything the bot sends in self-chat mode; lets us ignore our own echoes. */
export const BOT_MARK = "🤖 ";

export interface RawMessage {
  key: { id?: string | null; remoteJid?: string | null; remoteJidAlt?: string | null; fromMe?: boolean | null; participant?: string | null };
  message?: proto.IMessage | null;
  messageTimestamp?: number | { toNumber(): number } | null;
}

export interface Identity {
  /** User parts (digits before @/:) that identify the linked account: phone number and LID. */
  selfUsers: string[];
  /** Set when the bot runs on a different number than the owner. */
  ownerNumber?: string;
  /** Extra user parts known to belong to the owner (e.g. their LID). */
  ownerUsers?: string[];
}

export type MediaKind = "image" | "sticker" | "video" | "audio" | "document" | "location" | "contact";

/** What a non-text message carries. `inline` is set for kinds with no file to download. */
export interface MediaInfo {
  kind: MediaKind;
  mime: string;
  fileName?: string;
  caption?: string;
  sizeBytes?: number;
  seconds?: number;
  pages?: number;
  voiceNote?: boolean;
  gif?: boolean;
  inline?: string;
}

export type Verdict =
  | { accept: true; text?: string; media?: MediaInfo }
  | { accept: false; reason: string };

export const userPart = (jid?: string | null): string | undefined => {
  if (!jid) return undefined;
  const at = jid.indexOf("@");
  const left = at < 0 ? jid : jid.slice(0, at);
  return left.split(":")[0]!.split("_")[0];
};

const tsSeconds = (t: RawMessage["messageTimestamp"]): number | undefined => {
  if (t == null) return undefined;
  return typeof t === "number" ? t : t.toNumber();
};

const toNum = (v: unknown): number | undefined => {
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  const o = v as { toNumber?: () => number };
  return typeof o.toNumber === "function" ? o.toNumber() : undefined;
};
const mimeBase = (m?: string | null, fallback = "application/octet-stream"): string => (m ?? fallback).split(";")[0]!.trim().toLowerCase() || fallback;

/** Pull the text and/or attachment out of a message. Pure; unit-tested. */
export function extractContent(content: proto.IMessage | null | undefined): { text?: string; media?: MediaInfo } {
  const m = normalizeMessageContent(content);
  if (!m) return {};
  if (m.conversation) return { text: m.conversation };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text };
  const cap = (c?: string | null) => c?.trim() || undefined;
  if (m.imageMessage) {
    const i = m.imageMessage;
    return { media: { kind: "image", mime: mimeBase(i.mimetype, "image/jpeg"), caption: cap(i.caption), sizeBytes: toNum(i.fileLength) } };
  }
  if (m.stickerMessage) {
    const i = m.stickerMessage;
    return { media: { kind: "sticker", mime: mimeBase(i.mimetype, "image/webp"), sizeBytes: toNum(i.fileLength) } };
  }
  if (m.videoMessage) {
    const v = m.videoMessage;
    return { media: { kind: "video", mime: mimeBase(v.mimetype, "video/mp4"), caption: cap(v.caption), sizeBytes: toNum(v.fileLength), seconds: v.seconds ?? undefined, gif: !!v.gifPlayback } };
  }
  if (m.audioMessage) {
    const a = m.audioMessage;
    return { media: { kind: "audio", mime: mimeBase(a.mimetype, "audio/ogg"), sizeBytes: toNum(a.fileLength), seconds: a.seconds ?? undefined, voiceNote: !!a.ptt } };
  }
  if (m.documentMessage) {
    const d = m.documentMessage;
    return {
      media: { kind: "document", mime: mimeBase(d.mimetype), fileName: d.fileName ?? undefined, caption: cap(d.caption), sizeBytes: toNum(d.fileLength), pages: d.pageCount ?? undefined },
    };
  }
  const loc = m.locationMessage ?? m.liveLocationMessage;
  if (loc) {
    const l = loc as { degreesLatitude?: number | null; degreesLongitude?: number | null; name?: string | null; address?: string | null };
    const label = [l.name, l.address].filter(Boolean).join(", ");
    return {
      media: {
        kind: "location",
        mime: "text/plain",
        inline: `Shared location: ${label ? `${label} ` : ""}(${l.degreesLatitude}, ${l.degreesLongitude}) https://maps.google.com/?q=${l.degreesLatitude},${l.degreesLongitude}`,
      },
    };
  }
  if (m.contactMessage) {
    const c = m.contactMessage;
    return { media: { kind: "contact", mime: "text/vcard", inline: `Shared contact ${c.displayName ?? ""}:\n${c.vcard ?? ""}`.trim() } };
  }
  if (m.contactsArrayMessage) {
    const cs = m.contactsArrayMessage.contacts ?? [];
    return { media: { kind: "contact", mime: "text/vcard", inline: cs.map((c) => `Shared contact ${c.displayName ?? ""}:\n${c.vcard ?? ""}`).join("\n\n").trim() } };
  }
  // Protocol housekeeping, reactions, polls, key distribution: nothing the owner typed.
  return {};
}

/** Decide whether a Baileys message is something the owner told us to act on. Pure; unit-tested. */
export function classify(m: RawMessage, who: Identity, now = Date.now(), maxAgeMs = 30 * 60_000): Verdict {
  const jid = m.key.remoteJid;
  if (!jid || !m.message) return { accept: false, reason: "no jid or content" };
  if (/@(g\.us|broadcast|newsletter)$/.test(jid) || jid === "status@broadcast") return { accept: false, reason: "group/broadcast" };
  if (m.key.participant) return { accept: false, reason: "has participant (group)" };

  const chatUsers = [userPart(jid), userPart(m.key.remoteJidAlt)].filter((x): x is string => !!x);
  const ownerMode = !!who.ownerNumber && !who.selfUsers.includes(who.ownerNumber);

  if (ownerMode) {
    if (m.key.fromMe) return { accept: false, reason: "own message" };
    const ownerUsers = [who.ownerNumber!, ...(who.ownerUsers ?? [])];
    if (!chatUsers.some((u) => ownerUsers.includes(u))) return { accept: false, reason: "not the owner" };
  } else {
    if (!m.key.fromMe) return { accept: false, reason: "not from me" };
    if (!chatUsers.some((u) => who.selfUsers.includes(u))) return { accept: false, reason: "not the self-chat" };
  }

  const ts = tsSeconds(m.messageTimestamp);
  if (ts !== undefined && now - ts * 1000 > maxAgeMs) return { accept: false, reason: "too old" };

  const { text, media } = extractContent(m.message);
  if (text?.startsWith(BOT_MARK.trim())) return { accept: false, reason: "bot echo" };
  if (media) return { accept: true, media, ...(text?.trim() ? { text: text.trim() } : {}) };
  if (text && text.trim()) return { accept: true, text: text.trim() };
  return { accept: false, reason: "protocol/empty message" };
}

/** Markdown -> WhatsApp formatting. */
export function toWhatsApp(s: string): string {
  return s
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)");
}

/** Split into WhatsApp-friendly pieces, preferring paragraph then line breaks. */
export function chunkText(s: string, max = 3500): string[] {
  const out: string[] = [];
  let rest = s.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.4) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.4) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const YES = /^(y|yes|yep|yeah|yup|ok|okay|sure|approve|approved|go|do it|run it|confirm)[.!]*$/i;
const NO = /^(n|no|nope|nah|cancel|deny|denied|stop|don'?t|abort)[.!]*$/i;
export const isYes = (s: string): boolean => YES.test(s.trim());
export const isNo = (s: string): boolean => NO.test(s.trim());

const DISMISS = /^(stop|ok|okay|dismiss|done|off|got it|i'?m up|i am up|awake|thanks?|thx|ty|cancel)[.!]*$/i;
export const isDismiss = (s: string): boolean => DISMISS.test(s.trim());

/** "snooze", "snooze 10", "snooze 10 min" -> minutes (default 10). */
export function parseSnooze(s: string): number | undefined {
  const m = /^snooze(?:\s+(\d{1,3}))?(?:\s*(?:m|min|mins|minutes?))?[.!]*$/i.exec(s.trim());
  if (!m) return undefined;
  return m[1] ? Math.min(240, Math.max(1, Number(m[1]))) : 10;
}
