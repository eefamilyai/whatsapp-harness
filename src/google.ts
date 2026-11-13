import fs from "node:fs";
import { config } from "./config.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

interface ClientFile {
  client_id: string;
  client_secret: string;
}
interface TokenFile {
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
}

export function readClient(): ClientFile {
  let raw: { installed?: ClientFile; web?: ClientFile };
  try {
    raw = JSON.parse(fs.readFileSync(config.google.clientFile, "utf8"));
  } catch {
    throw new Error(`Google client file not found at ${config.google.clientFile}. See README "Google Calendar".`);
  }
  const c = raw.installed ?? raw.web;
  if (!c?.client_id || !c.client_secret) throw new Error("google-client.json has no installed/web client_id and client_secret.");
  return c;
}

export function isConfigured(): boolean {
  return fs.existsSync(config.google.clientFile) && fs.existsSync(config.google.tokenFile);
}

export function saveToken(t: TokenFile): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(config.google.tokenFile, JSON.stringify(t, null, 2), { mode: 0o600 });
}

async function accessToken(): Promise<string> {
  if (!isConfigured()) throw new Error("Google Calendar is not connected. Run `npm run google-auth` once (see README).");
  const token = JSON.parse(fs.readFileSync(config.google.tokenFile, "utf8")) as TokenFile;
  if (token.access_token && token.expires_at && token.expires_at > Date.now() + 60_000) return token.access_token;
  const c = readClient();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.client_id,
      client_secret: c.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) {
    if (j.error === "invalid_grant") {
      throw new Error(
        "Google rejected the saved login (invalid_grant). If the OAuth app is in 'Testing' mode the login expires after 7 days; publish it to 'In production' and run `npm run google-auth` again.",
      );
    }
    throw new Error(`Google token refresh failed: ${j.error_description ?? j.error ?? res.status}`);
  }
  saveToken({ ...token, access_token: j.access_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

export async function gcal<T>(method: string, path: string, query?: Record<string, string>, body?: unknown): Promise<T> {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.google.calendarId)}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* keep raw */
    }
    throw new Error(`Google Calendar HTTP ${res.status}: ${msg}`);
  }
  return JSON.parse(text) as T;
}
