import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/** A tiny JSON-file store with atomic writes (write temp, then rename). */
export class JsonStore<T> {
  private value: T;
  private readonly file: string;

  constructor(name: string, private readonly fallback: () => T) {
    this.file = path.join(config.dataDir, name);
    this.value = this.load();
  }

  private load(): T {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as T;
    } catch {
      return this.fallback();
    }
  }

  get data(): T {
    return this.value;
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
