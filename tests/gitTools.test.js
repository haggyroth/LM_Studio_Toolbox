"use strict";
/**
 * Tests for createGitTools — Phase K additions.
 *
 * simple-git operations are not mocked; instead we initialise a real bare
 * git repo in a temp directory so the tool implementations run against actual
 * git objects.  This mirrors how fileTools.test.js uses a real temp directory.
 *
 * Network-dependent operations (git_fetch, git_push) are tested only for their
 * error path (no remote configured) and their gating behaviour.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile: execFileCb } = require("child_process");
const { promisify } = require("util");
const execFile = promisify(execFileCb);

const { createGitTools } = require("../dist/tools/gitTools.js");

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCtx(cwd) {
  return { cwd, protectedPaths: [], allowGit: true };
}

async function callTool(tools, name, args = {}) {
  const t = tools.find(t => t.name === name);
  assert.ok(t, `Tool '${name}' not found`);
  return t.implementation(args);
}

// ── setup: real git repo in tmpdir ────────────────────────────────────────────

let tmpDir;
let tools;

describe("gitTools — Phase K additions", () => {
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gittools-test-"));

    // Initialise a git repo with a base commit so HEAD exists
    const git = (args) => execFile("git", args, { cwd: tmpDir });
    await git(["init"]);
    await git(["config", "user.email", "test@test.com"]);
    await git(["config", "user.name", "Test"]);
    await fs.writeFile(path.join(tmpDir, "README.md"), "# Test\n");
    await git(["add", "."]);
    await git(["commit", "-m", "initial"]);

    tools = createGitTools(makeCtx(tmpDir));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── git_stash ──────────────────────────────────────────────────────────────

  describe("git_stash", () => {
    it("list returns 'No stashes' on a clean repo", async () => {
      const result = await callTool(tools, "git_stash", { action: "list" });
      assert.ok(!result.error, `Should not error: ${result.error}`);
      assert.ok(result.stashes.includes("No stashes"), `Got: ${result.stashes}`);
    });

    it("push stashes a dirty working tree", async () => {
      await fs.writeFile(path.join(tmpDir, "dirty.txt"), "uncommitted change");
      await execFile("git", ["add", "dirty.txt"], { cwd: tmpDir });
      const result = await callTool(tools, "git_stash", { action: "push", message: "test stash" });
      assert.ok(!result.error, `Should not error: ${result.error}`);
      assert.ok(result.success);
    });

    it("list shows the stash after push", async () => {
      const result = await callTool(tools, "git_stash", { action: "list" });
      assert.ok(!result.error);
      assert.ok(result.stashes.includes("test stash"), `Expected stash in list, got: ${result.stashes}`);
    });

    it("pop restores and removes the stash", async () => {
      const result = await callTool(tools, "git_stash", { action: "pop" });
      assert.ok(!result.error, `Should not error: ${result.error}`);
      assert.ok(result.success);
      // File should be back
      const exists = await fs.stat(path.join(tmpDir, "dirty.txt")).catch(() => null);
      assert.ok(exists, "Stashed file should be restored after pop");
      // Clean up
      await execFile("git", ["reset", "HEAD", "dirty.txt"], { cwd: tmpDir });
      await fs.rm(path.join(tmpDir, "dirty.txt")).catch(() => {});
    });
  });

  // ── git_reset ─────────────────────────────────────────────────────────────

  describe("git_reset", () => {
    it("unstages a specific file (paths mode)", async () => {
      await fs.writeFile(path.join(tmpDir, "staged.txt"), "staged content");
      await execFile("git", ["add", "staged.txt"], { cwd: tmpDir });

      // Verify it's staged
      const { stdout: statusBefore } = await execFile("git", ["status", "--short"], { cwd: tmpDir });
      assert.ok(statusBefore.includes("A "), "File should be staged before reset");

      const result = await callTool(tools, "git_reset", { paths: ["staged.txt"] });
      assert.ok(!result.error, `Should not error: ${result.error}`);
      assert.ok(result.success);

      const { stdout: statusAfter } = await execFile("git", ["status", "--short"], { cwd: tmpDir });
      assert.ok(!statusAfter.includes("A "), "File should be unstaged after reset");
      await fs.rm(path.join(tmpDir, "staged.txt")).catch(() => {});
    });

    it("mixed reset to HEAD succeeds", async () => {
      const result = await callTool(tools, "git_reset", { target: "HEAD", mode: "mixed" });
      assert.ok(!result.error, `Should not error: ${result.error}`);
      assert.ok(result.success);
    });
  });

  // ── git_branch ────────────────────────────────────────────────────────────

  describe("git_branch", () => {
    it("list returns current branch", async () => {
      const result = await callTool(tools, "git_branch", { action: "list" });
      assert.ok(!result.error, `Should not error: ${result.error}`);
      assert.ok(result.current, "Should have a current branch");
      assert.ok(Array.isArray(result.branches));
    });

    it("create makes a new branch", async () => {
      const result = await callTool(tools, "git_branch", { action: "create", name: "test-feature" });
      assert.ok(!result.error, `Should not error: ${result.error}`);
      assert.ok(result.success);

      const listResult = await callTool(tools, "git_branch", { action: "list" });
      assert.ok(listResult.branches.some(b => b.includes("test-feature")), "New branch should appear in list");
    });

    it("delete removes the branch", async () => {
      const result = await callTool(tools, "git_branch", { action: "delete", name: "test-feature" });
      assert.ok(!result.error, `Should not error: ${result.error}`);
      assert.ok(result.success);
    });

    it("create returns error when name is missing", async () => {
      const result = await callTool(tools, "git_branch", { action: "create" });
      assert.ok(result.error, "Should return error when name is missing");
    });
  });

  // ── git_merge ─────────────────────────────────────────────────────────────

  describe("git_merge", () => {
    it("merges a branch into current branch", async () => {
      const git = (args) => execFile("git", args, { cwd: tmpDir });
      // Create and populate a branch to merge
      await git(["checkout", "-b", "merge-source"]);
      await fs.writeFile(path.join(tmpDir, "from-branch.txt"), "branch content");
      await git(["add", "from-branch.txt"]);
      await git(["commit", "-m", "branch commit"]);
      // Switch back to original branch
      const { stdout } = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD~0"], { cwd: tmpDir }).catch(() => ({ stdout: "" }));
      const mainBranch = (await execFile("git", ["branch", "--list", "main", "master"], { cwd: tmpDir })).stdout.trim().replace("* ", "").split("\n")[0] || "main";
      // Get the first branch name
      const branches = (await execFile("git", ["branch"], { cwd: tmpDir })).stdout.trim().split("\n");
      const baseBranch = branches.find(b => !b.includes("merge-source"))?.trim().replace("* ", "") || "main";
      await git(["checkout", baseBranch]);

      const result = await callTool(tools, "git_merge", { branch: "merge-source" });
      assert.ok(!result.error, `Merge should succeed: ${result.error}`);
      assert.ok(result.success);

      // Clean up
      await git(["branch", "-d", "merge-source"]);
    });
  });

  // ── git_fetch ─────────────────────────────────────────────────────────────

  describe("git_fetch", () => {
    it("returns error gracefully when no remote is configured", async () => {
      const result = await callTool(tools, "git_fetch", { remote: "origin" });
      // No remote configured — should error, not throw
      assert.ok(result.error || result.success, "Should return either error or success, not throw");
      if (result.error) {
        assert.ok(
          result.error.toLowerCase().includes("fetch") || result.error.toLowerCase().includes("remote") || result.error.toLowerCase().includes("origin"),
          `Error should describe fetch failure, got: ${result.error}`
        );
      }
    });
  });

  // ── gating ────────────────────────────────────────────────────────────────

  it("returns empty array when allowGit is false", () => {
    const disabledTools = createGitTools({ ...makeCtx(tmpDir), allowGit: false });
    assert.equal(disabledTools.length, 0, "Should return empty array when git is disabled");
  });

  it("includes all Phase K tools in the tool list", () => {
    const names = tools.map(t => t.name);
    for (const expected of ["git_stash", "git_reset", "git_branch", "git_merge", "git_fetch"]) {
      assert.ok(names.includes(expected), `Tool list should include '${expected}'`);
    }
  });
});
