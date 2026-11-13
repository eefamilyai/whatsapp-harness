import { JsonStore } from "./store.js";

/** Long-term memory: short facts the assistant should always know about the user. */
interface Db {
  notes: { id: number; text: string; at: number }[];
  nextId: number;
}
const store = new JsonStore<Db>("notes.json", () => ({ notes: [], nextId: 1 }));

export function all(): Db["notes"] {
  return store.data.notes;
}
export function add(text: string): number {
  const id = store.data.nextId++;
  store.data.notes.push({ id, text: text.trim(), at: Date.now() });
  store.save();
  return id;
}
export function remove(id: number): boolean {
  const i = store.data.notes.findIndex((n) => n.id === id);
  if (i < 0) return false;
  store.data.notes.splice(i, 1);
  store.save();
  return true;
}
