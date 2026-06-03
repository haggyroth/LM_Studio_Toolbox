"use strict";
/**
 * Tests for N.8 (watch_file, watch_directory, stop_watch, list_watches)
 * and N.10 (capture_screenshot guard paths — live Puppeteer skipped in CI).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const { createFileTools } = require("../dist/tools/fileTools.js");
const { createBrowserTools } = require("../dist/tools/browserTools.js");

// ── helpers ───────────────────────────────────────────────────────────────────

function makeFileCtx(cwd, overrides = {}) {
  return { cwd, protectedPaths: [], ...overrides };
}

function makeBrowserCtx(overrides = {}) {
  return {
    cwd: os.tmpdir(),
    protectedPaths: [],
    allowBrowserControl: false,
    browserSession: null,
    fullState: {},
    ...overrides,
  };
}

async function callTool(tools, name, args) {
  const t = tools.find(t => t.name === name);
  assert.ok(t, `Tool '${name}' not found`);
  return t.implementation(args, { status: () => {}, warn: () => {} });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── N.8: watch_file ───────────────────────────────────────────────────────────

describe("watch_file", () => {
  let tmpDir, tools;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "n8-wf-"));
    tools = createFileTools(makeFileCtx(tmpDir));
    await fs.writeFile(path.join(tmpDir, "target.txt"), "initial", "utf-8");
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns a watcher_id on success", async () => {
    const res = await callTool(tools, "watch_file", { file_path: "target.txt" });
    assert.equal(res.success, true);
    assert.ok(typeof res.watcher_id === "string" && res.watcher_id.length > 0);
    // Cleanup
    await callTool(tools, "stop_watch", { watcher_id: res.watcher_id });
  });

  it("detects a file change event", async () => {
    const start = await callTool(tools, "watch_file", { file_path: "target.txt" });
    const id = start.watcher_id;
    await sleep(50);
    await fs.writeFile(path.join(tmpDir, "target.txt"), "changed", "utf-8");
    await sleep(150); // give the OS watcher time to fire
    const listing = await callTool(tools, "list_watches", { watcher_id: id });
    const entry = listing.watchers[0];
    assert.ok(entry.event_count >= 1, `expected >=1 event, got ${entry.event_count}`);
    await callTool(tools, "stop_watch", { watcher_id: id });
  });

  it("returns error for missing file", async () => {
    const res = await callTool(tools, "watch_file", { file_path: "ghost.txt" });
    assert.ok(typeof res.error === "string");
  });
});

// ── N.8: watch_directory ─────────────────────────────────────────────────────

describe("watch_directory", () => {
  let tmpDir, tools;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "n8-wd-"));
    tools = createFileTools(makeFileCtx(tmpDir));
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns a watcher_id for a valid directory", async () => {
    const res = await callTool(tools, "watch_directory", { directory_path: "." });
    assert.equal(res.success, true);
    assert.ok(typeof res.watcher_id === "string");
    await callTool(tools, "stop_watch", { watcher_id: res.watcher_id });
  });

  it("detects new file creation in watched directory", async () => {
    const start = await callTool(tools, "watch_directory", { directory_path: "." });
    const id = start.watcher_id;
    await sleep(50);
    await fs.writeFile(path.join(tmpDir, "newfile.txt"), "hello", "utf-8");
    await sleep(150);
    const listing = await callTool(tools, "list_watches", { watcher_id: id });
    assert.ok(listing.watchers[0].event_count >= 1);
    await callTool(tools, "stop_watch", { watcher_id: id });
  });

  it("returns error for a non-existent directory", async () => {
    const res = await callTool(tools, "watch_directory", { directory_path: "no-such-dir" });
    assert.ok(typeof res.error === "string");
  });

  it("returns error when path is a file, not a directory", async () => {
    await fs.writeFile(path.join(tmpDir, "afile.txt"), "x", "utf-8");
    const res = await callTool(tools, "watch_directory", { directory_path: "afile.txt" });
    assert.ok(typeof res.error === "string");
  });
});

// ── N.8: stop_watch / list_watches ───────────────────────────────────────────

describe("stop_watch and list_watches", () => {
  let tmpDir, tools;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "n8-sl-"));
    tools = createFileTools(makeFileCtx(tmpDir));
    await fs.writeFile(path.join(tmpDir, "f.txt"), "x", "utf-8");
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("list_watches shows the watcher after creation", async () => {
    const start = await callTool(tools, "watch_file", { file_path: "f.txt" });
    const id = start.watcher_id;
    const listing = await callTool(tools, "list_watches", {});
    assert.ok(listing.watchers.some(w => w.id === id && w.status === "watching"));
    await callTool(tools, "stop_watch", { watcher_id: id });
  });

  it("stop_watch transitions status to stopped", async () => {
    const start = await callTool(tools, "watch_file", { file_path: "f.txt" });
    const id = start.watcher_id;
    const stopRes = await callTool(tools, "stop_watch", { watcher_id: id });
    assert.equal(stopRes.success, true);
    const listing = await callTool(tools, "list_watches", { watcher_id: id });
    assert.equal(listing.watchers[0].status, "stopped");
  });

  it("stop_watch returns error for unknown id", async () => {
    const res = await callTool(tools, "stop_watch", { watcher_id: "nonexistent-id" });
    assert.ok(typeof res.error === "string");
  });

  it("list_watches with watcher_id returns only that watcher", async () => {
    const start = await callTool(tools, "watch_file", { file_path: "f.txt" });
    const id = start.watcher_id;
    const listing = await callTool(tools, "list_watches", { watcher_id: id });
    assert.equal(listing.watchers.length, 1);
    assert.equal(listing.watchers[0].id, id);
    await callTool(tools, "stop_watch", { watcher_id: id });
  });

  it("list_watches with unknown watcher_id returns error", async () => {
    const res = await callTool(tools, "list_watches", { watcher_id: "bogus" });
    assert.ok(typeof res.error === "string");
  });
});

// ── N.10: capture_screenshot guard paths ─────────────────────────────────────

describe("capture_screenshot (guard paths)", () => {
  it("rejects non-http/https URLs when allowBrowserControl is on", async () => {
    const tools = createBrowserTools(makeBrowserCtx({ allowBrowserControl: true }));
    const t = tools.find(t => t.name === "capture_screenshot");
    assert.ok(t, "capture_screenshot tool not found");
    const res = await t.implementation({ url: "file:///etc/passwd" }, {});
    assert.ok(typeof res.error === "string");
    assert.ok(res.error.includes("http"));
  });

  it("tool is present in the tools list when allowBrowserControl is enabled", () => {
    const tools = createBrowserTools(makeBrowserCtx({ allowBrowserControl: true }));
    assert.ok(tools.some(t => t.name === "capture_screenshot"));
  });

  it("tool enforces allowBrowserControl guard (disabled case)", async () => {
    // When allowBrowserControl is false the createSafeToolImplementation wrapper throws
    const tools = createBrowserTools(makeBrowserCtx({ allowBrowserControl: false }));
    const t = tools.find(t => t.name === "capture_screenshot");
    assert.ok(t, "capture_screenshot should still be registered even when disabled");
    await assert.rejects(() => t.implementation({ url: "https://example.com" }, {}));
  });
});
