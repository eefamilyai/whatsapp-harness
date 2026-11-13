// Builds release/whatsapp-harness.zip (what install.bat downloads) and release/install.bat.
// Run: npm run package   (after npm run build)
import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "release");
fs.mkdirSync(out, { recursive: true });

const files = {};
const add = (rel, data = fs.readFileSync(path.join(root, rel))) => {
  files[rel.split(path.sep).join("/")] = [new Uint8Array(data), { level: 9 }];
};

function walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "test") continue; // compiled tests are not shipped
      walk(rel);
    } else if (!e.name.endsWith(".map")) add(rel);
  }
}

if (!fs.existsSync(path.join(root, "dist", "index.js"))) throw new Error("dist/ is missing: run npm run build first");
walk("dist");
for (const f of ["package.json", "package-lock.json", ".env.example", "run.bat", "install.bat", "README.md", path.join("deploy", "whatsapp-harness.service")]) add(f);

const zip = zipSync(files);
fs.writeFileSync(path.join(out, "whatsapp-harness.zip"), zip);
fs.copyFileSync(path.join(root, "install.bat"), path.join(out, "install.bat"));
console.log(`release/whatsapp-harness.zip  ${(zip.length / 1024).toFixed(0)} KB, ${Object.keys(files).length} files`);
