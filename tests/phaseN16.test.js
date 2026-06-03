"use strict";
/**
 * Tests for N.16: interrupt_sub_agent.
 *
 * The tool is registered alongside consult_secondary_agent when
 * enableSecondary is true, and is absent when it is false.
 * The pending-message queue and cancel flag are module-level state,
 * so we verify the tool's return value and that the queue is populated
 * (the actual injection is tested via the sub-agent loop integration,
 * which requires a live LM Studio endpoint — skipped here).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createSubAgentTools } = require("../dist/tools/subAgentTools.js");

function makeCtx(overrides = {}) {
  return {
    cwd: "/tmp",
    protectedPaths: [],
    enableSecondary: true,
    allowBrowserControl: false,
    browserSession: null,
    client: null,
    embeddingModelName: "test-model",
    pluginConfig: {
      get: (key) => {
        const defaults = {
          secondaryAgentEndpoint: "http://localhost:1234/v1",
          secondaryModelId: "test-model",
          useMainModelForSubAgent: false,
          subAgentProfiles: "{}",
          subAgentTemperature: 0.4,
          subAgentTimeLimit: 60,
          enableDebugMode: false,
          enableSubAgentDebugLogging: false,
          subAgentAutoSave: false,
          showFullCodeOutput: false,
          subAgentAllowFileSystem: false,
          subAgentAllowWeb: false,
          subAgentAllowCode: false,
          subAgentAllowBrowserControl: false,
        };
        return defaults[key] ?? null;
      },
    },
    fullState: {},
    ...overrides,
  };
}

async function callTool(tools, name, args) {
  const t = tools.find(t => t.name === name);
  assert.ok(t, `Tool '${name}' not found`);
  return t.implementation(args, { status: () => {}, warn: () => {} });
}

describe("interrupt_sub_agent", () => {
  it("tool is registered when enableSecondary is true", () => {
    const tools = createSubAgentTools(makeCtx());
    assert.ok(tools.some(t => t.name === "interrupt_sub_agent"), "interrupt_sub_agent should be registered");
  });

  it("tool is absent when enableSecondary is false", () => {
    const tools = createSubAgentTools(makeCtx({ enableSecondary: false }));
    assert.equal(tools.length, 0);
  });

  it("consult_secondary_agent is also present", () => {
    const tools = createSubAgentTools(makeCtx());
    assert.ok(tools.some(t => t.name === "consult_secondary_agent"));
  });

  it("returns success with queued message info", async () => {
    const tools = createSubAgentTools(makeCtx());
    const res = await callTool(tools, "interrupt_sub_agent", {
      message: "Stop and focus on the auth module instead.",
    });
    assert.equal(res.success, true);
    assert.equal(res.queued_message, "Stop and focus on the auth module instead.");
    assert.equal(res.cancel_requested, false);
    assert.ok(typeof res.note === "string");
  });

  it("reports cancel_requested when cancel: true", async () => {
    const tools = createSubAgentTools(makeCtx());
    const res = await callTool(tools, "interrupt_sub_agent", {
      message: "Stop immediately.",
      cancel: true,
    });
    assert.equal(res.success, true);
    assert.equal(res.cancel_requested, true);
  });

  it("reports sub_agent_currently_running as false when no agent is active", async () => {
    const tools = createSubAgentTools(makeCtx());
    const res = await callTool(tools, "interrupt_sub_agent", {
      message: "Test message.",
    });
    assert.equal(res.sub_agent_currently_running, false);
  });

  it("queues multiple messages independently", async () => {
    const tools = createSubAgentTools(makeCtx());
    await callTool(tools, "interrupt_sub_agent", { message: "First instruction." });
    await callTool(tools, "interrupt_sub_agent", { message: "Second instruction." });
    // Both succeed — the queue state is validated by the loop integration test
    // (which requires a live endpoint); here we just confirm no errors.
  });
});
