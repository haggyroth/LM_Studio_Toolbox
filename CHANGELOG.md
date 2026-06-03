# Changelog

All notable changes to **LM Studio Toolbox** are documented here.

This project follows [Semantic Versioning](https://semver.org/):
- **MAJOR** — breaking changes (storage paths, removed tools, renamed config keys)
- **MINOR** — new tools, new parameters, new config fields (backward-compatible)
- **PATCH** — bug fixes, security patches, documentation corrections

---

## [Unreleased]

---

## [3.8.0] — 2026-06-03

### Added
- **Custom plugin system** — drop a `.js` file into `~/.lm-studio-toolbox/plugins/` and its exported tool definitions are registered alongside built-ins at startup. Plugins may export a plain object, an array, or a factory function called with `{ z }` so they don't need to resolve Zod themselves. Both raw Zod shapes `{ key: z.string() }` and wrapped `z.object({})` are accepted for parameters (ZodObject is unwrapped automatically). Bad plugin files are skipped with a console warning — they never prevent the rest of the toolbox from loading. No config flag required; the directory is scanned automatically (N.12)
- New `src/pluginLoader.ts` module exporting `loadPlugins(pluginDir?)` for independent use and testing
- 12 new integration tests in `tests/phaseN12.test.js`

---

## [3.7.0] — 2026-06-03

### Added
- **`rename_symbol`** — workspace-wide atomic TypeScript/JavaScript rename using `ts-morph`. Locates the declaration, calls `node.rename(newName)` (updates all reference sites in memory), then writes every modified file atomically via a temp-and-rename approach. Returns the list of modified files. Validates that `new_name` is a legal identifier before touching anything (N.14)
- **`edit_file_with_diff`** — apply a unified diff to a single file with a built-in validate-then-apply flow. Runs `git apply --check` first; if the patch won't apply cleanly the file is left untouched and a clear error + hint is returned. Auto-adds `--- a/` / `+++ b/` headers if omitted. Returns line count after edit (N.15)
- 9 new integration tests in `tests/phaseN14N15.test.js` covering both tools

---

## [3.6.0] — 2026-06-03

### Added
- **`watch_file`** — start watching a single file for changes. Returns a watcher ID; events are buffered (last 50) and readable via `list_watches` (N.8)
- **`watch_directory`** — start watching a directory; optional `recursive` flag monitors subdirectories. Same event-buffer pattern as `watch_file` (N.8)
- **`stop_watch`** — stop a watcher by ID (N.8)
- **`list_watches`** — list all active/stopped watchers with their buffered change events; optional `watcher_id` for a single entry (N.8)
- **`capture_screenshot`** — one-shot URL screenshot: launches headless Puppeteer, navigates, captures PNG to the workspace, and returns path + metadata. Supports viewport sizing, full-page capture, selector wait, and post-navigation delay. Gated behind `allowBrowserControl` (N.10)
- 15 new integration tests in `tests/phaseN8N10.test.js` (12 for watchers, 3 for screenshot guard paths)

---

## [3.5.0] — 2026-06-03

### Added
- **`find_symbol`** — locate where a TypeScript/JavaScript symbol is defined across the workspace using AST analysis. Supports functions, classes, interfaces, type aliases, variables, and enums. Optional `kind` filter narrows results. No false positives from comments or string literals (N.9)
- **`find_usages`** — trace all reference sites for a symbol after locating its declaration. Returns `{ file, line, context }` per reference; optional `definition_file` resolves name ambiguity and speeds up lookup. Excludes `node_modules` automatically (N.9)
- `ts-morph` moved from `devDependencies` to `dependencies` so AST tools are available at plugin runtime
- 13 new integration tests in `tests/phaseN9.test.js` covering both tools

---

## [3.4.0] — 2026-06-03

### Added
- **`query_csv`** — filter and project a CSV file without Python. Supports `=`, `!=`, `>`, `<`, `>=`, `<=`, and `contains` operators on any column; optional column projection; configurable row limit. Uses an inline RFC-4180 parser that handles quoted fields with embedded commas and escaped double-quotes (N.7)
- **`transform_json`** — extract values from a JSON file with a dot-path expression. Supports nested key access (`config.server.port`), array indexing (`users[0].name`), and `[*]` wildcards that collect across all array elements (`users[*].tags[*]`). Returns `found: false` cleanly on missing paths instead of throwing (N.7)
- 21 new integration tests in `tests/phaseN7.test.js` covering both tools

---

## [3.3.0] — 2026-06-03

### Changed
- **`run_test_command` streaming output** — test results now stream line-by-line through `toolCtx.status()` as they arrive. Users see `PASS src/auth.test.ts` ticking through the LM Studio UI sidebar instead of a frozen spinner for the full test run duration (N.3)

---

## [3.2.0] — 2026-06-03

### Added
- **`search_directory` exclusion patterns** — new `exclude: string[]` parameter skips additional directories or filename globs (e.g. `["dist", "coverage", "*.min.js"]`). `node_modules` and `.git` are always excluded (N.5)
- **Audit log** — new `enableAuditLog` config field (default: off). When enabled, writes an NDJSON entry to `~/.lm-studio-toolbox/audit.log` for every tool call: tool name, args summary (truncated at 80 chars), result status (`ok`/`error`/`throw`), and elapsed ms. Implemented as a transparent wrapper in `toolsProvider` (N.11)

---

## [3.1.0] — 2026-06-03

### Added
- **`analyze_project`** — single-call workspace orientation: directory tree, package manifest summary, git status + last 5 commits, file counts by extension, detected scripts (`test`, `build`, `dev`, `lint`). Replaces 6–8 manual tool calls at session start (N.6)
- **`read_file` token estimate** — response now includes `_meta: { lines, approx_tokens }` so the model can decide whether to use `read_file_range` for large files (N.2)
- **`git_diff` word-level mode** — new `word_diff: true` parameter passes `--word-diff=plain`; LLMs parse word-level diffs more accurately for prose/doc changes (N.4)

### Fixed
- **Atomic file writes** — `save_file`, sub-agent `save_file`/`replace_text_in_file`, and auto-save code blocks now write to a `.tmp` file and `rename()` into place. A crash mid-write can no longer leave a half-written file (N.1)

---

## [3.0.0] — 2026-06-03

### ⚠️ Breaking Changes
- **Storage directory renamed:** `~/.beledarians-llm-toolbox/` → `~/.lm-studio-toolbox/`
  Move your existing directory to preserve saved state, workspace profiles, and MCP config.
  Workspace `.memories.db` files are stored per-project and are unaffected.
- **Sub-agent project journal renamed:** `beledarian_info.md` → `toolbox_info.md`
- **Startup file directory renamed:** `.beledarian/startup.md` → `.toolbox/startup.md`
- **Package name:** `beledarians-lm-studio-tools` → `lm-studio-toolbox`
- **Manifest owner:** `beledarian` → `haggyroth`

### Added
- MCP server mode (`npm run mcp`) — expose all tools to Claude Desktop, Cursor, VS Code Copilot Chat, and any MCP-compatible client via stdio transport (Phase M.5)
- Live tool status updates via `ToolCallContext.status()` — visible in LM Studio's UI sidebar during long-running operations (Phase M.1)
- Token tracking footer on every sub-agent response: `[Sub-agent: 3 turns, ~8k tokens, 12.4s]` (Phase M.2)
- Session persistence: `save_session_note` tool, `lastBrowserUrl` tracking, `recentFiles` list, `[Resumed session]` block injected on first turn (Phase M.3)
- Workspace profiles: `save_workspace_profile`, `switch_workspace_profile`, `list_workspace_profiles` (Phase M.4)
- RAG embedding cache keyed by `model::path::mtime` — switching models no longer produces silent NaN results (Phase G)
- `cosineSimilarity` length guard — mismatched dimensions return `0` with a warning instead of `NaN` (Phase G)
- LRU eviction cap (200 entries) on the embedding cache (Phase G)
- Test coverage for `webTools`, `query_database`, and sub-agent orchestration (Phase H)
- Sub-agent role chaining (`chain: ["tester", "reviewer"]`) (Phase J)
- Sub-agent readonly mode (`readonly: true`) (Phase J)
- 8 built-in sub-agent role presets: `coder`, `reviewer`, `researcher`, `debugger`, `tester`, `documenter`, `planner`, `data_analyst` (Phase J)
- Sub-agent retry with backoff on connection errors (Phase J)
- `git_stash`, `git_reset`, `git_branch`, `git_merge`, `git_fetch` tools (Phase K)
- `apply_patch` tool — apply unified diffs via `git apply` (Phase L)
- Parallel `search_directory` — 8× concurrent file reads (Phase L)
- Extended `read_document` — now handles `.txt`, `.md`, `.json` (with validation), `.csv` (row count + header), `.xml`, and any text format (Phase L)
- `disabledTools` config field — exclude specific tools from the model's tool list (Phase L)
- `save_session_note`, `save_workspace_profile`, `switch_workspace_profile`, `list_workspace_profiles` tools
- Phase N roadmap with 16 proposed improvements

### Fixed
- `query_database` connection not closed on error path (Phase I)
- DuckDuckGo `fetch` provider had no timeout (Phase I)
- SSRF guard bypassed via HTTP redirects — `safeFetch` now uses `redirect: "manual"` and re-validates every `Location` header (Phase F)
- IPv6 ULA range check missed `fc01`–`fcff` (was `startsWith("fc00")`, fixed to `startsWith("fc")`) (Phase F)
- IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) not blocked (Phase F)
- `198.0.0.0/8` over-blocked — only `198.18–19/15` and `198.51.100/24` are reserved (Phase F)

