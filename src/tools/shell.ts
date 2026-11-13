import { spawn } from "node:child_process";
import fs from "node:fs";
import { config } from "../config.js";
import { clip, num, str, type Tool } from "./types.js";

function shellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command] };
  }
  return { file: "bash", args: ["-lc", command] };
}

export const shell: Tool = {
  name: "shell",
  description: `Run a ${process.platform === "win32" ? "PowerShell" : "bash"} command on the machine hosting this assistant and return its output (stdout+stderr, exit code). Depending on the owner's setting they may be asked to approve the command over WhatsApp first, and it may be disabled. Non-interactive only. Default timeout 60s.`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string", description: "Working directory (default: configured shell dir)." },
      timeout_seconds: { type: "integer", description: "1-300, default 60" },
    },
    required: ["command"],
  },
  async run(args, ctx) {
    if (config.shell.mode === "off") throw new Error("The shell tool is switched off. The owner can enable it with /shell confirm.");
    const command = str(args.command);
    if (!command) throw new Error("command is required");
    const cwd = str(args.cwd) ?? config.shell.cwd;
    if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
    const timeout = Math.min(300, Math.max(1, Math.round(num(args.timeout_seconds) ?? 60))) * 1000;

    if (config.shell.mode === "confirm") {
      const ok = await ctx.confirm(`Run this ${process.platform === "win32" ? "PowerShell" : "shell"} command?\n\n\`\`\`${command}\`\`\`\ncwd: ${cwd}\n\nReply *yes* or *no*.`);
      if (!ok) return "The user declined to run this command. Do not retry it; ask what they want instead.";
    }

    const { file, args: argv } = shellCommand(command);
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(file, argv, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let killed = false;
      const cap = (b: Buffer) => {
        out += b.toString("utf8");
        if (out.length > 200_000) out = out.slice(-100_000);
      };
      child.stdout.on("data", cap);
      child.stderr.on("data", cap);
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, timeout);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Could not start ${file}: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const tail = out.length > 6000 ? `[output truncated, showing the last 6000 chars]\n${out.slice(-6000)}` : out;
        resolve(`${killed ? `[killed after ${timeout / 1000}s timeout]\n` : ""}${tail.trim() || "(no output)"}\n[exit code ${code}]`);
      });
    });
  },
};
