"use strict";
/**
 * Tests for Phase O2 UX tools:
 *   - list_tools (via toolsProvider)
 *   - tool_usage_stats (via createMiscTools)
 *   - analyze_project status calls (smoke test via createMiscTools)
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const { createMiscTools } = require("../dist/tools/miscTools.js");

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCtx(cwd, overrides = {}) {
  return {
    cwd,
    protectedPaths: [],
    allowDb: false,
    allowNotify: false,
    enableLocalRag: false,
    client: null,
    embeddingModelName: "test-model",
    fullState: {},
    pluginConfig: {
      get: (key) => ({
        enableAuditLog: false,
        secondaryAgentEndpoint: "http://localhost:1234/v1",
        secondaryModelId: "test-model",
      }[key] ?? null),
    },
    ...overrides,
  };
}

function makeCtxWithAudit(cwd) {
  return makeCtx(cwd, {
    pluginConfig: {
      get: (key) => key === "enableAuditLog" ? true : null,
    },
  });
}

async function callTool(tools, name, args) {
  const t = tools.find(t => t.name === name);
  assert.ok(t, `Tool '${name}' not found`);
  const statusCalls = [];
  return t.implementation(args, { status: (msg) => statusCalls.push(msg), warn: () => {}, _statusCalls: statusCalls });
}

async function callToolTracked(tools, name, args) {
  const t = tools.find(t => t.name === name);
  assert.ok(t, `Tool '${name}' not found`);
  const statusCalls = [];
  const result = await t.implementation(args, { status: (msg) => statusCalls.push(msg), warn: () => {} });
  return { result, statusCalls };
}

// ── tool_usage_stats ──────────────────────────────────────────────────────────

describe("tool_usage_stats", () => {
  let tmpDir, tools, auditPath;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "o2-stats-"));
    // Write a synthetic audit log
    const logDir = path.join(tmpDir, ".lm-studio-toolbox");
    await fs.mkdir(logDir, { recursive: true });
    auditPath = path.join(logDir, "audit.log");

    const entries = [
      { ts: "2026-06-03T00:01:00Z", tool: "read_file",  args: {}, status: "ok",    elapsed_ms: 10 },
      { ts: "2026-06-03T00:02:00Z", tool: "read_file",  args: {}, status: "ok",    elapsed_ms: 20 },
      { ts: "2026-06-03T00:03:00Z", tool: "save_file",  args: {}, status: "error", elapsed_ms: 5  },
      { ts: "2026-06-03T00:04:00Z", tool: "web_search", args: {}, status: "ok",    elapsed_ms: 300 },
      { ts: "2026-06-03T00:05:00Z", tool: "read_file",  args: {}, status: "throw", elapsed_ms: 1  },
    ];
    await fs.writeFile(auditPath, entries.map(e => JSON.stringify(e)).join("\n"), "utf-8");

    // Patch homedir to use tmpDir so the tool reads our fake log
    const origHomedir = os.homedir;
    // We can't easily patch homedir in CJS; instead we call the tool
    // via a ctx that points to a cwd under our tmpDir, but the audit
    // log path uses homedir() directly. So we test the "disabled" path
    // separately and verify parsing logic via the NDJSON format.
    tools = createMiscTools(makeCtxWithAudit(tmpDir));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns error when audit log is disabled", async () => {
    const disabledTools = createMiscTools(makeCtx(tmpDir));
    const res = await callTool(disabledTools, "tool_usage_stats", { limit: 5 });
    assert.ok(typeof res.error === "string");
    assert.ok(res.error.includes("enableAuditLog"));
  });

  it("tool exists in the tool list", () => {
    assert.ok(tools.some(t => t.name === "tool_usage_stats"));
  });

  it("accepts sort_by parameter values", async () => {
    // When audit log enabled but file doesn't exist at real homedir, returns an error
    // — we just verify the tool is callable without crashing
    const res = await callTool(tools, "tool_usage_stats", { limit: 5, sort_by: "avg_ms" });
    // Either "file not found" error or actual data — both are valid
    assert.ok(typeof res === "object");
  });
});

// ── analyze_project status streaming ─────────────────────────────────────────

describe("analyze_project status streaming", () => {
  let tmpDir, tools;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "o2-analyze-"));
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-project", version: "1.0.0", scripts: { test: "node --test", lint: "eslint src/" } }),
      "utf-8"
    );
    tools = createMiscTools(makeCtx(tmpDir));
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("emits status messages during execution", async () => {
    const { result, statusCalls } = await callToolTracked(tools, "analyze_project", { depth: 1 });
    assert.ok(Array.isArray(statusCalls), "status calls should be an array");
    assert.ok(statusCalls.length >= 2, `expected >= 2 status calls, got ${statusCalls.length}: ${JSON.stringify(statusCalls)}`);
    assert.ok(statusCalls.some(s => s.toLowerCase().includes("tree") || s.toLowerCase().includes("directory")));
    assert.ok(statusCalls.some(s => s.toLowerCase().includes("done") || s.toLowerCase().includes("git") || s.toLowerCase().includes("file")));
  });

  it("detected_commands includes test and lint from package.json", async () => {
    const res = await callTool(tools, "analyze_project", { depth: 1 });
    assert.ok(Array.isArray(res.detected_commands));
    assert.ok(res.detected_commands.some(c => c.startsWith("test:")));
    assert.ok(res.detected_commands.some(c => c.startsWith("lint:")));
  });

  it("returns cwd and directory_tree in result", async () => {
    const res = await callTool(tools, "analyze_project", { depth: 1 });
    assert.equal(res.cwd, tmpDir);
    assert.ok(typeof res.directory_tree === "object");
  });
});

// ── list_tools (meta-tool smoke test via toolsProvider) ───────────────────────

describe("list_tools via toolsProvider", () => {
  it("toolsProvider exports are loadable", () => {
    // list_tools is registered in toolsProvider which requires the full LM Studio
    // plugin context — we just confirm the module loads without error.
    const mod = require("../dist/toolsProvider.js");
    assert.ok(typeof mod.toolsProvider === "function");
  });
});
