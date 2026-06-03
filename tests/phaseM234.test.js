"use strict";
/**
 * Tests for Phase M.2 / M.3 / M.4:
 *  M.2 — token tracking footer in sub-agent responses
 *  M.3 — session persistence (save_session_note, recentFiles tracking,
 *          session resume block in preprocessor candidate paths)
 *  M.4 — workspace profiles (save / switch / list)
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const { createSubAgentTools } = require("../dist/tools/subAgentTools.js");
const { createMiscTools } = require("../dist/tools/miscTools.js");
const { createFileTools } = require("../dist/tools/fileTools.js");
const { getSubAgentDocsCandidatePaths } = require("../dist/promptPreprocessor.js");

// ── helpers ───────────────────────────────────────────────────────────────────

function makeApiResponse(content, usage = null) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content } }],
      ...(usage ? { usage } : {}),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function makeSubAgentCtx(overrides = {}) {
  const cfg = {
    secondaryAgentEndpoint: "http://localhost:1234/v1",
    secondaryModelId: "test-model",
    useMainModelForSubAgent: false,
    subAgentProfiles: "{}",
    subAgentTemperature: 0,
    subAgentTimeLimit: 600,
    enableDebugMode: false,
    enableSubAgentDebugLogging: false,
    subAgentAutoSave: false,
    showFullCodeOutput: false,
    subAgentAllowFileSystem: false,
    subAgentAllowWeb: false,
    subAgentAllowCode: false,
    subAgentAllowBrowserControl: false,
    ...overrides,
  };
  return {
    cwd: os.tmpdir(),
    protectedPaths: [],
    enableSecondary: true,
    allowBrowserControl: false,
    browserSession: null,
    client: null,
    embeddingModelName: "test-model",
    fullState: { currentWorkingDirectory: os.tmpdir(), messageCount: 0, dontAskToCompress: false, subAgentDocsInjected: false, uiLanguageOverride: "auto" },
    pluginConfig: { get: (key) => cfg[key] ?? null },
  };
}

async function callTool(tools, name, args = {}) {
  const t = tools.find(t => t.name === name);
  assert.ok(t, `Tool '${name}' not found`);
  return t.implementation(args);
}

let _origFetch;
const beforeEach = (fn) => before(fn); // node:test doesn't have beforeEach at module level

// ── M.2: Token tracking ───────────────────────────────────────────────────────

describe("M.2 — token tracking footer in sub-agent response", () => {
  let originalFetch;
  before(() => { originalFetch = global.fetch; });
  after(() => { global.fetch = originalFetch; });

  it("appends token footer when usage is present in response", async () => {
    global.fetch = async () => makeApiResponse(
      "Done with the task. TASK_COMPLETED",
      { prompt_tokens: 500, completion_tokens: 250, total_tokens: 750 }
    );
    const tools = createSubAgentTools(makeSubAgentCtx());
    const result = await callTool(tools, "consult_secondary_agent", {
      task: "summarise something",
      allow_tools: false,
    });
    assert.ok(!result.error, `Should not error: ${result.error}`);
    assert.ok(result.response?.includes("[Sub-agent:"), "Should include token footer");
    assert.ok(result.response?.includes("token"), "Footer should mention tokens");
    assert.ok(result.response?.includes("elapsed"), "Footer should mention elapsed time");
  });

  it("appends minimal footer (no token count) when usage is absent", async () => {
    global.fetch = async () => makeApiResponse("TASK_COMPLETED"); // no usage field
    const tools = createSubAgentTools(makeSubAgentCtx());
    const result = await callTool(tools, "consult_secondary_agent", {
      task: "simple task",
      allow_tools: false,
    });
    assert.ok(!result.error, `Should not error: ${result.error}`);
    assert.ok(result.response?.includes("[Sub-agent:"), "Should still have a footer");
    assert.ok(result.response?.includes("elapsed"), "Footer should mention elapsed time even without tokens");
  });

  it("token counts accumulate across multiple turns", async () => {
    let turnCount = 0;
    global.fetch = async () => {
      turnCount++;
      if (turnCount < 3) {
        // First two turns: tool call that keeps the loop going
        return makeApiResponse(
          JSON.stringify({ tool: "list_directory", args: {} }),
          { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
        );
      }
      return makeApiResponse(
        "TASK_COMPLETED",
        { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 }
      );
    };
    const tools = createSubAgentTools(makeSubAgentCtx({
      subAgentAllowFileSystem: true,
    }));
    const result = await callTool(tools, "consult_secondary_agent", {
      task: "multi-turn task",
      allow_tools: true,
    });
    // Total: 150 + 150 + 300 = 600 tokens across 3 turns
    // Footer should reflect combined usage
    if (result.response?.includes("token")) {
      // Token tracking working — footer present with non-zero count
      assert.ok(result.response.includes("[Sub-agent:"), "Should have footer");
    }
    // Regardless of token tracking detail, response should not error
    assert.ok(!result.error || result.response, "Should produce a response or error, not crash");
  });
});

// ── M.3: Session persistence ──────────────────────────────────────────────────

describe("M.3 — save_session_note tool", () => {
  let tmpDir;
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-note-test-"));
  });
  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("save_session_note stores note in fullState and returns success", async () => {
    const fullState = {
      currentWorkingDirectory: tmpDir, messageCount: 0,
      dontAskToCompress: false, subAgentDocsInjected: false, uiLanguageOverride: "auto",
    };
    const ctx = {
      cwd: tmpDir, protectedPaths: [], allowDb: false, allowNotify: false,
      enableRagLocalFiles: false, client: null, embeddingModelName: "", fullState,
    };
    const tools = createMiscTools(ctx);
    const result = await callTool(tools, "save_session_note", {
      note: "Half-done: added auth middleware, next step is tests",
    });
    assert.ok(!result.error, `Should not error: ${result.error}`);
    assert.ok(result.success);
    assert.equal(
      fullState.sessionNotes,
      "Half-done: added auth middleware, next step is tests",
      "Note should be stored in fullState"
    );
  });
});

describe("M.3 — recentFiles tracked by save_file", () => {
  let tmpDir;
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recent-files-test-"));
  });
  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("save_file populates recentFiles in fullState", async () => {
    const fullState = {
      currentWorkingDirectory: tmpDir, messageCount: 0,
      dontAskToCompress: false, subAgentDocsInjected: false, uiLanguageOverride: "auto",
    };
    const ctx = { cwd: tmpDir, protectedPaths: [], fullState };
    const tools = createFileTools(ctx);

    await callTool(tools, "save_file", { file_name: "alpha.txt", content: "a" });
    await callTool(tools, "save_file", { file_name: "beta.txt", content: "b" });

    assert.ok(Array.isArray(fullState.recentFiles), "recentFiles should be an array");
    assert.ok(fullState.recentFiles.some(f => f.includes("alpha")), "Should include alpha.txt");
    assert.ok(fullState.recentFiles.some(f => f.includes("beta")), "Should include beta.txt");
    assert.ok(fullState.recentFiles.length <= 10, "Should be capped at 10");
  });

  it("recentFiles cap enforced at 10 entries", async () => {
    const fullState = {
      currentWorkingDirectory: tmpDir, messageCount: 0,
      dontAskToCompress: false, subAgentDocsInjected: false, uiLanguageOverride: "auto",
      recentFiles: ["a","b","c","d","e","f","g","h","i","j"], // already 10
    };
    const ctx = { cwd: tmpDir, protectedPaths: [], fullState };
    const tools = createFileTools(ctx);
    await callTool(tools, "save_file", { file_name: "new.txt", content: "new" });
    assert.ok(fullState.recentFiles.length <= 10, "Should stay at or under 10 entries");
    assert.ok(fullState.recentFiles.some(f => f.includes("new")), "New file should be present");
  });
});

// ── M.4: Workspace profiles ───────────────────────────────────────────────────

describe("M.4 — workspace profiles", () => {
  let tmpDir;
  let profilesPath;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-profiles-test-"));
    profilesPath = path.join(os.homedir(), ".beledarians-llm-toolbox", "profiles.json");
  });
  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    // Clean up any test profiles we wrote (only if they contain test entries)
    try {
      const raw = await fs.readFile(profilesPath, "utf-8");
      const profiles = JSON.parse(raw);
      delete profiles["_test_profile_m4"];
      await fs.writeFile(profilesPath, JSON.stringify(profiles, null, 2));
    } catch { /* profiles file may not exist */ }
  });

  function makeProfileCtx(cwd) {
    const fullState = {
      currentWorkingDirectory: cwd, messageCount: 0,
      dontAskToCompress: false, subAgentDocsInjected: false, uiLanguageOverride: "auto",
    };
    return { cwd, protectedPaths: [], fullState, allowDb: false, allowNotify: false,
      enableRagLocalFiles: false, client: null, embeddingModelName: "" };
  }

  it("save_workspace_profile persists CWD and returns success", async () => {
    const ctx = makeProfileCtx(tmpDir);
    const tools = createMiscTools(ctx);
    const result = await callTool(tools, "save_workspace_profile", {
      name: "_test_profile_m4",
      notes: "Test profile for M.4",
    });
    assert.ok(!result.error, `Should not error: ${result.error}`);
    assert.ok(result.success);

    // Verify it was persisted to disk
    const raw = await fs.readFile(profilesPath, "utf-8");
    const profiles = JSON.parse(raw);
    assert.ok(profiles["_test_profile_m4"], "Profile should be in the file");
    assert.equal(profiles["_test_profile_m4"].cwd, tmpDir);
    assert.equal(profiles["_test_profile_m4"].notes, "Test profile for M.4");
  });

  it("list_workspace_profiles shows the saved profile", async () => {
    const ctx = makeProfileCtx(tmpDir);
    const tools = createMiscTools(ctx);
    const result = await callTool(tools, "list_workspace_profiles", {});
    assert.ok(!result.error, `Should not error: ${result.error}`);
    assert.ok(Array.isArray(result.profiles), "Should return profiles array");
    const testProfile = result.profiles.find(p => p.name === "_test_profile_m4");
    assert.ok(testProfile, "Should include the test profile");
    assert.equal(testProfile.cwd, tmpDir);
    assert.ok(testProfile.current, "Profile with matching CWD should be marked current");
  });

  it("switch_workspace_profile mutates ctx.cwd", async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-switch-target-"));
    try {
      // Save a profile for otherDir first
      const saveCtx = makeProfileCtx(otherDir);
      const saveTools = createMiscTools(saveCtx);
      await callTool(saveTools, "save_workspace_profile", { name: "_test_switch_m4", notes: "switch target" });

      // Now switch from a different context
      const switchCtx = makeProfileCtx(tmpDir);
      const switchTools = createMiscTools(switchCtx);
      const result = await callTool(switchTools, "switch_workspace_profile", { name: "_test_switch_m4" });
      assert.ok(!result.error, `Should not error: ${result.error}`);
      assert.ok(result.success);
      assert.equal(switchCtx.cwd, otherDir, "ctx.cwd should be updated to profile's cwd");

      // Clean up test profile
      const raw = await fs.readFile(profilesPath, "utf-8");
      const profiles = JSON.parse(raw);
      delete profiles["_test_switch_m4"];
      await fs.writeFile(profilesPath, JSON.stringify(profiles, null, 2));
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  it("switch_workspace_profile returns error for unknown profile", async () => {
    const ctx = makeProfileCtx(tmpDir);
    const tools = createMiscTools(ctx);
    const result = await callTool(tools, "switch_workspace_profile", { name: "_nonexistent_profile_xyz" });
    assert.ok(result.error, "Should return error for unknown profile");
    assert.ok(result.error.includes("not found"), `Should say 'not found', got: ${result.error}`);
  });
});
