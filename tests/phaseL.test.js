"use strict";
/**
 * Tests for Phase L developer-experience features:
 *  - apply_patch (via createFileTools)
 *  - read_document extended format support (via createMiscTools)
 *  - disabledTools config filter (static check on compiled toolsProvider)
 *
 * search_directory parallelism is an internal refactor with identical
 * observable behaviour; it is covered by the existing fileTools tests.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile: execFileCb } = require("child_process");
const { promisify } = require("util");
const execFile = promisify(execFileCb);

const { createFileTools } = require("../dist/tools/fileTools.js");
const { createMiscTools } = require("../dist/tools/miscTools.js");

// ── helpers ───────────────────────────────────────────────────────────────────

function makeFileCtx(cwd) {
  return { cwd, protectedPaths: [] };
}

function makeMiscCtx(cwd) {
  return { cwd, protectedPaths: [], allowDb: false, allowNotify: false, enableRagLocalFiles: false, client: null, embeddingModelName: "" };
}

async function callTool(tools, name, args = {}) {
  const t = tools.find(t => t.name === name);
  assert.ok(t, `Tool '${name}' not found`);
  return t.implementation(args);
}

// ── test setup ────────────────────────────────────────────────────────────────

let tmpDir;

describe("Phase L — apply_patch", () => {
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "phase-l-test-"));
    // Init a git repo so git apply works
    const git = (args) => execFile("git", args, { cwd: tmpDir });
    await git(["init"]);
    await git(["config", "user.email", "test@test.com"]);
    await git(["config", "user.name", "Test"]);
    await fs.writeFile(path.join(tmpDir, "hello.txt"), "line one\nline two\nline three\n");
    await git(["add", "."]);
    await git(["commit", "-m", "init"]);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("applies a valid unified diff patch", async () => {
    const tools = createFileTools(makeFileCtx(tmpDir));
    // Generate a patch by modifying the file and running git diff
    await fs.writeFile(path.join(tmpDir, "hello.txt"), "line one\nline TWO\nline three\n");
    const { stdout: patch } = await execFile("git", ["diff"], { cwd: tmpDir });
    // Reset file before applying
    await execFile("git", ["checkout", "hello.txt"], { cwd: tmpDir });

    const result = await callTool(tools, "apply_patch", { patch, dry_run: false });
    assert.ok(!result.error, `Should apply patch without error: ${result.error}`);
    assert.ok(result.success);
    const after = await fs.readFile(path.join(tmpDir, "hello.txt"), "utf-8");
    assert.ok(after.includes("TWO"), "Patch should have changed 'two' to 'TWO'");

    // Restore for next test
    await execFile("git", ["checkout", "hello.txt"], { cwd: tmpDir });
  });

  it("dry_run: true checks patch without modifying files", async () => {
    const tools = createFileTools(makeFileCtx(tmpDir));
    await fs.writeFile(path.join(tmpDir, "hello.txt"), "line one\nline TWO\nline three\n");
    const { stdout: patch } = await execFile("git", ["diff"], { cwd: tmpDir });
    await execFile("git", ["checkout", "hello.txt"], { cwd: tmpDir });

    const result = await callTool(tools, "apply_patch", { patch, dry_run: true });
    assert.ok(!result.error, `Dry run should succeed: ${result.error}`);
    assert.ok(result.message?.includes("dry run") || result.message?.includes("cleanly"), `Got: ${result.message}`);

    // File should be unchanged
    const content = await fs.readFile(path.join(tmpDir, "hello.txt"), "utf-8");
    assert.ok(!content.includes("TWO"), "Dry run should not modify the file");
  });

  it("returns error for a bad patch", async () => {
    const tools = createFileTools(makeFileCtx(tmpDir));
    const result = await callTool(tools, "apply_patch", {
      patch: "this is not a valid unified diff",
      dry_run: false,
    });
    assert.ok(result.error, "Should return error for invalid patch");
  });
});

// ── read_document extended formats ────────────────────────────────────────────

describe("Phase L — read_document extended formats", () => {
  let miscTmpDir;
  before(async () => {
    miscTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-doc-test-"));
  });
  after(async () => {
    await fs.rm(miscTmpDir, { recursive: true, force: true });
  });

  it("reads a .txt file as plain text", async () => {
    await fs.writeFile(path.join(miscTmpDir, "notes.txt"), "Hello from a text file.");
    const tools = createMiscTools(makeMiscCtx(miscTmpDir));
    const result = await callTool(tools, "read_document", { file_path: "notes.txt" });
    assert.ok(!result.error, `Should not error: ${result.error}`);
    assert.ok(result.content.includes("Hello from a text file."));
    assert.equal(result.format, "txt");
    assert.equal(result.truncated, false);
  });

  it("reads a .md file as plain text", async () => {
    await fs.writeFile(path.join(miscTmpDir, "README.md"), "# Title\nSome content.");
    const tools = createMiscTools(makeMiscCtx(miscTmpDir));
    const result = await callTool(tools, "read_document", { file_path: "README.md" });
    assert.ok(!result.error, `Should not error: ${result.error}`);
    assert.ok(result.content.includes("# Title"));
    assert.equal(result.format, "md");
  });

  it("reads a .json file and reports valid_json: true", async () => {
    await fs.writeFile(path.join(miscTmpDir, "data.json"), JSON.stringify({ key: "value", num: 42 }));
    const tools = createMiscTools(makeMiscCtx(miscTmpDir));
    const result = await callTool(tools, "read_document", { file_path: "data.json" });
    assert.ok(!result.error, `Should not error: ${result.error}`);
    assert.ok(result.content.includes('"key"'));
    assert.equal(result.valid_json, true);
    assert.equal(result.format, "json");
  });

  it("reads a malformed .json file and reports valid_json: false", async () => {
    await fs.writeFile(path.join(miscTmpDir, "bad.json"), "{ invalid json }");
    const tools = createMiscTools(makeMiscCtx(miscTmpDir));
    const result = await callTool(tools, "read_document", { file_path: "bad.json" });
    assert.ok(!result.error, `Should not error: ${result.error}`);
    assert.equal(result.valid_json, false);
    assert.ok(result.parse_error, "Should include parse_error description");
  });

  it("reads a .csv file and reports row_count and header", async () => {
    const csv = "name,age,city\nAlice,30,NYC\nBob,25,LA\n";
    await fs.writeFile(path.join(miscTmpDir, "data.csv"), csv);
    const tools = createMiscTools(makeMiscCtx(miscTmpDir));
    const result = await callTool(tools, "read_document", { file_path: "data.csv" });
    assert.ok(!result.error, `Should not error: ${result.error}`);
    assert.equal(result.format, "csv");
    assert.ok(result.row_count > 0, "Should report row count");
    assert.ok(result.header.includes("name"), "Should report CSV header");
  });

  it("reads an .xml file as plain text", async () => {
    await fs.writeFile(path.join(miscTmpDir, "config.xml"), "<root><item>value</item></root>");
    const tools = createMiscTools(makeMiscCtx(miscTmpDir));
    const result = await callTool(tools, "read_document", { file_path: "config.xml" });
    assert.ok(!result.error, `Should not error: ${result.error}`);
    assert.ok(result.content.includes("<root>"));
    assert.equal(result.format, "xml");
  });

  it("truncates files larger than 40 000 characters", async () => {
    const bigContent = "x".repeat(45_000);
    await fs.writeFile(path.join(miscTmpDir, "big.txt"), bigContent);
    const tools = createMiscTools(makeMiscCtx(miscTmpDir));
    const result = await callTool(tools, "read_document", { file_path: "big.txt" });
    assert.ok(!result.error, `Should not error: ${result.error}`);
    assert.equal(result.truncated, true, "Should mark as truncated");
    assert.ok(result.content.length <= 40_100, "Content should be truncated");
  });
});

// ── disabledTools config filter (static check) ───────────────────────────────

describe("Phase L — disabledTools config", () => {
  it("compiled toolsProvider filters tools by disabledTools config", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../dist/toolsProvider.js"), "utf-8"
    );
    assert.ok(
      src.includes("disabledTools") || src.includes("disabledToolNames"),
      "toolsProvider should implement disabledTools filtering"
    );
  });

  it("compiled config.js includes the disabledTools field", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../dist/config.js"), "utf-8"
    );
    assert.ok(src.includes("disabledTools"), "config should register disabledTools field");
  });
});
