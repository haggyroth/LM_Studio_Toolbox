const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("fs/promises");
const { join } = require("path");
const { tmpdir } = require("os");
const { createMemoryTools } = require("../dist/tools/memoryTools.js");

// ── Environment check ──────────────────────────────────────────────────────────
// better-sqlite3 requires a native binding compiled for the current Node ABI.
// In LM Studio's bundled runtime the binding is pre-compiled and works fine.
// On a bare system Node it may not be available, so DB-dependent tests skip.
let sqliteAvailable = false;
try {
  // require() only loads the JS wrapper; the native binding is resolved when
  // new Database() is called. We must actually instantiate to confirm it works.
  const Database = require("better-sqlite3");
  const probe = new Database(":memory:");
  probe.close();
  sqliteAvailable = true;
} catch {
  /* binding not compiled for this Node ABI — DB tests will self-skip below */
}

const skipIfNoSqlite = (t) => {
  if (!sqliteAvailable) {
    t.skip("better-sqlite3 native binding not available — run npm rebuild better-sqlite3 to enable");
    return true;
  }
  return false;
};

/** Build a minimal ToolContext stub for memory tests. */
function makeCtx(cwd, enableMemory = true) {
  return { cwd, enableMemory };
}

/** Call a tool's implementation directly by name. */
async function callTool(tools, name, args) {
  const t = tools.find(t => t.name === name);
  assert.ok(t, `Tool '${name}' not found`);
  return t.implementation(args);
}

/** Safely convert a SQLite row id (may be BigInt) to a JS number. */
const toNumber = (v) => Number(v);

let tmpDir;
let tools;

describe("Memory CRUD tools", () => {
  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "memory-test-"));
    tools = createMemoryTools(makeCtx(tmpDir));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Always runs — no SQLite needed ────────────────────────────────────────────

  it("createMemoryTools returns empty array when memory is disabled (CON-1)", () => {
    // Consistent with gitTools, githubTools — disabled features return no tools
    // so they don't appear in the model's tool list at all.
    const disabledTools = createMemoryTools(makeCtx(tmpDir, false));
    assert.equal(disabledTools.length, 0, "should return [] when enableMemory is false");
  });

  // ── Require SQLite native binding ─────────────────────────────────────────────

  it("save_memory: stores a fact and returns an id", async (t) => {
    if (skipIfNoSqlite(t)) return;
    const result = await callTool(tools, "save_memory", { fact: "User prefers dark mode" });
    assert.equal(result.success, true);
    assert.ok(toNumber(result.id) >= 1, "id should be a positive integer");
    assert.equal(result.fact, "User prefers dark mode");
  });

  it("save_memory: stores tags alongside the fact", async (t) => {
    if (skipIfNoSqlite(t)) return;
    const result = await callTool(tools, "save_memory", {
      fact: "Project uses TypeScript 5",
      tags: "project,tech",
    });
    assert.equal(result.success, true);
    assert.equal(result.tags, "project,tech");
  });

  it("list_memories: returns all saved memories newest-first", async (t) => {
    if (skipIfNoSqlite(t)) return;
    const result = await callTool(tools, "list_memories", {});
    assert.ok(result.count >= 2, "should have at least the two saved facts");
    assert.ok(Array.isArray(result.memories));
    assert.ok(result.memories[0].id >= result.memories[1].id);
  });

  it("list_memories: filters by tag", async (t) => {
    if (skipIfNoSqlite(t)) return;
    const result = await callTool(tools, "list_memories", { tag: "project" });
    assert.ok(result.memories.every(m => m.tags.includes("project")));
  });

  it("search_memories: finds matching facts by keyword", async (t) => {
    if (skipIfNoSqlite(t)) return;
    const result = await callTool(tools, "search_memories", { query: "dark mode" });
    assert.ok(result.count >= 1);
    assert.ok(result.memories.some(m => m.fact.includes("dark mode")));
  });

  it("search_memories: finds matches in tags", async (t) => {
    if (skipIfNoSqlite(t)) return;
    const result = await callTool(tools, "search_memories", { query: "tech" });
    assert.ok(result.memories.some(m => m.tags.includes("tech")));
  });

  it("search_memories: returns empty array for no match", async (t) => {
    if (skipIfNoSqlite(t)) return;
    const result = await callTool(tools, "search_memories", { query: "xyzzy_nonexistent" });
    assert.equal(result.count, 0);
    assert.deepEqual(result.memories, []);
  });

  it("update_memory: updates fact text by id", async (t) => {
    if (skipIfNoSqlite(t)) return;
    const saved = await callTool(tools, "save_memory", { fact: "Old fact text" });
    const id = toNumber(saved.id);
    const updated = await callTool(tools, "update_memory", { id, fact: "New fact text" });
    assert.equal(updated.success, true);
    assert.equal(updated.fact, "New fact text");
    const found = await callTool(tools, "search_memories", { query: "New fact text" });
    assert.ok(found.memories.some(m => toNumber(m.id) === id));
  });

  it("update_memory: updates tags without changing fact", async (t) => {
    if (skipIfNoSqlite(t)) return;
    const saved = await callTool(tools, "save_memory", { fact: "Tag-update test", tags: "old" });
    const id = toNumber(saved.id);
    const updated = await callTool(tools, "update_memory", { id, tags: "new,updated" });
    assert.equal(updated.tags, "new,updated");
    assert.equal(updated.fact, "Tag-update test");
  });

  it("update_memory: returns error for unknown id", async (t) => {
    if (skipIfNoSqlite(t)) return;
    const result = await callTool(tools, "update_memory", { id: 999999, fact: "Ghost" });
    assert.ok(result.error, "should return an error for unknown id");
    assert.ok(
      result.error.toLowerCase().includes("no memory found"),
      `expected 'no memory found' in error, got: ${result.error}`
    );
  });

  it("delete_memory: removes a memory by id", async (t) => {
    if (skipIfNoSqlite(t)) return;
    const saved = await callTool(tools, "save_memory", { fact: "To be deleted" });
    const id = toNumber(saved.id);
    const deleted = await callTool(tools, "delete_memory", { id });
    assert.equal(deleted.success, true);
    assert.equal(toNumber(deleted.deleted_id), id);
    const found = await callTool(tools, "search_memories", { query: "To be deleted" });
    assert.ok(!found.memories.some(m => toNumber(m.id) === id));
  });

  it("delete_memory: returns error for unknown id", async (t) => {
    if (skipIfNoSqlite(t)) return;
    const result = await callTool(tools, "delete_memory", { id: 999999 });
    assert.ok(result.error, "should return an error for unknown id");
    assert.ok(
      result.error.toLowerCase().includes("no memory found"),
      `expected 'no memory found' in error, got: ${result.error}`
    );
  });
});
