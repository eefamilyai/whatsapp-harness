# whatsapp-harness

A personal assistant you talk to on WhatsApp. Message yourself ("Message yourself" chat) and an LLM with tools answers:
web search, shell commands, reminders, alarms, scheduled tasks, Google Calendar, and it can read what you send it:
photos, stickers, PDFs, Word/Excel/PowerPoint, text and code files, voice notes and videos.

WhatsApp only, one user (you). Default model: **DeepSeek Flash** (`deepseek-flash`).

## Install on a Windows machine / server (one step)

In a terminal on that machine (cmd or PowerShell, also over SSH):

```bat
curl.exe -L -o install.bat https://github.com/eefamilyai/whatsapp-harness/releases/latest/download/install.bat && install.bat
```

It installs Node.js privately if needed (no admin), downloads the latest release, asks for your **DeepSeek API key**, links WhatsApp (QR code, or an 8-character pairing code if you type your number), and registers a startup task that restarts the bot if it crashes.
Run `%USERPROFILE%\whatsapp-harness\install.bat` again any time to **update**; your `.env`, WhatsApp login and reminders are kept.
Options: `install.bat <api-key> /dir:D:\bot /nolink /notask`.

Then open **Message yourself** in WhatsApp and send `/help`.

## What you can send it

| You send | What happens |
|---|---|
| Text | Normal conversation with tools |
| Photo, sticker | Seen directly by DeepSeek Flash (JPEG/PNG/GIF/WebP) |
| PDF | Text extracted locally, page by page |
| Word (.docx), Excel (.xlsx), PowerPoint (.pptx) | Text/cells/slides extracted locally |
| .txt .md .csv .json .log, source code, ... | Read as text |
| Long document | First ~30k characters in the chat; the rest via `read_attachment` |
| Location, contact card | Passed as text |
| Voice note, audio | Transcribed (needs `GEMINI_API_KEY`) and treated as your message |
| Video, GIF | Described and transcribed (needs `GEMINI_API_KEY`, up to ~18 MB) |
| Scanned PDF | Read by Gemini if a key is set, otherwise send photos of the pages |
| .doc/.xls (old formats), zips | Politely refused, with what to do instead |

DeepSeek has no audio or video input, which is why voice and video use Gemini. A free key from aistudio.google.com/apikey is enough; put it in `.env` as `GEMINI_API_KEY`. Everything else works with the DeepSeek key alone.
Attachments are kept in `data/media` for 14 days so you can ask follow-ups ("what was the second number on that photo?").

## Commands

Send these in the chat; they answer instantly and don't use the LLM.

| Command | |
|---|---|
| `/help` `[command]` | list commands, or explain one |
| `/status` | model, time zone, shell mode, what's connected |
| `/settings` `[reset]` | show what can be changed (`reset` = back to `.env` values) |
| `/model` `[id]` | change the model, e.g. `/model deepseek-v4-pro` |
| `/thinking` `[off\|low\|high\|max\|default]` | DeepSeek reasoning effort (default off: faster, cheaper) |
| `/shell` `[confirm\|auto\|off]` | may the assistant run commands on the host? `confirm` asks yes/no each time |
| `/timezone` `[Area/City]` | e.g. `/timezone Europe/London` |
| `/vision` `[on\|off]` | send images to the chat model |
| `/alarm` `[repeat <sec> \| pings <n>]` | how persistently an unanswered alarm rings |
| `/reminders`, `/cancel <id>` | list / delete reminders, alarms, scheduled tasks |
| `/notes`, `/forget <n>` | what it remembers about you |
| `/reset` | clear the conversation (keeps reminders, notes, settings) |

While an alarm rings: `stop` or `snooze 10`. Changes persist in `data/settings.json`. The API key and the WhatsApp number cannot be changed from chat, on purpose.

Try: `remind me to call mum tomorrow 6pm`, `alarm 6:45 on weekdays`, `what's the weather in Singapore`, `every weekday 8am give me my calendar and the weather`, `how much disk is free?`, or send a PDF and say `summarise`.

## Notifications: read this before relying on reminders

In **self-chat mode** the bot is *you*, as a linked device. WhatsApp may not buzz your phone for messages "you" sent from a linked device, so a reminder could land silently. Check once: set a reminder 2 minutes ahead with the phone locked.
If it doesn't buzz, use **owner mode**: link the bot to a *different* WhatsApp number (spare SIM / WhatsApp Business app) and set `OWNER_NUMBER=<your own number>` in `.env`. You then chat with the bot's number like a normal contact, only your number is read, and every reminder is a real incoming message.

## Configuration

`%USERPROFILE%\whatsapp-harness\.env`, fully commented in [.env.example](.env.example). Restart after editing: `schtasks /end /tn WhatsAppHarness` then `schtasks /run /tn WhatsAppHarness`.

State lives in `data/`: `auth/` (the WhatsApp login: treat it like a password), `reminders.json`, `history.json`, `notes.json`, `settings.json`, `media/`, `bot.log`.

## Google Calendar (optional)

1. console.cloud.google.com > create a project > **APIs & Services > Library** > enable **Google Calendar API**.
2. **OAuth consent screen**: user type External, add yourself as a test user. Then **publish the app ("In production")**; a personal, unverified app is fine. Left in *Testing*, Google expires the login every 7 days.
3. **Credentials > Create credentials > OAuth client ID > Desktop app**. Download the JSON as `data/google-client.json`.
4. On a machine with a browser (this repo, `npm install && npm run build`): `npm run google-auth`, approve. It writes `data/google-token.json`.
5. Copy both files into the server's `data\` folder.

Scope requested: `calendar.events` only. `GOOGLE_CALENDAR_ID` picks another calendar than `primary`.

## Architecture

```
WhatsApp <-> Baileys (src/whatsapp.ts) -> only the owner's chat passes (src/incoming.ts)
   attachments -> src/media.ts (images -> model, PDF/Office/text -> text, audio/video -> Gemini)
   /commands  -> src/commands.ts, src/settings.ts                      (no LLM)
   "stop" / "yes"                                                       (no LLM)
   everything else -> agent loop (src/agent.ts) <-> OpenAI-compatible LLM (src/llm.ts)
        tools: web_search web_fetch shell set_reminder set_alarm schedule_task
               list/update/cancel_reminder calendar_* remember/forget get_time
               read_attachment analyze_attachment
   scheduler (src/scheduler.ts, every 5 s) -> sends reminders/alarms back over WhatsApp
```

## Safety model

- **Only your own chat is read.** Groups, broadcasts and anyone else's messages are dropped before the LLM sees them (`classify()` and its tests).
- The shell tool can do anything the bot's OS user can. In `confirm` mode (default) every command is shown to you first. Keep it that way unless you have a reason; `/shell auto` removes the question.
- A malicious web page, PDF or image can contain text aimed at the model. `confirm` mode is what stops that from running commands unseen.
- Anyone with your phone or your linked-device session controls the bot. Keep `data\auth` and `.env` private.
- This uses the unofficial WhatsApp Web protocol (Baileys). A personal bot that only talks to you is low risk, not zero. Don't use a number you can't afford to lose.

## Development

```powershell
npm install
npm run build
npm test            # builds, then node --test
npm run package     # release/whatsapp-harness.zip + release/install.bat
node dist/index.js --link   # link WhatsApp only, then exit
```

Add a tool: create a `Tool` (name, description, JSON-schema `parameters`, `run`) and add it to the list in `src/index.ts`.
Linux: run `node dist/index.js` under systemd, see [deploy/whatsapp-harness.service](deploy/whatsapp-harness.service).
