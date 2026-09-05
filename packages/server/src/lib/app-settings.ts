import { db } from "../db/index.js";

export const appSettings = {
  get(key: string): string | null {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as any;
    return row?.value ?? null;
  },

  set(key: string, value: string): void {
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  },
};
