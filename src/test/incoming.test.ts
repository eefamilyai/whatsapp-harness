import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_MARK, chunkText, classify, isDismiss, isYes, parseSnooze, toWhatsApp, type Identity, type RawMessage } from "../incoming.js";

const self: Identity = { selfUsers: ["6591111111", "99887766554433"] };
const now = Date.now();
const msg = (over: Partial<RawMessage["key"]>, text: string | null = "hello", ts = Math.floor(now / 1000)): RawMessage => ({
  key: { id: "A1", remoteJid: "6591111111@s.whatsapp.net", fromMe: true, ...over },
  message: text === null ? {} : { conversation: text },
  messageTimestamp: ts,
});

test("self-chat: accepts my own message in my own chat (phone or LID addressed)", () => {
  assert.deepEqual(classify(msg({}), self, now), { accept: true, text: "hello" });
  assert.deepEqual(classify(msg({ remoteJid: "99887766554433@lid" }), self, now), { accept: true, text: "hello" });
  assert.deepEqual(classify(msg({ remoteJid: "x@lid", remoteJidAlt: "6591111111@s.whatsapp.net" }), self, now), { accept: true, text: "hello" });
});

test("self-chat: ignores other chats, groups, incoming messages and its own echoes", () => {
  assert.equal(classify(msg({ remoteJid: "6592222222@s.whatsapp.net" }), self, now).accept, false);
  assert.equal(classify(msg({ remoteJid: "123-456@g.us" }), self, now).accept, false);
  assert.equal(classify(msg({ remoteJid: "status@broadcast" }), self, now).accept, false);
  assert.equal(classify(msg({ fromMe: false }), self, now).accept, false);
  assert.equal(classify(msg({}, `${BOT_MARK}reply text`), self, now).accept, false);
});

test("ignores stale messages and empty protocol messages", () => {
  assert.equal(classify(msg({}, "old", Math.floor(now / 1000) - 3600), self, now, 30 * 60_000).accept, false);
  assert.equal(classify(msg({}, null), self, now).accept, false);
});

test("every attachment kind is described; captions travel with the media", () => {
  const v = (message: RawMessage["message"]) => classify({ ...msg({}), message }, self, now) as { accept: true; text?: string; media?: any };
  assert.deepEqual(v({ audioMessage: { ptt: true, seconds: 7, mimetype: "audio/ogg; codecs=opus" } }).media, { kind: "audio", mime: "audio/ogg", sizeBytes: undefined, seconds: 7, voiceNote: true });
  const img = v({ imageMessage: { caption: "what is this", mimetype: "image/jpeg", fileLength: 1234 } });
  assert.equal(img.media.kind, "image");
  assert.equal(img.media.caption, "what is this");
  assert.equal(img.media.sizeBytes, 1234);
  assert.equal(v({ imageMessage: {} }).media.caption, undefined);
  assert.equal(v({ stickerMessage: { mimetype: "image/webp" } }).media.kind, "sticker");
  const vid = v({ videoMessage: { seconds: 12, gifPlayback: true, caption: "lol" } });
  assert.deepEqual([vid.media.kind, vid.media.gif, vid.media.seconds, vid.media.caption], ["video", true, 12, "lol"]);
  const doc = v({ documentMessage: { fileName: "cv.pdf", mimetype: "application/pdf", pageCount: 2, caption: "summarise" } });
  assert.deepEqual([doc.media.kind, doc.media.fileName, doc.media.pages, doc.media.caption], ["document", "cv.pdf", 2, "summarise"]);
  assert.match(v({ locationMessage: { degreesLatitude: 1.3, degreesLongitude: 103.8, name: "Cafe" } }).media.inline, /Cafe.*1\.3, 103\.8.*maps\.google/);
  assert.match(v({ contactMessage: { displayName: "Bob", vcard: "BEGIN:VCARD" } }).media.inline, /Bob/);
  assert.equal(v({ viewOnceMessage: { message: { imageMessage: { caption: "secret" } } } }).media.caption, "secret");
  const ext = v({ extendedTextMessage: { text: "link https://x.y" } });
  assert.deepEqual([ext.text, ext.media], ["link https://x.y", undefined]);
  // reactions and protocol messages are not something the owner typed
  assert.equal(classify({ ...msg({}), message: { reactionMessage: { text: "👍" } } }, self, now).accept, false);
  assert.equal(classify({ ...msg({}), message: { protocolMessage: {} } }, self, now).accept, false);
});

test("owner mode: only the owner's number, never fromMe", () => {
  const owner: Identity = { selfUsers: ["6590000000"], ownerNumber: "6591111111" };
  const fromOwner = msg({ fromMe: false });
  assert.equal(classify(fromOwner, owner, now).accept, true);
  assert.equal(classify(msg({ fromMe: false, remoteJid: "6592222222@s.whatsapp.net" }), owner, now).accept, false);
  assert.equal(classify(msg({ fromMe: true }), owner, now).accept, false);
  assert.equal(classify(msg({ fromMe: false, remoteJid: "abc@lid", remoteJidAlt: "6591111111@s.whatsapp.net" }), owner, now).accept, true);
});

test("owner number equal to the linked account stays self-chat mode", () => {
  const same: Identity = { selfUsers: ["6591111111"], ownerNumber: "6591111111" };
  assert.equal(classify(msg({}), same, now).accept, true);
  assert.equal(classify(msg({ fromMe: false }), same, now).accept, false);
});

test("alarm / approval phrases", () => {
  assert.ok(isDismiss("Stop") && isDismiss("ok") && isDismiss("I'm up!"));
  assert.ok(!isDismiss("stop the music at 5pm tomorrow"));
  assert.equal(parseSnooze("snooze"), 10);
  assert.equal(parseSnooze("Snooze 5 min"), 5);
  assert.equal(parseSnooze("snooze 999"), 240);
  assert.equal(parseSnooze("snooze me later please"), undefined);
  assert.ok(isYes("yes") && isYes("Y") && !isYes("yes but add -r"));
});

test("formatting and chunking", () => {
  assert.equal(toWhatsApp("# Title\n**bold** and [site](https://a.b)"), "*Title*\n*bold* and site (https://a.b)");
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${"x".repeat(200)}`).join("\n\n");
  const parts = chunkText(long, 3500);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 3500));
  assert.equal(parts.join("\n\n").replace(/\s+/g, ""), long.replace(/\s+/g, ""));
  assert.deepEqual(chunkText("short"), ["short"]);
});
