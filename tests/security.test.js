"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");

// We import from dist/ — build must be run before tests.
const { validatePath, parseProtectedPaths, safeFetch } = require("../dist/tools/helpers.js");

// ─── validatePath ────────────────────────────────────────────────────────────

describe("validatePath", () => {
  const base = path.join(os.tmpdir(), "toolbox-test-base");

  it("allows paths inside workspace", () => {
    const result = validatePath(base, "subdir/file.txt");
    assert.ok(result.startsWith(base));
  });

  it("blocks traversal outside workspace", () => {
    assert.throws(
      () => validatePath(base, "../../etc/passwd"),
      /Access Denied/
    );
  });

  it("blocks absolute paths outside workspace", () => {
    assert.throws(
      () => validatePath(base, "/etc/passwd"),
      /Access Denied/
    );
  });

  it("allows paths inside workspace with protectedPaths empty", () => {
    const result = validatePath(base, "file.txt", []);
    assert.ok(result.startsWith(base));
  });

  it("blocks path within a protected directory", () => {
    const protected1 = path.join(base, "secret");
    assert.throws(
      () => validatePath(base, "secret/data.txt", [protected1]),
      /protected path/
    );
  });

  it("blocks path equal to a protected directory exactly", () => {
    const protected1 = path.join(base, "secret");
    assert.throws(
      () => validatePath(base, "secret", [protected1]),
      /protected path/
    );
  });

  it("allows sibling of a protected directory", () => {
    const protected1 = path.join(base, "secret");
    const result = validatePath(base, "notSecret/file.txt", [protected1]);
    assert.ok(result.includes("notSecret"));
  });
});

// ─── parseProtectedPaths ─────────────────────────────────────────────────────

describe("parseProtectedPaths", () => {
  it("returns empty array for empty string", () => {
    assert.deepEqual(parseProtectedPaths(""), []);
  });

  it("parses newline-separated paths", () => {
    const result = parseProtectedPaths("/tmp/a\n/tmp/b");
    assert.equal(result.length, 2);
    assert.ok(result[0].includes("a"));
    assert.ok(result[1].includes("b"));
  });

  it("parses comma-separated paths", () => {
    const result = parseProtectedPaths("/tmp/a,/tmp/b");
    assert.equal(result.length, 2);
  });

  it("trims whitespace and ignores blank entries", () => {
    const result = parseProtectedPaths("  /tmp/a  \n\n  /tmp/b  \n");
    assert.equal(result.length, 2);
  });
});

// ─── safeFetch — SSRF protection ─────────────────────────────────────────────

describe("safeFetch SSRF protection", () => {
  it("rejects non-http/https scheme (ftp://)", async () => {
    await assert.rejects(
      () => safeFetch("ftp://example.com/file"),
      /only http.*https.*allowed/i
    );
  });

  it("rejects file:// scheme", async () => {
    await assert.rejects(
      () => safeFetch("file:///etc/passwd"),
      /only http.*https.*allowed/i
    );
  });

  it("rejects localhost", async () => {
    await assert.rejects(
      () => safeFetch("http://localhost/api"),
      /SSRF protection/
    );
  });

  it("rejects 127.0.0.1 (loopback)", async () => {
    await assert.rejects(
      () => safeFetch("http://127.0.0.1:8080/"),
      /SSRF protection/
    );
  });

  it("rejects 127.x.x.x range", async () => {
    await assert.rejects(
      () => safeFetch("http://127.0.0.2/"),
      /SSRF protection/
    );
  });

  it("rejects 10.x.x.x (RFC-1918)", async () => {
    await assert.rejects(
      () => safeFetch("http://10.0.0.1/"),
      /SSRF protection/
    );
  });

  it("rejects 172.16.x.x (RFC-1918)", async () => {
    await assert.rejects(
      () => safeFetch("http://172.16.0.1/"),
      /SSRF protection/
    );
  });

  it("rejects 192.168.x.x (RFC-1918)", async () => {
    await assert.rejects(
      () => safeFetch("http://192.168.1.1/"),
      /SSRF protection/
    );
  });

  it("rejects 169.254.x.x (link-local / cloud metadata)", async () => {
    await assert.rejects(
      () => safeFetch("http://169.254.169.254/latest/meta-data/"),
      /SSRF protection/
    );
  });

  it("rejects IPv6 loopback ::1", async () => {
    await assert.rejects(
      () => safeFetch("http://[::1]/"),
      /SSRF protection/
    );
  });

  it("rejects IPv6 link-local fe80::", async () => {
    await assert.rejects(
      () => safeFetch("http://[fe80::1]/"),
      /SSRF protection/
    );
  });

  it("does not reject a normal public URL (no actual request)", async () => {
    // We don't actually send the request — we just verify safeFetch doesn't
    // throw before the network call by aborting immediately.
    const ac = new AbortController();
    ac.abort();
    try {
      await safeFetch("https://example.com/", { signal: ac.signal });
    } catch (e) {
      // AbortError is expected — the SSRF check must have passed
      assert.ok(
        e.name === "AbortError" || e.name === "TimeoutError" || e.code === "ABORT_ERR",
        `Expected AbortError, got ${e.name}: ${e.message}`
      );
    }
  });
});
