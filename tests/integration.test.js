"use strict";
/**
 * Integration tests for the sub-agent pipeline.
 *
 * Two suites:
 *
 * 1. "Realistic multi-turn pipeline" — no live LM Studio needed.
 *    Mocks global.fetch with scripted model responses that contain real
 *    JSON tool calls.  The tool *execution* (read_file, save_file, etc.)
 *    runs against a genuine temp directory so we can assert actual
 *    filesystem outcomes.  This catches dispatch bugs, atomic-write
 *    failures, path-validation errors, and loop-exit conditions that the
 *    unit tests (with their simple TASK_COMPLETED mocks) cannot.
 *
 * 2. "Live LM Studio smoke test" — skipped unless LM Studio is reachable.
 *    Sends a trivial task to the real endpoint and verifies the pipeline
 *    can complete at least one turn without crashing.  Run this manually
 *    when you have a model loaded.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const { createSubAgentTools } = require("../dist/tools/subAgentTools.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides = {}) {
  const cfg = {
    secondaryAgentEndpoint: "http://localhost:1234/v1",
    secondaryModelId:       "test-model",
    useMainModelForSubAgent: false,
    subAgentProfiles:       "{}",
    subAgentTemperature:    0,
    subAgentTimeLimit:      60,
    subAgentLoopLimit:      8,
    enableDebugMode:        false,
    enableSubAgentDebugLogging: false,
    subAgentAutoSave:       false,
    showFullCodeOutput:     false,
    subAgentAllowFileSystem: true,
    subAgentAllowWeb:       false,
    subAgentAllowCode:      false,
    subAgentAllowBrowserControl: false,
    ...overrides,
  };
  return { get: (key) => cfg[key] ?? null };
}

function makeCtx(cwd, overrides = {}) {
  return {
    cwd,
    protectedPaths:   [],
    enableSecondary:  true,
    allowBrowserControl: false,
    browserSession:   null,
    client:           null,
    embeddingModelName: "test-model",
    pluginConfig:     makeConfig(),
    fullState:        {},
    ...overrides,
  };
}

/** Respond to GET (pre-flight) with 200; feed scripted replies for POST. */
function makeScriptedFetch(replies) {
  let call = 0;
  return async (url, opts) => {
    if (!opts?.body) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const reply = replies[call] ?? replies[replies.length - 1];
    call++;
    const content = typeof reply === "function" ? reply(JSON.parse(opts.body)) : reply;
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

async function callTool(tools, name, args) {
  const t = tools.find(t => t.name === name);
  assert.ok(t, `Tool '${name}' not found`);
  return t.implementation(args, { status: () => {}, warn: () => {} });
}

let _origFetch;
before(() => { _origFetch = global.fetch; });

// ── Suite 1: realistic multi-turn pipeline ────────────────────────────────────

describe("realistic multi-turn pipeline (no live endpoint needed)", () => {
  let tmpDir, tools;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "integration-"));
    await fs.writeFile(path.join(tmpDir, "hello.txt"), "Hello, world!", "utf-8");
    tools = createSubAgentTools(makeCtx(tmpDir));
  });

  after(async () => {
    global.fetch = _origFetch;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("list_directory → read_file → save_file → TASK_COMPLETED produces real file", async () => {
    global.fetch = makeScriptedFetch([
      // Turn 1: model lists the directory
      JSON.stringify({ tool: "list_directory", args: {} }),
      // Turn 2: model reads the file it found
      JSON.stringify({ tool: "read_file", args: { file_name: "hello.txt" } }),
      // Turn 3: model writes a new file based on what it read
      JSON.stringify({ tool: "save_file", args: { file_name: "output.txt", content: "Processed: Hello, world!" } }),
      // Turn 4: model signals completion
      "I have processed the file and saved output.txt. TASK_COMPLETED",
    ]);

    const result = await callTool(tools, "consult_secondary_agent", {
      task: "Read hello.txt, transform it, and save output.txt",
      agent_role: "general",
    });

    // Pipeline should complete without error
    assert.ok(!result.error, `Expected no error, got: ${result.error}`);

    // The file should actually exist on disk
    const content = await fs.readFile(path.join(tmpDir, "output.txt"), "utf-8");
    assert.equal(content, "Processed: Hello, world!");

    // generatedFiles should list it
    assert.ok(
      result.generated_files?.includes("output.txt") ||
      result.response?.includes("output.txt"),
      "output.txt should appear in generated_files or response"
    );
  });

  it("invalid tool call is returned as error string — loop continues, not aborted", async () => {
    global.fetch = makeScriptedFetch([
      // Turn 1: model calls save_file but forgets file_name — validation error
      JSON.stringify({ tool: "save_file", args: { content: "oops, no filename" } }),
      // Turn 2: model corrects itself and saves properly
      JSON.stringify({ tool: "save_file", args: { file_name: "corrected.txt", content: "fixed!" } }),
      // Turn 3: done
      "File saved. TASK_COMPLETED",
    ]);

    const result = await callTool(tools, "consult_secondary_agent", {
      task: "Save a file called corrected.txt",
      agent_role: "general",
    });

    assert.ok(!result.error, `Loop should have continued after validation error, got: ${result.error}`);
    const content = await fs.readFile(path.join(tmpDir, "corrected.txt"), "utf-8").catch(() => null);
    assert.equal(content, "fixed!", "corrected.txt should have been written on the retry turn");
  });

  it("TASK_FAILED surfaces as structured error — loop exits immediately", async () => {
    global.fetch = makeScriptedFetch([
      // Turn 1: model gives up immediately
      "I cannot complete this task. TASK_FAILED",
    ]);

    const result = await callTool(tools, "consult_secondary_agent", {
      task: "Do something impossible",
      agent_role: "general",
    });

    assert.ok(result.error, "TASK_FAILED should produce an error field");
    assert.equal(result.status, "failed");
    assert.ok(
      result.error.toLowerCase().includes("failed") || result.error.toLowerCase().includes("task"),
      `Error should describe the failure: ${result.error}`
    );
  });

  it("stall detection returns status:stalled after 3 no-tool turns", async () => {
    global.fetch = makeScriptedFetch([
      "I'm thinking about this...",
      "Let me consider the approach...",
      "Still planning...",
    ]);

    const result = await callTool(tools, "consult_secondary_agent", {
      task: "Do something",
      agent_role: "general",
    });

    assert.ok(result.error, "Stalled agent should return an error");
    assert.equal(result.status, "stalled");
  });

  it("list_directory result includes type and size_bytes", async () => {
    let capturedToolResult = "";
    global.fetch = makeScriptedFetch([
      // Turn 1: model lists the directory
      JSON.stringify({ tool: "list_directory", args: {} }),
      // Turn 2: model echoes what it got and completes
      (body) => {
        const userMsg = body.messages.find(m => m.role === "user" && m.content.includes("Tool Output"));
        if (userMsg) capturedToolResult = userMsg.content;
        return "TASK_COMPLETED";
      },
    ]);

    await callTool(tools, "consult_secondary_agent", {
      task: "List the directory",
      agent_role: "general",
    });

    // The tool output injected back into the model should have type and size
    const parsed = JSON.parse(capturedToolResult.replace("Tool Output: ", ""));
    assert.ok(Array.isArray(parsed), "list_directory result should be an array");
    const file = parsed.find(e => e.name === "hello.txt");
    assert.ok(file, "hello.txt should appear in listing");
    assert.equal(file.type, "file");
    assert.ok(typeof file.size_bytes === "number", "size_bytes should be a number");
  });

  it("read_file truncation notice is prepended not appended", async () => {
    // Write a large file
    const bigContent = "x".repeat(35000);
    await fs.writeFile(path.join(tmpDir, "big.txt"), bigContent, "utf-8");

    let capturedToolResult = "";
    global.fetch = makeScriptedFetch([
      JSON.stringify({ tool: "read_file", args: { file_name: "big.txt" } }),
      (body) => {
        const userMsg = body.messages.find(m => m.role === "user" && m.content.includes("Tool Output"));
        if (userMsg) capturedToolResult = userMsg.content;
        return "TASK_COMPLETED";
      },
    ]);

    await callTool(tools, "consult_secondary_agent", {
      task: "Read big.txt",
      agent_role: "general",
    });

    // Notice should be at the START of the tool output
    const toolOutput = capturedToolResult.replace("Tool Output: ", "");
    assert.ok(
      toolOutput.startsWith("[FILE TRUNCATED"),
      `Truncation notice should be prepended, got: ${toolOutput.substring(0, 80)}`
    );
  });

  it("get_sub_agent_result retrieves the last run without starting a new session", async () => {
    global.fetch = makeScriptedFetch([
      "Completed the work. TASK_COMPLETED",
    ]);

    // First, run a task to populate the result file
    await callTool(tools, "consult_secondary_agent", {
      task: "Do a quick task",
      agent_role: "general",
    });

    // Now retrieve it without starting a new run — no fetch should be called
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return new Response("{}", { status: 200 }); };

    const result = await callTool(tools, "get_sub_agent_result", {});

    assert.ok(!fetchCalled, "get_sub_agent_result should not call the LLM endpoint");
    assert.ok(!result.error, `Should return a result, got: ${result.error}`);
    assert.ok(result.task || result.response !== undefined, "Result should have task or response field");
  });

  // ── H: execution log ─────────────────────────────────────────────────────────

  it("execution log appears in response and has correct shape", async () => {
    global.fetch = makeScriptedFetch([
      JSON.stringify({ tool: "list_directory", args: {} }),
      JSON.stringify({ tool: "read_file", args: { file_name: "hello.txt" } }),
      JSON.stringify({ tool: "save_file", args: { file_name: "logged.txt", content: "done" } }),
      "All done. TASK_COMPLETED",
    ]);

    const result = await callTool(tools, "consult_secondary_agent", {
      task: "List, read, and save",
      agent_role: "general",
    });

    assert.ok(!result.error, `Should complete without error, got: ${result.error}`);
    assert.ok(result.response.includes("[Execution log:"), "Response should contain execution log header");
    assert.ok(result.response.includes("list_directory"), "Log should include list_directory");
    assert.ok(result.response.includes("read_file(hello.txt)"), "Log should include read_file with key arg");
    assert.ok(result.response.includes("save_file(logged.txt)"), "Log should include save_file with key arg");
  });

  it("execution log entry shows error detail for failed tool calls", async () => {
    global.fetch = makeScriptedFetch([
      // Turn 1: deliberately bad save (file_name missing — validator catches it)
      JSON.stringify({ tool: "save_file", args: { content: "no filename here" } }),
      // Turn 2: model corrects itself
      JSON.stringify({ tool: "save_file", args: { file_name: "recovered.txt", content: "ok" } }),
      "TASK_COMPLETED",
    ]);

    const result = await callTool(tools, "consult_secondary_agent", {
      task: "Save a file",
      agent_role: "general",
    });

    assert.ok(!result.error);
    // The log should show the error detail for the failed first turn
    assert.ok(result.response.includes("error"), "Log should surface the validation error outcome");
    assert.ok(
      result.response.includes("TOOL_VALIDATION_ERROR") || result.response.includes("file_name"),
      "Error detail should describe what went wrong"
    );
  });

  it("execution log is absent when no tools are called", async () => {
    global.fetch = makeScriptedFetch([
      "Here is a direct answer. TASK_COMPLETED",
    ]);

    const result = await callTool(tools, "consult_secondary_agent", {
      task: "Just answer a question",
      agent_role: "general",
      allow_tools: false,
    });

    assert.ok(!result.error);
    assert.ok(!result.response.includes("[Execution log:"), "No log should appear when no tools were called");
  });
});

