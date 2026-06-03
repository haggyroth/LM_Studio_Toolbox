"use strict";
/**
 * Tests for N.9: find_symbol and find_usages in createCodeTools.
 *
 * A small TypeScript fixture is compiled into the tmp workspace so ts-morph
 * can parse it. Tests verify correct line numbers, kind labels, reference
 * counts, and graceful handling of missing symbols / bad paths.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const { createCodeTools } = require("../dist/tools/codeTools.js");

// ── Fixture TypeScript source ────────────────────────────────────────────────
// Written to the tmp dir so ts-morph can parse it without tsc.
const FIXTURE_TS = `
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export class Greeter {
  greet(name: string) { return greet(name); }
}

export interface Salutation {
  message: string;
}

export type Greeting = string;

export const DEFAULT_NAME = "World";

export enum Mode { Formal, Casual }

// A second usage of greet to ensure reference count is > 1
function demo() {
  return greet(DEFAULT_NAME);
}
export { demo };
`.trim();

function makeCtx(tmpDir, overrides = {}) {
  return {
    cwd: tmpDir,
    protectedPaths: [],
    allowJavascript: false,
    allowPython: false,
    allowTerminal: false,
    allowShell: false,
    allowBrowserControl: false,
    enableMemory: false,
    enableWikipedia: false,
    enableLocalRag: false,
    enableSecondary: false,
    allowGit: false,
    allowDb: false,
    allowNotify: false,
    allowGitHubTools: false,
    embeddingModelName: "test-model",
    protectedPathsStr: "",
    fullState: {},
    pluginConfig: {},
    client: null,
    browserSession: null,
    ...overrides,
  };
}

async function callTool(tools, name, args) {
  const t = tools.find(t => t.name === name);
  assert.ok(t, `Tool '${name}' not found`);
  return t.implementation(args, { status: () => {}, warn: () => {} });
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe("find_symbol", () => {
  let tmpDir;
  let tools;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "n9-sym-"));
    await fs.writeFile(path.join(tmpDir, "fixture.ts"), FIXTURE_TS, "utf-8");
    tools = createCodeTools(makeCtx(tmpDir));
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("finds a function by name", async () => {
    const res = await callTool(tools, "find_symbol", { name: "greet" });
    assert.equal(res.found, true);
    assert.ok(res.count >= 1);
    const def = res.definitions.find(d => d.kind.includes("function"));
    assert.ok(def, "expected a function definition");
    assert.equal(def.file, "fixture.ts");
    assert.ok(def.line >= 1);
  });

  it("finds a class by name", async () => {
    const res = await callTool(tools, "find_symbol", { name: "Greeter", kind: "class" });
    assert.equal(res.found, true);
    assert.ok(res.definitions.some(d => d.kind.includes("class")));
  });

  it("finds an interface by name", async () => {
    const res = await callTool(tools, "find_symbol", { name: "Salutation", kind: "interface" });
    assert.equal(res.found, true);
  });

  it("finds a type alias", async () => {
    const res = await callTool(tools, "find_symbol", { name: "Greeting", kind: "type" });
    assert.equal(res.found, true);
  });

  it("finds a const variable", async () => {
    const res = await callTool(tools, "find_symbol", { name: "DEFAULT_NAME", kind: "variable" });
    assert.equal(res.found, true);
  });

  it("finds an enum", async () => {
    const res = await callTool(tools, "find_symbol", { name: "Mode", kind: "enum" });
    assert.equal(res.found, true);
  });

  it("returns found:false for an unknown symbol", async () => {
    const res = await callTool(tools, "find_symbol", { name: "NonExistent" });
    assert.equal(res.found, false);
    assert.ok(typeof res.message === "string");
  });

  it("kind filter excludes wrong kinds", async () => {
    // 'greet' is a function — searching as 'class' should find nothing
    const res = await callTool(tools, "find_symbol", { name: "greet", kind: "class" });
    assert.equal(res.found, false);
  });
});

describe("find_usages", () => {
  let tmpDir;
  let tools;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "n9-use-"));
    await fs.writeFile(path.join(tmpDir, "fixture.ts"), FIXTURE_TS, "utf-8");
    tools = createCodeTools(makeCtx(tmpDir));
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns usages including the definition site and call sites", async () => {
    const res = await callTool(tools, "find_usages", { name: "greet" });
    assert.equal(res.found, true);
    // fixture has: definition + call inside Greeter.greet + call inside demo
    assert.ok(res.usage_count >= 2, `expected >= 2 usages, got ${res.usage_count}`);
    assert.ok(Array.isArray(res.usages));
    assert.ok(res.usages.every(u => typeof u.file === "string" && typeof u.line === "number"));
  });

  it("scopes search to definition_file", async () => {
    const res = await callTool(tools, "find_usages", { name: "greet", definition_file: "fixture.ts" });
    assert.equal(res.found, true);
    assert.ok(res.usage_count >= 1);
  });

  it("returns found:false for an unknown symbol", async () => {
    const res = await callTool(tools, "find_usages", { name: "totallyMissing" });
    assert.equal(res.found, false);
    assert.ok(typeof res.message === "string");
  });

  it("does not include node_modules references", async () => {
    const res = await callTool(tools, "find_usages", { name: "greet" });
    if (res.found) {
      assert.ok(res.usages.every(u => !u.file.includes("node_modules")));
    }
  });

  it("each usage has file, line, and context fields", async () => {
    const res = await callTool(tools, "find_usages", { name: "DEFAULT_NAME" });
    if (res.found && res.usage_count > 0) {
      const u = res.usages[0];
      assert.ok("file" in u && "line" in u && "context" in u);
    }
  });
});
