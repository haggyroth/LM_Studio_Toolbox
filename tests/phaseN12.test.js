"use strict";
/**
 * Tests for N.12: custom plugin loader (loadPlugins).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const { loadPlugins } = require("../dist/pluginLoader.js");

describe("loadPlugins", () => {
  let pluginDir;

  before(async () => {
    pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), "n12-plugins-"));
  });

  after(async () => {
    await fs.rm(pluginDir, { recursive: true, force: true });
  });

  it("returns empty array when directory does not exist", async () => {
    const result = await loadPlugins("/tmp/does-not-exist-lmstoolbox-test-xyz");
    assert.deepEqual(result, []);
  });

  it("returns empty array when directory is empty", async () => {
    const result = await loadPlugins(pluginDir);
    assert.deepEqual(result, []);
  });

  it("loads a simple object-export plugin (no-parameter case)", async () => {
    await fs.writeFile(path.join(pluginDir, "simple.js"), `
      module.exports = {
        name: "hello_world",
        description: "Says hello",
        implementation: async () => ({ greeting: "Hello, World" }),
      };
    `, "utf-8");
    const tools = await loadPlugins(pluginDir);
    const t = tools.find(t => t.name === "hello_world");
    assert.ok(t, "hello_world tool should be loaded");
    assert.equal(t.name, "hello_world");
  });

  it("calls the loaded plugin implementation", async () => {
    const tools = await loadPlugins(pluginDir);
    const t = tools.find(t => t.name === "hello_world");
    assert.ok(t);
    const result = await t.implementation({}, {});
    assert.deepEqual(result, { greeting: "Hello, World" });
  });

  it("loads a factory-function plugin (receives { z }, raw shape)", async () => {
    await fs.writeFile(path.join(pluginDir, "factory.js"), `
      module.exports = function({ z }) {
        return {
          name: "add_numbers",
          description: "Adds two numbers",
          parameters: { a: z.number(), b: z.number() },
          implementation: async ({ a, b }) => ({ result: a + b }),
        };
      };
    `, "utf-8");
    const tools = await loadPlugins(pluginDir);
    const t = tools.find(t => t.name === "add_numbers");
    assert.ok(t, "add_numbers tool should be loaded");
    const result = await t.implementation({ a: 3, b: 4 }, {});
    assert.equal(result.result, 7);
  });

  it("loads a factory-function plugin with z.object() parameters (unwrapped automatically)", async () => {
    await fs.writeFile(path.join(pluginDir, "factory_obj.js"), `
      module.exports = function({ z }) {
        return {
          name: "multiply",
          description: "Multiplies two numbers",
          parameters: z.object({ x: z.number(), y: z.number() }),
          implementation: async ({ x, y }) => ({ result: x * y }),
        };
      };
    `, "utf-8");
    const tools = await loadPlugins(pluginDir);
    const t = tools.find(t => t.name === "multiply");
    assert.ok(t, "multiply tool should be loaded");
    const result = await t.implementation({ x: 6, y: 7 }, {});
    assert.equal(result.result, 42);
  });

  it("loads an array-export plugin (multiple tools from one file)", async () => {
    await fs.writeFile(path.join(pluginDir, "multi.js"), `
      module.exports = [
        { name: "tool_alpha", implementation: async () => ({ value: "alpha" }) },
        { name: "tool_beta",  implementation: async () => ({ value: "beta"  }) },
      ];
    `, "utf-8");
    const tools = await loadPlugins(pluginDir);
    assert.ok(tools.some(t => t.name === "tool_alpha"), "tool_alpha should be loaded");
    assert.ok(tools.some(t => t.name === "tool_beta"),  "tool_beta should be loaded");
  });

  it("skips entries missing a name, does not crash", async () => {
    await fs.writeFile(path.join(pluginDir, "badname.js"), `
      module.exports = { description: "no name here", implementation: async () => ({}) };
    `, "utf-8");
    // Should not throw; the bad entry is silently skipped
    const tools = await loadPlugins(pluginDir);
    assert.ok(!tools.some(t => t.name === undefined));
  });

  it("skips entries missing implementation, does not crash", async () => {
    await fs.writeFile(path.join(pluginDir, "badimpl.js"), `
      module.exports = { name: "no_impl", description: "missing impl" };
    `, "utf-8");
    const tools = await loadPlugins(pluginDir);
    assert.ok(!tools.some(t => t.name === "no_impl"));
  });

  it("skips a file with a syntax error, does not crash the loader", async () => {
    await fs.writeFile(path.join(pluginDir, "broken.js"), `this is not valid javascript }{`, "utf-8");
    // loadPlugins should catch the require() error and continue
    await assert.doesNotReject(() => loadPlugins(pluginDir));
  });

  it("ignores non-.js files in the plugin directory", async () => {
    await fs.writeFile(path.join(pluginDir, "readme.md"), "# not a plugin", "utf-8");
    await fs.writeFile(path.join(pluginDir, "data.json"), `{"name":"not_a_tool"}`, "utf-8");
    const tools = await loadPlugins(pluginDir);
    assert.ok(!tools.some(t => t.name === "not_a_tool"));
  });

  it("uses default description when none is provided", async () => {
    await fs.writeFile(path.join(pluginDir, "nodesc.js"), `
      module.exports = { name: "no_description", implementation: async () => ({}) };
    `, "utf-8");
    const tools = await loadPlugins(pluginDir);
    const t = tools.find(t => t.name === "no_description");
    assert.ok(t, "no_description tool should be loaded");
  });
});
