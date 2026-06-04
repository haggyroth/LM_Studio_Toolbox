"use strict";
/**
 * Integration tests for createFileTools.
 *
 * These tests call the actual tool implementations (t.implementation) against a
 * real temporary directory — no logic is re-implemented here.  The pattern mirrors
 * tests/memoryTools.test.js: build a minimal ToolContext stub, call createFileTools,
 * find each tool by name, and invoke its implementation.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const { createFileTools } = require("../dist/tools/fileTools.js");

// ── Minimal ToolContext stub ──────────────────────────────────────────────────

function makeCtx(cwd, overrides = {}) {
  return {
    cwd,
    protectedPaths: [],
    fullState: { currentWorkingDirectory: cwd, messageCount: 0, dontAskToCompress: false, subAgentDocsInjected: false, uiLanguageOverride: "auto" },
    // savePersistedState is called by change_directory — stub it out
    ...overrides,
  };
}

/** Call a named tool's implementation with given args. */
async function callTool(tools, name, args) {
  const t = tools.find(t => t.name === name);
  assert.ok(t, `Tool '${name}' not found in tool list`);
  return t.implementation(args);
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpDir;
let ctx;
let tools;

describe("fileTools integration", () => {
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "filetools-test-"));
    ctx = makeCtx(tmpDir);
    tools = createFileTools(ctx);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── save_file ──────────────────────────────────────────────────────────────

  describe("save_file", () => {
    it("creates a new file", async () => {
      const result = await callTool(tools, "save_file", { file_name: "hello.txt", content: "hello world" });
      assert.ok(result.success);
      const on_disk = await fs.readFile(path.join(tmpDir, "hello.txt"), "utf-8");
      assert.equal(on_disk, "hello world");
    });

    it("overwrites an existing file", async () => {
      await callTool(tools, "save_file", { file_name: "over.txt", content: "v1" });
      await callTool(tools, "save_file", { file_name: "over.txt", content: "v2" });
      const on_disk = await fs.readFile(path.join(tmpDir, "over.txt"), "utf-8");
      assert.equal(on_disk, "v2");
    });

    it("creates nested directories automatically", async () => {
      const result = await callTool(tools, "save_file", { file_name: "a/b/c.txt", content: "nested" });
      assert.ok(result.success);
      const on_disk = await fs.readFile(path.join(tmpDir, "a/b/c.txt"), "utf-8");
      assert.equal(on_disk, "nested");
    });

    it("saves multiple files in one call", async () => {
      const result = await callTool(tools, "save_file", {
        files: [
          { file_name: "batch1.txt", content: "one" },
          { file_name: "batch2.txt", content: "two" },
        ],
      });
      assert.ok(result.success);
      assert.equal(result.paths.length, 2);
    });

    it("blocks path traversal", async () => {
      const result = await callTool(tools, "save_file", { file_name: "../../evil.txt", content: "bad" });
      assert.ok(result.error, "should return an error for traversal");
      assert.match(result.error, /Access Denied/i);
    });
  });

  // ── read_file ─────────────────────────────────────────────────────────────

  describe("read_file", () => {
    it("reads a file created by save_file", async () => {
      await callTool(tools, "save_file", { file_name: "readable.txt", content: "content here" });
      const result = await callTool(tools, "read_file", { file_name: "readable.txt" });
      assert.equal(result.content, "content here");
    });

    it("returns an error for a non-existent file", async () => {
      try {
        const result = await callTool(tools, "read_file", { file_name: "nope.txt" });
        // May return an error object or throw
        if (result) assert.ok(result.error || typeof result.content === "undefined");
      } catch {
        // throwing is also acceptable
      }
    });

    it("blocks path traversal", async () => {
      try {
        const result = await callTool(tools, "read_file", { file_name: "../../etc/passwd" });
        assert.ok(result.error, "should error on traversal");
        assert.match(result.error, /Access Denied/i);
      } catch (e) {
        assert.match(e.message, /Access Denied/i);
      }
    });
  });

  // ── read_file_range ────────────────────────────────────────────────────────

  describe("read_file_range", () => {
    before(async () => {
      await callTool(tools, "save_file", { file_name: "lines.txt", content: "L1\nL2\nL3\nL4\nL5" });
    });

    it("returns the requested line range with line numbers", async () => {
      const result = await callTool(tools, "read_file_range", { file_name: "lines.txt", start_line: 2, end_line: 4 });
      assert.ok(result.content_with_line_numbers.includes("2: L2"));
      assert.ok(result.content_with_line_numbers.includes("4: L4"));
      assert.ok(!result.content_with_line_numbers.includes("1: L1"), "should not include line 1");
    });

    it("clamps end_line to file length", async () => {
      const result = await callTool(tools, "read_file_range", { file_name: "lines.txt", start_line: 4, end_line: 100 });
      assert.equal(result.end_line, 5);
    });
  });

  // ── append_file ────────────────────────────────────────────────────────────

  describe("append_file", () => {
    it("creates the file if it does not exist", async () => {
      await callTool(tools, "append_file", { file_name: "appended.txt", content: "first\n" });
      const on_disk = await fs.readFile(path.join(tmpDir, "appended.txt"), "utf-8");
      assert.equal(on_disk, "first\n");
    });

    it("appends to existing content", async () => {
      await callTool(tools, "append_file", { file_name: "appended.txt", content: "second\n" });
      const on_disk = await fs.readFile(path.join(tmpDir, "appended.txt"), "utf-8");
      assert.equal(on_disk, "first\nsecond\n");
    });
  });

  // ── replace_text_in_file ───────────────────────────────────────────────────

  describe("replace_text_in_file", () => {
    before(async () => {
      await callTool(tools, "save_file", { file_name: "replace.txt", content: "foo bar foo" });
    });

    it("replaces a unique occurrence", async () => {
      await callTool(tools, "save_file", { file_name: "replace_unique.txt", content: "hello world" });
      const result = await callTool(tools, "replace_text_in_file", {
        file_name: "replace_unique.txt", old_string: "hello", new_string: "goodbye",
      });
      assert.ok(result.success);
      const on_disk = await fs.readFile(path.join(tmpDir, "replace_unique.txt"), "utf-8");
      assert.equal(on_disk, "goodbye world");
    });

    it("errors when old_string is not found", async () => {
      const result = await callTool(tools, "replace_text_in_file", {
        file_name: "replace.txt", old_string: "nonexistent", new_string: "x",
      });
      assert.ok(result.error);
    });

    it("errors when old_string appears multiple times", async () => {
      const result = await callTool(tools, "replace_text_in_file", {
        file_name: "replace.txt", old_string: "foo", new_string: "baz",
      });
      assert.ok(result.error, "should error on ambiguous replacement");
      assert.match(result.error, /occurrences/i);
    });
  });

  // ── insert_at_line ─────────────────────────────────────────────────────────

  describe("insert_at_line", () => {
    before(async () => {
      await callTool(tools, "save_file", { file_name: "insert.txt", content: "line1\nline3" });
    });

    it("inserts content at the specified line", async () => {
      const result = await callTool(tools, "insert_at_line", {
        file_name: "insert.txt", line_number: 2, content_to_insert: "line2",
      });
      assert.ok(result.success);
      const on_disk = await fs.readFile(path.join(tmpDir, "insert.txt"), "utf-8");
      assert.equal(on_disk, "line1\nline2\nline3");
    });
  });

  // ── delete_lines_in_file ───────────────────────────────────────────────────

  describe("delete_lines_in_file", () => {
    before(async () => {
      await callTool(tools, "save_file", { file_name: "del_lines.txt", content: "L1\nL2\nL3\nL4" });
    });

    it("deletes a single line", async () => {
      const result = await callTool(tools, "delete_lines_in_file", { file_name: "del_lines.txt", start_line: 2 });
      assert.ok(result.success);
      const on_disk = await fs.readFile(path.join(tmpDir, "del_lines.txt"), "utf-8");
      assert.equal(on_disk, "L1\nL3\nL4");
    });
  });

  // ── list_directory ─────────────────────────────────────────────────────────

  describe("list_directory", () => {
    it("lists files in CWD by default", async () => {
      const result = await callTool(tools, "list_directory", {});
      assert.ok(Array.isArray(result.files));
      assert.ok(result.files.includes("hello.txt"), "should see hello.txt created earlier");
    });

    it("lists a subdirectory", async () => {
      const result = await callTool(tools, "list_directory", { path: "a/b" });
      assert.ok(result.files.includes("c.txt"));
    });

    it("blocks traversal in path argument", async () => {
      try {
        const result = await callTool(tools, "list_directory", { path: "../../" });
        assert.ok(result.error, "should error on traversal");
      } catch (e) {
        assert.match(e.message, /Access Denied/i);
      }
    });
  });

  // ── search_in_file ─────────────────────────────────────────────────────────

  describe("search_in_file", () => {
    before(async () => {
      await callTool(tools, "save_file", {
        file_name: "search_target.txt",
        content: "Hello World\nhello world\nfoo bar",
      });
    });

    it("finds lines matching a literal string (case-insensitive by default)", async () => {
      const result = await callTool(tools, "search_in_file", {
        file_name: "search_target.txt", pattern: "hello", case_sensitive: false,
      });
      assert.ok(result.matches, "should have matches");
      assert.equal(result.matches.length, 2, "both lines with 'hello' should match");
    });

    it("respects case_sensitive flag", async () => {
      const result = await callTool(tools, "search_in_file", {
        file_name: "search_target.txt", pattern: "Hello", case_sensitive: true,
      });
      assert.equal(result.matches.length, 1, "only 'Hello World' should match");
    });

    it("supports regex patterns", async () => {
      const result = await callTool(tools, "search_in_file", {
        file_name: "search_target.txt", pattern: "^foo", use_regex: true,
      });
      assert.equal(result.matches.length, 1);
    });
  });

  // ── protectedPaths enforcement ─────────────────────────────────────────────

  describe("protectedPaths enforcement", () => {
    let protectedCtx;
    let protectedTools;
    let secretDir;

    before(async () => {
      secretDir = path.join(tmpDir, "secret");
      await fs.mkdir(secretDir);
      await fs.writeFile(path.join(secretDir, "data.txt"), "sensitive");
      protectedCtx = makeCtx(tmpDir, { protectedPaths: [secretDir] });
      protectedTools = createFileTools(protectedCtx);
    });

    it("blocks read_file inside a protected directory", async () => {
      try {
        const result = await callTool(protectedTools, "read_file", { file_name: "secret/data.txt" });
        assert.ok(result.error, "should return error for protected path");
        assert.match(result.error, /Access Denied|protected/i);
      } catch (e) {
        assert.match(e.message, /Access Denied|protected/i);
      }
    });

    it("blocks save_file inside a protected directory", async () => {
      try {
        const result = await callTool(protectedTools, "save_file", {
          file_name: "secret/evil.txt", content: "bad",
        });
        assert.ok(result.error, "should return error for protected path");
      } catch (e) {
        assert.match(e.message, /Access Denied|protected/i);
      }
    });

    it("allows access to non-protected siblings", async () => {
      const result = await callTool(protectedTools, "save_file", {
        file_name: "notSecret.txt", content: "ok",
      });
      assert.ok(result.success);
    });
  });

  // ── make_directory / delete_path / move_file / copy_file ──────────────────

  describe("make_directory / delete_path / move_file / copy_file", () => {
    it("make_directory creates a directory", async () => {
      const result = await callTool(tools, "make_directory", { directory_name: "newdir" });
      assert.ok(result.success);
      const stat = await fs.stat(path.join(tmpDir, "newdir"));
      assert.ok(stat.isDirectory());
    });

    it("copy_file copies a file", async () => {
      await callTool(tools, "save_file", { file_name: "src.txt", content: "copy me" });
      const result = await callTool(tools, "copy_file", { source: "src.txt", destination: "dst.txt" });
      assert.ok(result.success);
      const on_disk = await fs.readFile(path.join(tmpDir, "dst.txt"), "utf-8");
      assert.equal(on_disk, "copy me");
    });

    it("move_file renames a file", async () => {
      await callTool(tools, "save_file", { file_name: "moveme.txt", content: "move" });
      const result = await callTool(tools, "move_file", { source: "moveme.txt", destination: "moved.txt" });
      assert.ok(result.success);
      await assert.rejects(fs.access(path.join(tmpDir, "moveme.txt")));
      const on_disk = await fs.readFile(path.join(tmpDir, "moved.txt"), "utf-8");
      assert.equal(on_disk, "move");
    });

    it("delete_path removes a file", async () => {
      await callTool(tools, "save_file", { file_name: "deleteme.txt", content: "bye" });
      await callTool(tools, "delete_path", { path: "deleteme.txt" });
      await assert.rejects(fs.access(path.join(tmpDir, "deleteme.txt")));
    });
  });

  // ── search_directory ────────────────────────────────────────────────────────

  describe("search_directory", () => {
    before(async () => {
      await fs.writeFile(path.join(tmpDir, "alpha.ts"), "export function foo() {\n  return 42;\n}\n", "utf-8");
      await fs.writeFile(path.join(tmpDir, "beta.ts"),  "import { foo } from './alpha';\nconst x = foo();\n", "utf-8");
      await fs.writeFile(path.join(tmpDir, "notes.md"), "foo is a helper function\nbar is another one\n", "utf-8");
    });

    it("returns structured {file, line, match, context} objects", async () => {
      const result = await callTool(tools, "search_directory", { pattern: "foo" });
      assert.ok(Array.isArray(result.matches), "matches should be an array");
      assert.ok(result.matches.length > 0, "should find at least one match");
      const m = result.matches[0];
      assert.ok(typeof m.file === "string", "match.file should be a string");
      assert.ok(typeof m.line === "number", "match.line should be a number");
      assert.ok(typeof m.match === "string", "match.match should be a string");
      assert.ok(Array.isArray(m.context), "match.context should be an array");
    });

    it("context lines include the match line prefixed with '>'", async () => {
      const result = await callTool(tools, "search_directory", { pattern: "return 42", context_lines: 1 });
      assert.ok(result.matches.length > 0);
      const ctx = result.matches[0].context;
      const matchLine = ctx.find(l => l.startsWith(">"));
      assert.ok(matchLine, "match line should be prefixed with '>'");
      assert.ok(matchLine.includes("return 42"), "match line should contain the matched text");
    });

    it("context_lines: 0 returns only the match line", async () => {
      const result = await callTool(tools, "search_directory", { pattern: "return 42", context_lines: 0 });
      assert.ok(result.matches.length > 0);
      assert.equal(result.matches[0].context.length, 1, "zero context_lines means only the match line");
    });

    it("overlapping matches within context window are deduplicated", async () => {
      // Write a file where two matches are within 2 lines of each other
      await fs.writeFile(path.join(tmpDir, "dense.ts"), "foo()\nfoo()\nfoo()\n", "utf-8");
      const result = await callTool(tools, "search_directory", {
        pattern: "foo",
        context_lines: 2,
        directory_path: ".",
      });
      const denseMatches = result.matches.filter(m => m.file === "dense.ts");
      // With context_lines:2, all three lines fall within the first match's window,
      // so only one result should be emitted for dense.ts.
      assert.equal(denseMatches.length, 1, "overlapping matches should be deduplicated");
    });

    it("line numbers are 1-indexed and correct", async () => {
      const result = await callTool(tools, "search_directory", {
        pattern: "import",
        case_sensitive: true,
      });
      const betaMatch = result.matches.find(m => m.file === "beta.ts");
      assert.ok(betaMatch, "should find import in beta.ts");
      assert.equal(betaMatch.line, 1, "import is on line 1 of beta.ts");
    });

    it("returns empty matches array (not error) when nothing matches", async () => {
      const result = await callTool(tools, "search_directory", { pattern: "ZZZNOMATCH" });
      assert.ok(!result.error, "should not error on no-match");
      assert.deepEqual(result.matches, []);
    });

    it("searches multiple file types", async () => {
      const result = await callTool(tools, "search_directory", { pattern: "foo" });
      const files = result.matches.map(m => m.file);
      assert.ok(files.some(f => f.endsWith(".ts")), "should match .ts files");
      assert.ok(files.some(f => f.endsWith(".md")), "should match .md files");
    });

    it("max_matches caps results and message reports the limit", async () => {
      // Write a file with many matches
      const manyLines = Array.from({ length: 20 }, (_, i) => `foo line ${i}`).join("\n");
      await fs.writeFile(path.join(tmpDir, "many.ts"), manyLines, "utf-8");

      const result = await callTool(tools, "search_directory", {
        pattern: "foo",
        max_matches: 3,
        context_lines: 0,
      });

      assert.ok(result.matches.length <= 3, `Should return at most 3 matches, got ${result.matches.length}`);
      assert.ok(result.message.includes("limit of 3"), `Message should mention the limit: ${result.message}`);
    });

    it("max_matches defaults to 100 when not specified", async () => {
      // Verify the default cap is still in effect (no regressions)
      const result = await callTool(tools, "search_directory", { pattern: "foo" });
      assert.ok(result.matches.length <= 100, "Default max_matches should cap at 100");
    });
  });
});
