import { tool, text, type Tool } from "@lmstudio/sdk";
import { z } from "zod";
import { join } from "path";
import { readFile, rename } from "fs/promises";
import { readFileSync, writeFileSync } from "fs";
import type { ToolContext } from "./context";

const DB_FILE = ".memories.db";
const JSON_DB_FILE = ".memories.json";

// ── JSON fallback ─────────────────────────────────────────────────────────────
// Used when better-sqlite3's native binding can't be loaded (e.g. macOS code-
// signing restrictions inside LM Studio's sandboxed process).  Stores memories
// as a JSON file and exposes the same prepare/exec interface as better-sqlite3
// for the exact query patterns used in this module.

interface MemoryRecord { id: number; fact: string; tags: string; created_at: string; updated_at: string; }

class JsonMemoryDb {
  private records: MemoryRecord[] = [];
  private nextId = 1;
  private readonly path: string;

  constructor(filePath: string) {
    this.path = filePath;
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      this.records = data.records ?? [];
      this.nextId = data.nextId ?? (this.records.length ? Math.max(...this.records.map(r => r.id)) + 1 : 1);
    } catch { /* file doesn't exist yet — start empty */ }
  }

  private _save() {
    writeFileSync(this.path, JSON.stringify({ records: this.records, nextId: this.nextId }, null, 2), "utf-8");
  }

  exec(_sql: string): void { /* CREATE TABLE — no-op for JSON backend */ }

  prepare(sql: string) {
    const db = this;
    const s = sql.toLowerCase().trim();
    return {
      run(...args: any[]): { lastInsertRowid: number; changes: number } {
        if (s.startsWith("insert")) {
          const [fact, tags, created_at, updated_at] = args;
          const id = db.nextId++;
          db.records.push({ id, fact, tags, created_at, updated_at });
          db._save();
          return { lastInsertRowid: id, changes: 1 };
        }
        if (s.startsWith("update")) {
          // UPDATE memories SET fact=?, tags=?, updated_at=? WHERE id=?
          const [fact, tags, updated_at, id] = args;
          const rec = db.records.find(r => r.id === id);
          if (rec) { rec.fact = fact; rec.tags = tags; rec.updated_at = updated_at; db._save(); }
          return { lastInsertRowid: 0, changes: rec ? 1 : 0 };
        }
        if (s.startsWith("delete")) {
          const [id] = args;
          const before = db.records.length;
          db.records = db.records.filter(r => r.id !== id);
          if (db.records.length !== before) db._save();
          return { lastInsertRowid: 0, changes: before - db.records.length };
        }
        return { lastInsertRowid: 0, changes: 0 };
      },
      get(...args: any[]): any {
        // SELECT 1 FROM memories WHERE LOWER(fact) = LOWER(?)
        if (s.includes("lower(fact)")) {
          return db.records.find(r => r.fact.toLowerCase() === String(args[0]).toLowerCase().trim()) ?? null;
        }
        // SELECT ... FROM memories WHERE id = ?
        if (s.includes("where id = ?")) {
          return db.records.find(r => r.id === args[0]) ?? null;
        }
        return null;
      },
      all(...args: any[]): any[] {
        let filtered = [...db.records];
        // WHERE tags LIKE ? ... LIMIT ?
        if (s.includes("where tags like ?")) {
          const tag = String(args[0]).replace(/%/g, "").toLowerCase();
          filtered = filtered.filter(r => r.tags.toLowerCase().includes(tag));
          return filtered.sort((a, b) => b.id - a.id).slice(0, Number(args[1]));
        }
        // WHERE fact LIKE ? OR tags LIKE ? ... LIMIT ?
        if (s.includes("where fact like ? or tags like ?")) {
          const q = String(args[0]).replace(/%/g, "").toLowerCase();
          filtered = filtered.filter(r => r.fact.toLowerCase().includes(q) || r.tags.toLowerCase().includes(q));
          return filtered.sort((a, b) => b.id - a.id).slice(0, Number(args[2]));
        }
        // Default ORDER BY id DESC LIMIT ?
        return filtered.sort((a, b) => b.id - a.id).slice(0, Number(args[0]));
      },
    };
  }
}

/**
 * Module-level connection cache keyed by absolute DB path.
 * Keeps a single open connection per workspace so tools don't pay the
 * open/close overhead on every call (PERF-1).  The `migrationDone` flag
 * ensures the legacy memory.md import runs at most once per session.
 */
const _dbCache = new Map<string, { db: any; migrationDone: boolean }>();

