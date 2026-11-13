// One-time Google Calendar login. Run on a machine with a browser: `npm run google-auth`,
// then copy data/google-token.json to the server (see README).
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { readClient, saveToken, SCOPES } from "../google.js";
import { config } from "../config.js";

const client = readClient();
const state = randomBytes(16).toString("hex");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/") {
    res.writeHead(404).end();
    return;
  }
  const err = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (err || !code || url.searchParams.get("state") !== state) {
    res.writeHead(400, { "content-type": "text/plain" }).end(`Login failed: ${err ?? "bad state or missing code"}`);
    console.error(`Login failed: ${err ?? "bad state or missing code"}`);
    process.exit(1);
  }
  const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const j = (await tokenRes.json()) as { refresh_token?: string; access_token?: string; expires_in?: number; error_description?: string };
  if (!tokenRes.ok || !j.refresh_token) {
    const msg = j.error_description ?? "no refresh_token returned (revoke the app at myaccount.google.com/permissions and retry)";
    res.writeHead(500, { "content-type": "text/plain" }).end(msg);
    console.error(msg);
    process.exit(1);
  }
  saveToken({ refresh_token: j.refresh_token, access_token: j.access_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 });
  res.writeHead(200, { "content-type": "text/plain" }).end("Done. You can close this tab and go back to the terminal.");
  console.log(`\nSaved ${config.google.tokenFile}. Copy that file to the server's data/ folder.`);
  server.close();
  process.exit(0);
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: `http://127.0.0.1:${port}`,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  console.log(`Open this URL in a browser and approve access:\n\n${auth.toString()}\n`);
  const opener = process.platform === "win32" ? `start "" "${auth}"` : process.platform === "darwin" ? `open "${auth}"` : `xdg-open "${auth}"`;
  exec(opener, () => undefined);
});
