"use strict";
/**
 * Tests for N.7: query_csv and transform_json in createMiscTools.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const { createMiscTools } = require("../dist/tools/miscTools.js");

function makeCtx(tmpDir, overrides = {}) {
  return {
    cwd: tmpDir,
    protectedPaths: [],
    allowDb: false,
    allowNotify: false,
    enableLocalRag: false,
    client: null,
    embeddingModelName: "test-model",
    fullState: {},
    pluginConfig: {},
    ...overrides,
  };
}

async function callTool(tools, name, args) {
  const t = tools.find(t => t.name === name);
  assert.ok(t, `Tool '${name}' not found`);
  return t.implementation(args, {});
}

// ── query_csv ────────────────────────────────────────────────────────────────

describe("query_csv", () => {
  let tmpDir;
  let tools;
  const CSV_SIMPLE = [
    "name,age,city",
    "Alice,30,London",
    "Bob,25,Paris",
    "Charlie,35,London",
    "Diana,28,Berlin",
  ].join("\n");

  const CSV_QUOTED = [
    'id,description,price',
    '1,"Widget, deluxe",9.99',
    '2,"Gadget ""Pro""",19.99',
    '3,Thingamajig,4.50',
  ].join("\n");

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "n7-csv-"));
    await fs.writeFile(path.join(tmpDir, "people.csv"), CSV_SIMPLE, "utf-8");
    await fs.writeFile(path.join(tmpDir, "products.csv"), CSV_QUOTED, "utf-8");
    tools = createMiscTools(makeCtx(tmpDir));
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns all rows with headers when no filter", async () => {
    const res = await callTool(tools, "query_csv", { file: "people.csv" });
    assert.equal(res.total_rows, 4);
    assert.equal(res.returned, 4);
    assert.deepEqual(res.columns, ["name", "age", "city"]);
    assert.equal(res.rows[0].name, "Alice");
  });

  it("filters with = operator (case-insensitive)", async () => {
    const res = await callTool(tools, "query_csv", { file: "people.csv", filter: "city = London" });
    assert.equal(res.matched_rows, 2);
    assert.ok(res.rows.every(r => r.city.toLowerCase() === "london"));
  });

  it("filters with > numeric operator", async () => {
    const res = await callTool(tools, "query_csv", { file: "people.csv", filter: "age > 29" });
    assert.equal(res.matched_rows, 2); // Alice(30), Charlie(35)
  });

  it("filters with contains operator", async () => {
    const res = await callTool(tools, "query_csv", { file: "people.csv", filter: "name contains ali" });
    assert.equal(res.matched_rows, 1);
    assert.equal(res.rows[0].name, "Alice");
  });

  it("filters with != operator", async () => {
    const res = await callTool(tools, "query_csv", { file: "people.csv", filter: "city != London" });
    assert.equal(res.matched_rows, 2); // Bob, Diana
  });

  it("projects selected columns", async () => {
    const res = await callTool(tools, "query_csv", { file: "people.csv", columns: ["name", "city"] });
    assert.deepEqual(res.columns, ["name", "city"]);
    assert.ok(!("age" in res.rows[0]));
  });

  it("respects row limit", async () => {
    const res = await callTool(tools, "query_csv", { file: "people.csv", limit: 2 });
    assert.equal(res.returned, 2);
    assert.equal(res.matched_rows, 4);
  });

  it("reports unknown columns without crashing", async () => {
    const res = await callTool(tools, "query_csv", { file: "people.csv", columns: ["name", "bogus"] });
    assert.ok(Array.isArray(res.unknown_columns));
    assert.ok(res.unknown_columns.includes("bogus"));
  });

  it("parses quoted fields with embedded commas and escaped quotes", async () => {
    const res = await callTool(tools, "query_csv", { file: "products.csv" });
    assert.equal(res.total_rows, 3);
    assert.equal(res.rows[0].description, "Widget, deluxe");
    assert.equal(res.rows[1].description, 'Gadget "Pro"');
  });

  it("returns error on invalid filter expression", async () => {
    const res = await callTool(tools, "query_csv", { file: "people.csv", filter: "not-a-filter" });
    assert.ok(typeof res.error === "string");
    assert.ok(res.error.includes("Invalid filter"));
  });

  it("returns error for missing file", async () => {
    const res = await callTool(tools, "query_csv", { file: "nonexistent.csv" });
    assert.ok(typeof res.error === "string");
  });
});

// ── transform_json ───────────────────────────────────────────────────────────

describe("transform_json", () => {
  let tmpDir;
  let tools;
  const DATA = {
    config: { server: { port: 8080, host: "localhost" }, debug: false },
    users: [
      { id: 1, name: "Alice", tags: ["admin", "user"] },
      { id: 2, name: "Bob", tags: ["user"] },
    ],
    meta: { version: "1.0.0" },
  };

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "n7-json-"));
    await fs.writeFile(path.join(tmpDir, "data.json"), JSON.stringify(DATA), "utf-8");
    await fs.writeFile(path.join(tmpDir, "bad.json"), "{ not valid json", "utf-8");
    tools = createMiscTools(makeCtx(tmpDir));
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("extracts a deeply nested scalar", async () => {
    const res = await callTool(tools, "transform_json", { file: "data.json", path_expression: "config.server.port" });
    assert.equal(res.found, true);
    assert.equal(res.result, 8080);
  });

  it("extracts an array element by index", async () => {
    const res = await callTool(tools, "transform_json", { file: "data.json", path_expression: "users[0].name" });
    assert.equal(res.found, true);
    assert.equal(res.result, "Alice");
  });

  it("extracts nested array element via index chain", async () => {
    const res = await callTool(tools, "transform_json", { file: "data.json", path_expression: "users[1].tags[0]" });
    assert.equal(res.found, true);
    assert.equal(res.result, "user");
  });

  it("wildcard collects values from all array items", async () => {
    const res = await callTool(tools, "transform_json", { file: "data.json", path_expression: "users[*].name" });
    assert.equal(res.found, true);
    assert.deepEqual(res.result, ["Alice", "Bob"]);
    assert.equal(res.count, 2);
  });

  it("wildcard on nested arrays flattens results", async () => {
    const res = await callTool(tools, "transform_json", { file: "data.json", path_expression: "users[*].tags[*]" });
    assert.equal(res.found, true);
    assert.deepEqual(res.result, ["admin", "user", "user"]);
  });

  it("returns found:false for a missing key", async () => {
    const res = await callTool(tools, "transform_json", { file: "data.json", path_expression: "config.missing" });
    assert.equal(res.found, false);
    assert.equal(res.result, null);
  });

  it("returns found:false for an out-of-bounds index", async () => {
    const res = await callTool(tools, "transform_json", { file: "data.json", path_expression: "users[99].name" });
    assert.equal(res.found, false);
  });

  it("returns error for invalid JSON", async () => {
    const res = await callTool(tools, "transform_json", { file: "bad.json", path_expression: "x" });
    assert.ok(typeof res.error === "string");
    assert.ok(res.error.includes("Invalid JSON"));
  });

  it("returns error for missing file", async () => {
    const res = await callTool(tools, "transform_json", { file: "ghost.json", path_expression: "x" });
    assert.ok(typeof res.error === "string");
  });

  it("returns a boolean false value (not confused with found:false)", async () => {
    const res = await callTool(tools, "transform_json", { file: "data.json", path_expression: "config.debug" });
    assert.equal(res.found, true);
    assert.equal(res.result, false);
  });
});
