import { tool, text, type Tool } from "@lmstudio/sdk";
import { z } from "zod";
import { join } from "path";
import { readFile, rename } from "fs/promises";
import type { ToolContext } from "./context";

const DB_FILE = ".memories.db";
const DISABLED_MSG = "Memory is currently disabled in the plugin settings. Please ask the user to enable 'Enable Memory' in the plugin settings.";

/** Open (or create) the SQLite memory database and ensure the schema exists. */
async function openDb(cwd: string): Promise<any> {
  // Use require() rather than dynamic import(): in a CJS-compiled module,
  // `await import()` of a native addon goes through a different resolution
  // path that can fail on some Node versions even when require() works fine.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database: new (path: string) => any = require("better-sqlite3");
  const db = new Database(join(cwd, DB_FILE));
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
  return db;
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
      if (!ctx.enableMemory) return { error: DISABLED_MSG };
      try {
        const db = await openDb(ctx.cwd);
        const migrated = await migrateLegacyFile(ctx.cwd, db);
        const now = new Date().toISOString();
        const stmt = db.prepare(
          "INSERT INTO memories (fact, tags, created_at, updated_at) VALUES (?, ?, ?, ?)"
        );
        const result = stmt.run(fact.trim(), tags.trim(), now, now);
        db.close();
        const note = migrated > 0 ? ` (also migrated ${migrated} entries from legacy memory.md)` : "";
        return { success: true, id: result.lastInsertRowid, fact, tags, created_at: now, note };
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
      if (!ctx.enableMemory) return { error: DISABLED_MSG };
      try {
        const db = await openDb(ctx.cwd);
        await migrateLegacyFile(ctx.cwd, db);
        let rows: any[];
        if (tag) {
          rows = db.prepare(
            "SELECT id, fact, tags, created_at, updated_at FROM memories WHERE tags LIKE ? ORDER BY id DESC LIMIT ?"
          ).all(`%${tag}%`, limit);
        } else {
          rows = db.prepare(
            "SELECT id, fact, tags, created_at, updated_at FROM memories ORDER BY id DESC LIMIT ?"
          ).all(limit);
        }
        db.close();
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
      if (!ctx.enableMemory) return { error: DISABLED_MSG };
      try {
        const db = await openDb(ctx.cwd);
        await migrateLegacyFile(ctx.cwd, db);
        const pattern = `%${query}%`;
        const rows = db.prepare(
          `SELECT id, fact, tags, created_at, updated_at
           FROM memories
           WHERE fact LIKE ? OR tags LIKE ?
           ORDER BY id DESC
           LIMIT ?`
        ).all(pattern, pattern, limit);
        db.close();
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
      if (!ctx.enableMemory) return { error: DISABLED_MSG };
      if (fact === undefined && tags === undefined) {
        return { error: "Provide at least one of 'fact' or 'tags' to update." };
      }
      try {
        const db = await openDb(ctx.cwd);
        const existing: any = db.prepare(
          "SELECT id, fact, tags FROM memories WHERE id = ?"
        ).get(id);
        if (!existing) {
          db.close();
          return { error: `No memory found with ID ${id}.` };
        }
        const newFact = fact !== undefined ? fact.trim() : existing.fact;
        const newTags = tags !== undefined ? tags.trim() : existing.tags;
        const now = new Date().toISOString();
        db.prepare(
          "UPDATE memories SET fact = ?, tags = ?, updated_at = ? WHERE id = ?"
        ).run(newFact, newTags, now, id);
        db.close();
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
      if (!ctx.enableMemory) return { error: DISABLED_MSG };
      try {
        const db = await openDb(ctx.cwd);
        const existing: any = db.prepare("SELECT fact FROM memories WHERE id = ?").get(id);
        if (!existing) {
          db.close();
          return { error: `No memory found with ID ${id}.` };
        }
        db.prepare("DELETE FROM memories WHERE id = ?").run(id);
        db.close();
        return { success: true, deleted_id: id, deleted_fact: existing.fact };
      } catch (e) {
        return { error: `Failed to delete memory: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  }));

  return tools;
}
