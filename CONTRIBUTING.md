# Contributing to LM Studio Toolbox

Thank you for your interest in contributing! This guide covers everything you need to get set up, write a new tool, and submit a pull request.

---

## Quick Start

```bash
git clone https://github.com/haggyroth/LM_Studio_Toolbox.git
cd LM_Studio_Toolbox
npm install
npm run typecheck   # verify everything compiles
npm test            # run the full test suite
```

Development mode (hot-reload inside LM Studio):

```bash
lms dev             # requires LM Studio CLI (lms) to be installed
```

---

## Project Structure

```
src/
  tools/
    fileTools.ts      — file system operations
    codeTools.ts      — code execution, linting, AST tools (ts-morph)
    webTools.ts       — web search, fetch, RAG
    browserTools.ts   — Puppeteer browser automation
    gitTools.ts       — git operations (simple-git)
    githubTools.ts    — GitHub CLI wrappers
    miscTools.ts      — clipboard, DB, documents, memory, CSV/JSON, audit
    memoryTools.ts    — SQLite-backed long-term memory
    subAgentTools.ts  — secondary LM Studio agent orchestration
    context.ts        — ToolContext interface (shared state)
    helpers.ts        — validatePath, safeFetch, RAG helpers
  toolsProvider.ts    — assembles all tools; applies disabledTools filter
  promptPreprocessor.ts — context injection, memory, session resume
  pluginLoader.ts     — loads user plugins from ~/.lm-studio-toolbox/plugins/
  mcpServer.ts        — MCP server entry point (npm run mcp)
  config.ts           — plugin config schema (LM Studio settings panel)
  stateManager.ts     — PluginState persistence (~/.lm-studio-toolbox/)
tests/               — Node.js built-in test runner; one file per feature area
examples/
  plugins/            — example custom plugin files
```

---

## Adding a New Built-In Tool

Every tool module exports a factory function `create<Module>Tools(ctx: ToolContext): Tool[]`. Add your tool inside the appropriate factory:

```typescript
// src/tools/miscTools.ts (example)
import { tool, type Tool } from "@lmstudio/sdk";
import { z } from "zod";

// Inside createMiscTools(ctx):
tools.push(tool({
  name: "my_new_tool",
  description: "One sentence: what it does and when to use it.",
  parameters: {
    input:   z.string().describe("The input value."),
    verbose: z.boolean().optional().default(false),
  },
  implementation: async ({ input, verbose }, toolCtx) => {
    // toolCtx.status("Working…") emits a live status in LM Studio's sidebar
    toolCtx?.status?.("Processing…");
    // Always return a plain object — never throw (return { error: "..." } instead)
    return { result: input.toUpperCase(), verbose };
  },
}));
```

**Key rules:**

| Rule | Detail |
|------|--------|
| Return `{ error: "..." }` for failures | Never throw — the model needs to read the error |
| Use `validatePath(ctx.cwd, path, ctx.protectedPaths)` | For any file path the model provides |
| Gate optional features with a `ctx.allow*` flag | See `ToolContext` in `context.ts` |
| Use `toolCtx?.status?.()` for progress | Shows in the LM Studio sidebar during long ops |
| Atomic writes via temp + rename | Use the `atomicWrite` pattern from `fileTools.ts` |

### ToolContext reference

```typescript
interface ToolContext {
  cwd: string;                    // current working directory (mutable)
  browserSession: BrowserSession | null;
  fullState: PluginState;         // persisted state (save via savePersistedState)
  client: LMStudioClient | null;  // null in MCP mode
  pluginConfig: { get(key: string): any };
  // Permission flags (checked before registering tools):
  allowJavascript / allowPython / allowTerminal / allowShell
  allowBrowserControl / allowGit / allowDb / allowNotify / allowGitHubTools
  enableMemory / enableWikipedia / enableLocalRag / enableSecondary
  embeddingModelName: string;
  protectedPaths: string[];
}
```

---

## Writing Tests

Tests use Node.js's built-in `node:test` runner (no Jest or Mocha). Add your test file in `tests/` and register it in the `test` script in `package.json`.

```javascript
// tests/myTool.test.js
"use strict";
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { createMiscTools } = require("../dist/tools/miscTools.js"); // always use dist/

function makeCtx(cwd, overrides = {}) {
  return { cwd, protectedPaths: [], ...overrides };
}

describe("my_new_tool", () => {
  let tmpDir, tools;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "my-tool-"));
    tools = createMiscTools(makeCtx(tmpDir));
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns uppercased input", async () => {
    const t = tools.find(t => t.name === "my_new_tool");
    assert.ok(t);
    const res = await t.implementation({ input: "hello" }, {});
    assert.equal(res.result, "HELLO");
  });
});
```

**Note on `better-sqlite3`:** The native SQLite binding does not compile against Node 26.x. Tests that require it use a runtime skip guard:

```javascript
let sqliteAvailable = false;
try {
  const db = new (require("better-sqlite3"))(":memory:"); db.close();
  sqliteAvailable = true;
} catch {}

it("sqlite test", async function () {
  if (!sqliteAvailable) { this.skip?.(); return; }
  // ... test body
});
```

LM Studio ships its own pre-built binaries for the embedded Node version, so `better-sqlite3` works correctly at runtime — just not in the test environment with system Node 26.

---

## MCP Server Mode

The toolbox can expose its tools to Claude Desktop, Cursor, and any MCP-compatible client:

```bash
npm run build
node dist/mcpServer.js
```

**Claude Desktop config** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "lm-studio-toolbox": {
      "command": "node",
      "args": ["/absolute/path/to/LM_Studio_Toolbox/dist/mcpServer.js"]
    }
  }
}
```

The MCP server reads `~/.lm-studio-toolbox/mcp-config.json`. Copy `mcp-config.example.json` from the project root to get started.

---

## Custom Plugins

Power users can add domain-specific tools by dropping `.js` files into `~/.lm-studio-toolbox/plugins/`. See **[PLUGINS.md](PLUGINS.md)** for the full guide and **`examples/plugins/`** for working examples:

| File | What it demonstrates |
|------|----------------------|
| `examples/plugins/hello_world.js` | Minimal plain-object export |
| `examples/plugins/call_rest_api.js` | Factory export with typed Zod parameters and `fetch` |
| `examples/plugins/deploy_tools.js` | Array export — multiple tools per file with `child_process` |

---

## Workflow

1. **Branch from `main`** with a descriptive name: `feat/my-tool` or `fix/the-bug`
2. **Add tests** — at least a happy path and one error path per new tool
3. **Run `npm run typecheck && npm test`** — both must pass
4. **Bump the version** in `package.json` following semver (new tool = minor; bug fix = patch)
5. **Update `CHANGELOG.md`** with a concise entry under `[Unreleased]`
6. **Open a PR** against `main` on `haggyroth/LM_Studio_Toolbox`

PRs that add tools without tests, break existing tests, or skip the typecheck will be asked to revise before merge.

---

## Coding Standards

- **TypeScript strict mode** — avoid `any` where possible; use `// eslint-disable-next-line @typescript-eslint/no-explicit-any` with a brief comment when unavoidable
- **No bare `throw`** inside tool implementations — return `{ error: "..." }` instead
- **Path safety** — always use `validatePath()` for model-provided file paths
- **No global state mutations** between tool calls — all mutable state lives in `ToolContext` or explicitly managed module-level maps (e.g. `backgroundCommands`, `fileWatchers`)

## Questions?

Open an issue or start a discussion on GitHub. Contributions of all sizes are welcome!

## License

By contributing you agree that your contributions will be licensed under the [ISC License](LICENSE), the same license as this project.
