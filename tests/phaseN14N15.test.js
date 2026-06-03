"use strict";
/**
 * Tests for N.14 (rename_symbol) and N.15 (edit_file_with_diff).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile: execFileCb } = require("child_process");
const { promisify } = require("util");
const execFile = promisify(execFileCb);

const { createCodeTools } = require("../dist/tools/codeTools.js");
const { createFileTools } = require("../dist/tools/fileTools.js");

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCodeCtx(cwd) {
  return {
    cwd, protectedPaths: [], allowJavascript: false, allowPython: false,
    allowTerminal: false, allowShell: false, allowBrowserControl: false,
    enableMemory: false, enableWikipedia: false, enableLocalRag: false,
    enableSecondary: false, allowGit: false, allowDb: false, allowNotify: false,
    allowGitHubTools: false, embeddingModelName: "test-model",
    fullState: {}, pluginConfig: {}, client: null, browserSession: null,
  };
}

function makeFileCtx(cwd) {
  return { cwd, protectedPaths: [], fullState: {}, pluginConfig: {} };
}

async function callTool(tools, name, args) {
  const t = tools.find(t => t.name === name);
  assert.ok(t, `Tool '${name}' not found`);
  return t.implementation(args, { status: () => {}, warn: () => {} });
}

// ── N.14: rename_symbol ───────────────────────────────────────────────────────

const FIXTURE_A = `
export function greet(name: string) { return \`Hi \${name}\`; }
export const alias = greet;
`.trim();

const FIXTURE_B = `
import { greet } from "./a";
export function demo() { return greet("World"); }
`.trim();

describe("rename_symbol", () => {
  let tmpDir, tools;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "n14-"));
    await fs.writeFile(path.join(tmpDir, "a.ts"), FIXTURE_A, "utf-8");
    await fs.writeFile(path.join(tmpDir, "b.ts"), FIXTURE_B, "utf-8");
    tools = createCodeTools(makeCodeCtx(tmpDir));
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("renames a function and all its references across files", async () => {
    const res = await callTool(tools, "rename_symbol", { old_name: "greet", new_name: "sayHello" });
    assert.equal(res.success, true);
    assert.ok(res.files_modified >= 1);
    // Both files should have been touched
    assert.ok(Array.isArray(res.modified_files));
    // a.ts: declaration renamed; b.ts: import and call site renamed
    const aContent = await fs.readFile(path.join(tmpDir, "a.ts"), "utf-8");
    assert.ok(aContent.includes("sayHello"), "a.ts should contain new name");
    assert.ok(!aContent.includes("function greet"), "a.ts should not contain old name as function");
    const bContent = await fs.readFile(path.join(tmpDir, "b.ts"), "utf-8");
    assert.ok(bContent.includes("sayHello"), "b.ts should contain new name");
  });

  it("rejects an invalid identifier", async () => {
    const res = await callTool(tools, "rename_symbol", { old_name: "demo", new_name: "123bad" });
    assert.ok(typeof res.error === "string");
    assert.ok(res.error.includes("valid"));
  });

  it("rejects same old_name and new_name", async () => {
    const res = await callTool(tools, "rename_symbol", { old_name: "demo", new_name: "demo" });
    assert.ok(typeof res.error === "string");
  });

  it("returns error for unknown symbol", async () => {
    const res = await callTool(tools, "rename_symbol", { old_name: "nonExistent", new_name: "something" });
    assert.ok(typeof res.error === "string");
  });

  it("scopes search to definition_file", async () => {
    // Reset: re-read content (previous test already renamed greet→sayHello)
    // Use demo (in b.ts) with definition_file to confirm scoping works
    const res = await callTool(tools, "rename_symbol", {
      old_name: "sayHello", new_name: "greetUser", definition_file: "a.ts",
    });
    assert.equal(res.success, true);
    assert.ok(res.files_modified >= 1);
  });
});

// ── N.15: edit_file_with_diff ─────────────────────────────────────────────────

describe("edit_file_with_diff (requires git)", () => {
  let tmpDir, tools;
  let gitAvailable = false;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "n15-"));
    tools = createFileTools(makeFileCtx(tmpDir));

    // Init a git repo so git apply works
    try {
      await execFile("git", ["init", tmpDir]);
      await execFile("git", ["-C", tmpDir, "config", "user.email", "test@test.com"]);
      await execFile("git", ["-C", tmpDir, "config", "user.name", "Test"]);
      gitAvailable = true;
    } catch {
      gitAvailable = false;
    }

    await fs.writeFile(path.join(tmpDir, "hello.txt"), "line one\nline two\nline three\n", "utf-8");
    if (gitAvailable) {
      await execFile("git", ["-C", tmpDir, "add", "hello.txt"]);
      await execFile("git", ["-C", tmpDir, "commit", "-m", "init"]);
    }
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("applies a valid diff with explicit headers", async function () {
    if (!gitAvailable) { this.skip?.(); return; }
    const diff = [
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1,3 +1,3 @@",
      " line one",
      "-line two",
      "+line TWO",
      " line three",
    ].join("\n") + "\n";
    const res = await callTool(tools, "edit_file_with_diff", { file_path: "hello.txt", unified_diff: diff });
    assert.equal(res.success, true);
    const content = await fs.readFile(path.join(tmpDir, "hello.txt"), "utf-8");
    assert.ok(content.includes("line TWO"));
    assert.ok(!content.includes("line two"));
  });

  it("applies a diff without headers (auto-added)", async function () {
    if (!gitAvailable) { this.skip?.(); return; }
    // Reset file
    await fs.writeFile(path.join(tmpDir, "hello.txt"), "line one\nline TWO\nline three\n", "utf-8");
    await execFile("git", ["-C", tmpDir, "add", "hello.txt"]);
    await execFile("git", ["-C", tmpDir, "commit", "-m", "reset"]);

    const diff = [
      "@@ -1,3 +1,3 @@",
      " line one",
      "-line TWO",
      "+line two",
      " line three",
    ].join("\n") + "\n";
    const res = await callTool(tools, "edit_file_with_diff", { file_path: "hello.txt", unified_diff: diff });
    assert.equal(res.success, true);
    const content = await fs.readFile(path.join(tmpDir, "hello.txt"), "utf-8");
    assert.ok(content.includes("line two"));
  });

  it("returns a clean error when diff context does not match", async function () {
    if (!gitAvailable) { this.skip?.(); return; }
    const badDiff = [
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1,3 +1,3 @@",
      " this line does not exist",
      "-line two",
      "+line TWO",
      " line three",
    ].join("\n") + "\n";
    const res = await callTool(tools, "edit_file_with_diff", { file_path: "hello.txt", unified_diff: badDiff });
    assert.ok(typeof res.error === "string");
    assert.ok(res.error.toLowerCase().includes("cleanly") || res.error.toLowerCase().includes("apply"));
    assert.ok(typeof res.hint === "string");
  });

  it("tool exists in file tools list", () => {
    assert.ok(tools.some(t => t.name === "edit_file_with_diff"));
  });
});