---

## [2.0.0] — 2026-06-02

### ⚠️ Breaking Changes
- Forked from `Beledarian/Beledarians_LM_Studio_Toolbox` — repository moved to `haggyroth/LM_Studio_Toolbox`

### Added
- Full SQLite-backed memory CRUD: `save_memory`, `list_memories`, `search_memories`, `update_memory`, `delete_memory`
- Memory injection into first-turn context (top 50 entries)
- `protectedPaths` config enforced in `validatePath()` and `change_directory` (was defined but never read)
- `subAgentTimeLimit` wall-clock deadline enforced with `AbortSignal`
- `safeFetch()` central SSRF helper — all web tools route through it
- `query_database` hardened: rejects `ATTACH`, `PRAGMA`, path-traversal on `db_path`
- Browser scheme allowlist (`file://`, `javascript:` blocked)
- Sub-agent `finish_task` handled as clean termination
- Parser alias `search_file_content` → `search_in_file` fixed
- ESLint flat config + `npm run ci` pipeline
- `c8` coverage reporting (`npm run coverage`)
- `git_add`, `git_checkout`, `git_pull`, `git_push` tools
- GitHub CLI tools (`gh_auth`, `gh_create_issue`, `gh_create_pr`, `gh_list_issues`, etc.)
- RAG embedding cache keyed by `path + mtime`
- Memory DB connection cached per-path (single open per session)
- Temp scripts for `run_python`/`run_javascript` moved to `os.tmpdir()`
- Python sandbox smoke tests, fileTools integration tests, security SSRF tests

### Fixed
- `simple-git` RCE (GHSA-jcxm-m3jx-f287) and 7 other CVEs via `npm audit fix`
- `subAgentTimeLimit` config defined but never consumed
- `protectedPaths` config defined but never consumed

---

## [1.3.x] and earlier

See the [original upstream repository](https://github.com/Beledarian/Beledarians_LM_Studio_Toolbox) for pre-fork history.