/** Return the cached (or freshly opened) database for the given workspace. */
export async function getDb(cwd: string): Promise<{ db: any; migrationDone: boolean }> {
  const dbPath = join(cwd, DB_FILE);
  let entry = _dbCache.get(dbPath);
  if (entry) return entry;

  let db: any;
  try {
    // Use require() rather than dynamic import(): in a CJS-compiled module,
    // `await import()` of a native addon goes through a different resolution
    // path that can fail on some Node versions even when require() works fine.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database: new (path: string) => any = require("better-sqlite3");
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        fact        TEXT    NOT NULL,
        tags        TEXT    NOT NULL DEFAULT '',
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories(tags);
    `);
  } catch {
    // Native binding unavailable — falls back to a JSON-backed store.
    // This happens when the process (e.g. LM Studio's sandboxed runtime)
    // rejects unsigned native addons due to macOS code-signing restrictions.
    db = new JsonMemoryDb(join(cwd, JSON_DB_FILE));
  }

  entry = { db, migrationDone: false };
  _dbCache.set(dbPath, entry);
  return entry;
}

/**
 * N.13: Insert a single auto-captured memory fact into the workspace DB.
 * Tags the row with "auto" so it's distinguishable from manually saved memories.
 * Silently returns if the native binding is unavailable.
 */
export async function insertAutoMemory(cwd: string, fact: string): Promise<void> {
  try {
    const { db } = await getDb(cwd);
    const trimmed = fact.trim();
    // Skip exact duplicates (case-insensitive) to prevent accumulation across sessions.
    const exists = db.prepare(
      "SELECT 1 FROM memories WHERE LOWER(fact) = LOWER(?)"
    ).get(trimmed);
    if (exists) return;
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO memories (fact, tags, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(trimmed, "auto", now, now);
  } catch { /* native binding unavailable or DB locked — skip silently */ }
}

/**
 * One-time migration: if a legacy memory.md exists in the workspace, import
 * its bullet-point entries into SQLite and rename the file so it isn't
 * migrated twice.
 */
async function migrateLegacyFile(cwd: string, db: any): Promise<number> {
  const mdPath = join(cwd, "memory.md");
  let raw: string;
  try {
    raw = await readFile(mdPath, "utf-8");
  } catch {
    return 0; // no legacy file — nothing to do
  }

  const lines = raw.split("\n");
  const insert = db.prepare(
    "INSERT INTO memories (fact, tags, created_at, updated_at) VALUES (?, '', ?, ?)"
  );
  const now = new Date().toISOString();
  let count = 0;

  for (const line of lines) {
    // Match lines like:  - [2024-01-01T00:00:00.000Z] Some fact here
    const m = line.match(/^-\s+\[([^\]]+)\]\s+(.+)$/);
    if (m) {
      const [, ts, fact] = m;
      const created = ts || now;
      insert.run(fact.trim(), created, created);
      count++;
    }
  }

  if (count > 0) {
    await rename(mdPath, join(cwd, "memory.md.migrated"));
  }

  return count;
}

export function createMemoryTools(ctx: ToolContext): Tool[] {
  // Memory disabled — return no tools so they don't appear in the model's tool list.
  // Consistent with gitTools, githubTools, subAgentTools which also return [] when off.
  if (!ctx.enableMemory) return [];

  const tools: Tool[] = [];

  // ─── save_memory ─────────────────────────────────────────────────────────────

  tools.push(tool({
    name: "save_memory",
    description: text`
      Save a specific piece of information or fact to long-term memory.
      Memories persist across conversations and can be tagged for organisation.
      Use this for user preferences, project details, or any fact that should
      be retrievable later.
    `,
    parameters: {
      fact: z.string().describe("The fact or piece of information to remember."),
      tags: z.string().optional().describe("Optional comma-separated tags (e.g. 'preference,ui')."),
    },
    implementation: async ({ fact, tags = "" }) => {

      try {
        const entry = await getDb(ctx.cwd);
        let migrated = 0;
        if (!entry.migrationDone) {
          migrated = await migrateLegacyFile(ctx.cwd, entry.db);
          entry.migrationDone = true;
        }
        const trimmedFact = fact.trim();
        const existing: any = entry.db.prepare(
          "SELECT id, fact, tags FROM memories WHERE LOWER(fact) = LOWER(?)"
        ).get(trimmedFact);
        if (existing) {
          return { success: true, id: existing.id, fact: existing.fact, tags: existing.tags, deduplicated: true, message: "This fact is already stored (ID " + existing.id + "). Use update_memory to change it." };
        }
        const now = new Date().toISOString();
        const result = entry.db.prepare(
          "INSERT INTO memories (fact, tags, created_at, updated_at) VALUES (?, ?, ?, ?)"
        ).run(trimmedFact, tags.trim(), now, now);
        const note = migrated > 0 ? ` (also migrated ${migrated} entries from legacy memory.md)` : "";
        return { success: true, id: result.lastInsertRowid, fact: trimmedFact, tags: tags.trim(), created_at: now, note };
      } catch (e) {
        return { error: `Failed to save memory: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  }));

  // ─── list_memories ────────────────────────────────────────────────────────────

  tools.push(tool({
    name: "list_memories",
    description: text`
      List stored memories. Optionally filter by tag.
      Returns each memory's ID, fact, tags, and timestamps.
      Use the ID with delete_memory or update_memory.
    `,
    parameters: {
      tag: z.string().optional().describe("Filter to memories that include this tag."),
      limit: z.number().int().min(1).max(200).optional().describe("Max entries to return (default: 50)."),
    },
    implementation: async ({ tag, limit = 50 }) => {

      try {
        const { db, migrationDone } = await getDb(ctx.cwd);
        if (!migrationDone) { await migrateLegacyFile(ctx.cwd, db); _dbCache.get(join(ctx.cwd, DB_FILE))!.migrationDone = true; }
        const rows: any[] = tag
          ? db.prepare("SELECT id, fact, tags, created_at, updated_at FROM memories WHERE tags LIKE ? ORDER BY id DESC LIMIT ?").all(`%${tag}%`, limit)
          : db.prepare("SELECT id, fact, tags, created_at, updated_at FROM memories ORDER BY id DESC LIMIT ?").all(limit);
        return { count: rows.length, memories: rows };
      } catch (e) {
        return { error: `Failed to list memories: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  }));

  // ─── search_memories ──────────────────────────────────────────────────────────

  tools.push(tool({
    name: "search_memories",
    description: text`
      Search stored memories by keyword. Matches against both the fact text
      and any tags. Case-insensitive. Returns results ranked by recency.
    `,
    parameters: {
      query: z.string().describe("Keyword or phrase to search for."),
      limit: z.number().int().min(1).max(50).optional().describe("Max results to return (default: 10)."),
    },
    implementation: async ({ query, limit = 10 }) => {

      try {
        const { db, migrationDone } = await getDb(ctx.cwd);
        if (!migrationDone) { await migrateLegacyFile(ctx.cwd, db); _dbCache.get(join(ctx.cwd, DB_FILE))!.migrationDone = true; }
        const pattern = `%${query}%`;
        const rows = db.prepare(
          "SELECT id, fact, tags, created_at, updated_at FROM memories WHERE fact LIKE ? OR tags LIKE ? ORDER BY id DESC LIMIT ?"
        ).all(pattern, pattern, limit);
        return { query, count: rows.length, memories: rows };
      } catch (e) {
        return { error: `Failed to search memories: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  }));

  // ─── update_memory ────────────────────────────────────────────────────────────

  tools.push(tool({
    name: "update_memory",
    description: text`
      Update the fact text and/or tags of an existing memory by its ID.
      Use list_memories or search_memories to find the ID first.
    `,
    parameters: {
      id: z.number().int().describe("The ID of the memory to update."),
      fact: z.string().optional().describe("New fact text (omit to keep existing)."),
      tags: z.string().optional().describe("New tags (omit to keep existing)."),
    },
    implementation: async ({ id, fact, tags }) => {

      if (fact === undefined && tags === undefined) {
        return { error: "Provide at least one of 'fact' or 'tags' to update." };
      }
      try {
        const { db } = await getDb(ctx.cwd);
        const existing: any = db.prepare("SELECT id, fact, tags FROM memories WHERE id = ?").get(id);
        if (!existing) return { error: `No memory found with ID ${id}.` };
        const newFact = fact !== undefined ? fact.trim() : existing.fact;
        const newTags = tags !== undefined ? tags.trim() : existing.tags;
        const now = new Date().toISOString();
        db.prepare("UPDATE memories SET fact = ?, tags = ?, updated_at = ? WHERE id = ?").run(newFact, newTags, now, id);
        return { success: true, id, fact: newFact, tags: newTags, updated_at: now };
      } catch (e) {
        return { error: `Failed to update memory: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  }));

  // ─── delete_memory ────────────────────────────────────────────────────────────

  tools.push(tool({
    name: "delete_memory",
    description: text`
      Permanently delete a memory by its ID.
      Use list_memories or search_memories to find the ID first.
    `,
    parameters: {
      id: z.number().int().describe("The ID of the memory to delete."),
    },
    implementation: async ({ id }) => {

      try {
        const { db } = await getDb(ctx.cwd);
        const existing: any = db.prepare("SELECT fact FROM memories WHERE id = ?").get(id);
        if (!existing) return { error: `No memory found with ID ${id}.` };
        db.prepare("DELETE FROM memories WHERE id = ?").run(id);
        return { success: true, deleted_id: id, deleted_fact: existing.fact };
      } catch (e) {
        return { error: `Failed to delete memory: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  }));

  return tools;
}
