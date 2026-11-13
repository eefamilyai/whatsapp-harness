import { Boom } from "@hapi/boom";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { config } from "./config.js";
import { BOT_MARK, chunkText, classify, toWhatsApp, userPart, type Identity, type MediaInfo, type RawMessage } from "./incoming.js";
import { log } from "./log.js";

export interface IncomingMessage {
  text?: string;
  /** An attachment (image, sticker, voice note, video, document, location, contact). */
  media?: MediaInfo;
  /** Fetches the attachment's bytes (not set for location/contact). */
  download?: () => Promise<Buffer>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WhatsApp {
  private sock?: WASocket;
  private connected = false;
  private stopping = false;
  private retry = 0;
  private pairingRequested = false;
  private readonly sentIds = new Set<string>();
  private readonly seenIds = new Set<string>();
  onMessage: (m: IncomingMessage) => void = () => undefined;
  /** Fires each time the connection opens. */
  onConnected: () => void = () => undefined;
  private logger = pino({ level: "warn" });

  /** Self-chat mode = the bot is logged into the owner's own account. */
  private selfMode(): boolean {
    return !config.ownerNumber || config.ownerNumber === userPart(this.sock?.user?.id);
  }

  /** The linked account's JID, once connected. */
  user(): string | undefined {
    return this.sock?.user?.id;
  }

  online(): boolean {
    return this.connected && !!this.sock;
  }

  /** JID the bot sends to: your own chat (self mode) or the owner's number. */
  ownerJid(): string {
    if (!this.sock?.user) throw new Error("WhatsApp is not connected yet");
    return this.selfMode() ? jidNormalizedUser(this.sock.user.id) : `${config.ownerNumber}@s.whatsapp.net`;
  }

  async start(): Promise<void> {
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.sock?.end(undefined);
  }

  async send(text: string): Promise<void> {
    const sock = this.sock;
    if (!sock || !this.connected) throw new Error("WhatsApp is offline");
    const jid = this.ownerJid();
    const prefix = this.selfMode() ? BOT_MARK : "";
    for (const part of chunkText(toWhatsApp(text))) {
      const sent = await sock.sendMessage(jid, { text: `${prefix}${part}` });
      if (sent?.key.id) {
        this.sentIds.add(sent.key.id);
        if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value!);
      }
    }
  }

  async typing(on: boolean): Promise<void> {
    try {
      if (this.sock && this.connected) await this.sock.sendPresenceUpdate(on ? "composing" : "paused", this.ownerJid());
    } catch {
      /* cosmetic */
    }
  }

  private identity(): Identity {
    const u = this.sock?.user;
    const selfUsers = [userPart(u?.id), userPart(u?.lid)].filter((x): x is string => !!x);
    return { selfUsers, ownerNumber: config.ownerNumber || undefined };
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch (err) {
      log.warn(`could not fetch latest WhatsApp Web version, using the bundled one: ${(err as Error).message}`);
    }
    const logger = pino({ level: config.logLevel === "debug" ? "debug" : "warn" });
    this.logger = logger;
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.macOS("Desktop"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async () => undefined,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        if (config.pairingNumber && !state.creds.registered) {
          if (!this.pairingRequested) {
            this.pairingRequested = true;
            sock
              .requestPairingCode(config.pairingNumber)
              .then((code) => {
                log.info(`\nPairing code: ${code}\nWhatsApp > Settings > Linked devices > Link a device > "Link with phone number instead".\n`);
              })
              .catch((err) => log.error("could not get a pairing code", err as Error));
          }
        } else {
          log.info("Scan this QR with WhatsApp > Settings > Linked devices > Link a device:");
          qrcode.generate(qr, { small: true });
        }
      }
      if (connection === "open") {
        this.connected = true;
        this.retry = 0;
        this.pairingRequested = false;
        log.info(`WhatsApp connected as ${sock.user?.id} (${this.selfMode() ? "self-chat mode" : `owner ${config.ownerNumber}`})`);
        this.onConnected();
      }
      if (connection === "close") {
        this.connected = false;
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        if (this.stopping) return;
        if (code === DisconnectReason.loggedOut) {
          log.error(`WhatsApp logged this device out. Delete ${config.authDir} and start again to re-link.`);
          process.exit(2); // run.bat does not restart on 2
        }
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(30_000, 2_000 * 2 ** this.retry++);
        log.warn(`WhatsApp connection closed (code ${code ?? "?"}); reconnecting in ${Math.round(delay / 1000)}s`);
        void sleep(delay).then(() => this.connect().catch((err) => log.error("reconnect failed", err as Error)));
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      for (const m of messages as RawMessage[]) void this.handleUpsert(sock, m, type);
    });
  }

  private async handleUpsert(sock: WASocket, m: RawMessage, type: string): Promise<void> {
    try {
      const id = m.key.id;
      if (!id || this.sentIds.has(id) || this.seenIds.has(id)) return;
      // A message from the owner's number can arrive addressed by LID with no phone number attached.
      const jid = m.key.remoteJid;
      if (jid?.endsWith("@lid") && !m.key.remoteJidAlt && !m.key.fromMe) {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(jid).catch(() => null);
        if (pn) m.key.remoteJidAlt = pn;
      }
      const verdict = classify(m, this.identity(), Date.now(), config.maxMessageAgeMs);
      if (!verdict.accept) {
        log.debug(`ignored ${type} message ${id}: ${verdict.reason}`);
        return;
      }
      this.seenIds.add(id);
      if (this.seenIds.size > 1000) this.seenIds.delete(this.seenIds.values().next().value!);
      const media = verdict.media;
      log.info(media ? `incoming ${media.kind}${media.fileName ? ` "${media.fileName}"` : ""}${media.sizeBytes ? ` (${Math.round(media.sizeBytes / 1024)} KB)` : ""}` : `incoming text (${verdict.text?.length ?? 0} chars)`);
      this.onMessage({
        ...(verdict.text !== undefined ? { text: verdict.text } : {}),
        ...(media ? { media } : {}),
        ...(media && !media.inline
          ? { download: () => downloadMediaMessage(m as WAMessage, "buffer", {}, { logger: this.logger, reuploadRequest: sock.updateMediaMessage }) as Promise<Buffer> }
          : {}),
      });
    } catch (err) {
      log.error("failed to handle an incoming message", err as Error);
    }
  }
}