// ── Suite 2: live LM Studio smoke test ───────────────────────────────────────

describe("live LM Studio smoke test (skipped when endpoint unreachable)", () => {
  let liveAvailable = false;
  let liveEndpoint = "http://localhost:1234/v1";
  let liveModelId = "local-model";
  let tmpDir, tools;

  before(async () => {
    global.fetch = _origFetch; // restore real fetch for live tests
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "integration-live-"));
    try {
      const res = await fetch(`${liveEndpoint}/models`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) {
        const data = await res.json();
        liveModelId = data?.data?.[0]?.id ?? "local-model";
        liveAvailable = true;
      }
    } catch { /* LM Studio not running — all live tests will skip */ }

    tools = createSubAgentTools(makeCtx(tmpDir, {
      pluginConfig: makeConfig({
        secondaryAgentEndpoint: liveEndpoint,
        secondaryModelId:       liveModelId,
        subAgentTimeLimit:      30,
        subAgentLoopLimit:      3,
        subAgentAllowFileSystem: true,
      }),
    }));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("sub-agent can complete a trivial no-tools task against a live model", async function () {
    if (!liveAvailable) { this.skip?.(); return; }

    const result = await callTool(tools, "consult_secondary_agent", {
      task: "Reply with exactly the word DONE and nothing else.",
      agent_role: "general",
      allow_tools: false,
    });

    // We don't assert on the exact response — models vary — but the pipeline
    // should complete without crashing or timing out.
    assert.ok(
      !result.error || result.status === "stalled",
      `Live sub-agent should complete or stall cleanly, got error: ${result.error}`
    );
    assert.ok(typeof result.response === "string", "Should return a string response");
    console.log(`[live test] model: ${liveModelId}, response: "${result.response?.substring(0, 100)}"`);
  });

  it("pre-flight rejects a completely unreachable endpoint", async () => {
    // Use a port that's guaranteed to be closed
    const tools2 = createSubAgentTools(makeCtx(tmpDir, {
      pluginConfig: makeConfig({
        secondaryAgentEndpoint: "http://localhost:19999/v1",
        secondaryModelId: "ghost-model",
        subAgentTimeLimit: 10,
      }),
    }));

    const result = await callTool(tools2, "consult_secondary_agent", {
      task: "This should fail immediately",
      agent_role: "general",
    });

    assert.ok(result.error, "Should return an error for unreachable endpoint");
    assert.ok(
      result.error.toLowerCase().includes("reach") ||
      result.error.toLowerCase().includes("connect") ||
      result.error.toLowerCase().includes("endpoint"),
      `Error should mention connectivity, got: ${result.error}`
    );
  });
});
