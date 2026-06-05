# Changelog

All notable changes to **LM Studio Toolbox** are documented here.

This project follows [Semantic Versioning](https://semver.org/):
- **MAJOR** — breaking changes (storage paths, removed tools, renamed config keys)
- **MINOR** — new tools, new parameters, new config fields (backward-compatible)
- **PATCH** — bug fixes, security patches, documentation corrections

---

## [Unreleased]

---

## [3.14.1] — 2026-06-04

### Changed
- **`manifest.json` owner updated to `puppytucker`** — aligns the plugin registry owner field with the active LM Studio Hub account so `lms push` succeeds.
- **`push` script simplified** — removed the `rebuild:lmstudio` pre-step that was included in earlier versions. The step does not fix macOS code-signing restrictions and broke the development test environment when run.

### Fixed
- **`query_database` returns an actionable error on macOS** — when LM Studio's hardened runtime rejects the `better-sqlite3` native addon due to Team ID mismatch (`dlopen` / code signature error), the tool now returns a clear message explaining the restriction and suggesting a standalone Node environment, rather than surfacing a raw crash dump.

---

## [3.14.0] — 2026-06-04

### Added
- **`search_directory`: `max_matches` parameter** — controls the upper bound on returned matches (default 100, range 1–500). All three internal match-cap paths now respect this value. A truncation notice is appended when the limit is reached.
- **`subAgentShowExecutionLog` config field** — boolean setting (default `true`) that controls whether a compact `[Execution log: N tool calls]` block is appended to every sub-agent response. Set to `false` to suppress.
- **Memory JSON fallback backend** — a pure-JS `JsonMemoryDb` class activates automatically when `require("better-sqlite3")` fails (e.g. LM Studio's macOS code-signing sandbox). All memory tools (`save_memory`, `list_memories`, `search_memories`, `update_memory`, `delete_memory`) work transparently regardless of backend.

---

## [3.13.4] — 2026-06-04

### Added
- **Sub-agent execution log** — every `consult_secondary_agent` response now appends a compact `[Execution log: N tool calls]` block listing each tool call, its key argument, and the outcome. Errors auto-expand with detail. Controlled by the new `subAgentShowExecutionLog` config field.
- **`search_directory` documented in `subagent_docs.md`** — added to the File System section with parameter descriptions and structured return format.
- **`search_directory` added to tool-selection priority notes** — clarifies when to use `search_directory` (multi-file) vs `search_in_file` (single file).
- **`search_directory` added to LITE key-tools list** in `toolsDocumentation.ts`.

### Fixed
- **Memory deduplication** — `save_memory` now checks `LOWER(fact) = LOWER(?)` before inserting. Exact-match duplicates (case-insensitive) return `{ deduplicated: true, id: existingId }` instead of inserting a second row. `insertAutoMemory` silently skips duplicates on the same path.

---

## [3.13.2] — 2026-06-04

### Added
- **429 rate-limit retry in sub-agent** — `fetchWithRetry` honours the `Retry-After` response header (seconds or HTTP-date format), waits the indicated time capped by the remaining deadline, and retries up to `MAX_RATE_LIMIT_RETRIES` (3) times before surfacing the error. Separate retry budget from network-error retries.

---

## [3.13.0] — 2026-06-04

### Added
- **Integration test suite** (`tests/integration.test.js`) — mock-pipeline tests covering the full `consult_secondary_agent` round-trip including: execution log shape, error detail expansion, log suppression via config, stall/timeout/cancel status fields, and `turn_log` accumulation across chained roles. Live LM Studio smoke test auto-skips when unreachable.
- **`turn_log` field on all return paths** — `runAgentLoop` now attaches `turnLog` to stalled, failed, timeout, and cancelled results in addition to completed ones. Outer wrapper accumulates logs from primary + chain roles into a single `turn_log` array on the final response.
- **`status` field preserved on error path** — outer wrapper previously stripped `status` when propagating `primaryResult.error`. Fixed to forward `{ error, status, turn_log }`.

### Changed
- **Validator coverage expanded** — `toolCallValidator.ts` now validates 16 additional tools: `read_file_range`, `search_in_file`, `append_file`, `find_files`, `fuzzy_find_local_files`, `delete_files_by_pattern`, `web_search` / `duckduckgo_search`, `wikipedia_search`, `fetch_web_content` / `rag_web_content`, `run_python`, `run_javascript`, `run_test_command`, `insert_at_line`, `delete_lines_in_file`, `delete_path`, `move_file`, `copy_file`, `make_directory`, `search_directory`, `rag_local_files`.
- **`subagent_docs.md` rewritten** — consolidated tool reference with accurate parameter names, structured examples, and tool-selection priority guidance.

---

## [3.12.3] — 2026-06-03

### Changed
- **`list_directory` in sub-agent now returns file metadata** — previously returned a bare array of filenames (`["a.ts", "b.ts"]`). Now returns `[{name, type, size_bytes}]` so the model can distinguish files from directories and choose what to read without a separate stat call, saving 1–2 turns per workspace orientation.
- **Read truncation notice prepended, not appended** — `read_file` and auto-fallback reads previously appended `\n... (truncated)` at the end of 30 000-character dumps, where the model might not see it. The notice is now prepended: `[FILE TRUNCATED — showing first 30,000 of N chars. Use read_file_range for specific line ranges.]` so the model knows immediately that the content is partial.
- **Endpoint retry backoff changed from fixed 5 s to exponential 1 s → 2 s → 4 s** — the previous 5 s × 2 retries = up to 10 s wasted per turn on a transient failure, multiplied across 8 turns. Exponential backoff (base 1 s, cap at remaining deadline) is faster when the endpoint recovers quickly and still backs off appropriately when it doesn't.

---

## [3.12.2] — 2026-06-03

### Added
- **`run_test_command` available to sub-agents** — the `tester` and `debugger` roles can now call `run_test_command` to execute test suites (`npm test`, `pytest`, etc.) directly inside the sub-agent loop. Previously only `run_python` and `run_javascript` were available for code execution, leaving the tester role unable to run the project's own test runner.
- **`subAgentLoopLimit` config field** — controls the maximum number of LLM turns per sub-agent run (default: 8, range: 1–30). Previously hardcoded to 8 at both the primary and chain call sites. Use a lower value for simple tasks to save tokens; raise it for complex multi-step refactors.

### Fixed
- **`replace_text_in_file` no longer errors on multiple matches** — previously returned an error when `old_string` appeared more than once, forcing the model to craft a more specific string before proceeding. Now replaces the first occurrence and reports: `"Replaced the first of N occurrences. Call again to replace the next, or use a more specific old_string."` This matches the expected behaviour and avoids wasting a turn on a recoverable situation.
- **`delete_files_by_pattern` scope documented in tool result** — the tool only searches the immediate workspace root directory (not recursive), which was undocumented and caused silent mismatches when the model expected subdirectory matches. The success and no-match messages now explicitly state this and suggest `find_files + individual deletes` for recursive patterns.

---

## [3.12.1] — 2026-06-03

### Security
- **SSRF protection for sub-agent web fetch** — `fetch_web_content` and `rag_web_content` inside the sub-agent loop now use `safeFetch()` instead of raw `fetch()`. This blocks requests to private IPs (RFC-1918), loopback, link-local addresses, and non-HTTP schemes — matching the protection that the main agent's web tools already had. The previous code allowed a confused or compromised sub-agent to reach internal network endpoints.

### Fixed
- **Empty tool output no longer replaced with "Tool not found"** — `toolResult` is now initialised as `undefined` instead of `""`. The fallthrough guard uses `=== undefined`. A tool that legitimately returns an empty string (e.g., a Python script that prints nothing, or `list_directory` on an empty folder) no longer triggers the error path.
- **`run_python` / `run_javascript` now surface both stdout and stderr** — previously `res.stderr ? stderr : stdout` discarded stdout whenever stderr was non-empty (common with Python deprecation warnings). Both streams are now returned when both are non-empty: `stdout + "\n[stderr]: " + stderr`.
- **`search_in_file` invalid regex no longer aborts the agent run** — a bad regex pattern (`new RegExp(pattern)` throwing `SyntaxError`) was caught by the outer loop catch and returned as a fatal error, terminating the run. Now regex construction has its own try/catch that sets `toolResult` to an error string and lets the loop continue. A ReDoS pre-check (same pattern as `delete_files_by_pattern`) is also applied.
- **`web_search` now has a timeout** — DuckDuckGo requests had no `AbortSignal`. A slow response could block indefinitely and consume the entire remaining deadline. Wrapped in `Promise.race([search(...), timeout(remainingMs)])`.
- **Stall detection now returns `status: "stalled"` with an actionable message** — previously the loop broke and fell through to the normal `status: "completed"` return, making it impossible for the main model to distinguish a completed task from a stalled one. Now returns `{ error: "...", status: "stalled" }` with a hint to split the task or add context.
- **"Tool not found" error now lists available tools** — instead of a bare `"Error: Tool not found or not allowed."`, the message now includes the full list of allowed tools for the current session so the model knows what to call instead.

---

## [3.12.0] — 2026-06-03

### Fixed
- **`TASK_FAILED` now returns `{ error }` explicitly** — previously the sub-agent loop would break on `TASK_FAILED` and surface the raw response to the main model (which might include the string "TASK_FAILED" buried in prose). Now it returns a structured `{ error: "Sub-agent failed: ...", status: "failed" }` so the main model immediately knows the task didn't complete.
- **Context pruning now preserves the task message** — when the message list exceeds 20 entries, both the system prompt (`msgList[0]`) and the original task message (`msgList[1]`) are kept alongside the 16 most recent messages. Previously only the system prompt was kept, causing the model to forget its objective mid-run.

### Added
- **Pre-flight endpoint health check** — before the agent loop starts, a `GET {endpoint}/models` call with a 4-second timeout verifies the secondary endpoint is reachable and returns a clear, actionable error if not (instead of silently failing for 8 turns).
- **Role-implied tool access** — file-writing roles (`coder`, `reviewer`, `debugger`, `tester`, `documenter`, `planner`, `data_analyst`, `general`) now have filesystem access enabled automatically based on their role, without requiring the main model to pass `allow_tools: true`. Individual tool categories are still gated by the user's `subAgentAllowFileSystem`/`subAgentAllowWeb`/`subAgentAllowCode` config flags.
- **`get_sub_agent_result` tool** — retrieves the last sub-agent result from `~/.lm-studio-toolbox/last_sub_agent_result.json` without starting a new session. Solves the "main model calls sub-agent repeatedly" problem — the main model can use this to re-read output after a context reset.
- **Result persistence** — every completed sub-agent run is written to `~/.lm-studio-toolbox/last_sub_agent_result.json` (task summary, response snippet, generated files, timestamp).
- **"general" role persona** added to default `subAgentProfiles` — gives the general-purpose role clear direction instead of falling back to a blank `"You are a helpful assistant."` prompt.
- **Empty-output warning** — when tools were enabled but the sub-agent produced no output and wrote no files, a diagnostic message is appended explaining what to check.
- **`SUB_AGENT.md`** — comprehensive guide covering how the pipeline works, LM Link remote model considerations, role→tool mapping table, common failure modes, and a debugging checklist.
- Improved `consult_secondary_agent` description listing all roles with one-line descriptions and noting that file-writing roles have filesystem access automatically.
- `status: "completed" | "failed" | "timeout" | "cancelled"` field in all `runAgentLoop` return values.

---

## [3.11.1] — 2026-06-03

### Fixed
- **MCP server version** — the server was advertising `"2.0.0"` to MCP clients regardless of the actual package version. It now reads `package.json` at startup and passes the real version to `McpServer`.

### Added
- **`examples/plugins/`** — three annotated example plugin files covering all supported export patterns:
  - `hello_world.js` — minimal plain-object export
  - `call_rest_api.js` — factory export with typed Zod parameters and `fetch`
  - `deploy_tools.js` — array export with two related `child_process` tools

### Changed
- **`CONTRIBUTING.md`** — full rewrite: project structure map, tool factory pattern with code example, `ToolContext` reference, test setup with the `better-sqlite3` skip caveat, MCP Claude Desktop config snippet, custom plugin links, and coding standards

---

## [3.11.0] — 2026-06-03

### Added
- **`list_tools`** — meta-tool registered in `toolsProvider.ts` after all tools are assembled. Returns every enabled tool with its name and a one-line description. Optional `filter` parameter searches name and description case-insensitively. Always present regardless of config flags. Useful at the start of a session to discover what's available without reading the system prompt (Phase O2)
- **`tool_usage_stats`** — reads `~/.lm-studio-toolbox/audit.log` (written by the N.11 audit log) and returns per-tool call counts, average elapsed ms, and error rates. Gated on `enableAuditLog` being on; returns a clear error when the log is disabled. Sortable by `calls`, `avg_ms`, or `errors` (Phase O2)

### Changed
- **`analyze_project`** — now calls `toolCtx.status()` between each of its five sections (directory tree, manifest, git, file counts, done) so users see progress in the LM Studio sidebar during long workspace scans. Also extended detected commands to include `start`, `format`, `check`, `typecheck`, and `ci` scripts alongside `test`, `build`, `dev`, and `lint` (Phase O2)

---

## [3.10.1] — 2026-06-03

### Fixed
- **`analyze_project` name collision** — `codeTools.ts` had a tool named `analyze_project` (runs linting) that shadowed the workspace-orientation tool of the same name in `miscTools.ts`. Renamed the linting tool to **`lint_project`** with an updated description. The workspace-orientation `analyze_project` in `miscTools.ts` is unaffected.
- **Stale ESLint disable directive** — removed an unused `// eslint-disable-next-line @typescript-eslint/no-explicit-any` in `mcpServer.ts` line 180; the `server.tool()` call on the following line uses `Record<string, unknown>`, not `any`.

### Added
- **`PLUGINS.md`** — user-facing guide covering all three plugin formats (plain object, factory function, array export), parameter schema options, error handling behaviour, and practical examples.

---

## [3.10.0] — 2026-06-03

### Added
- **Auto-capture memory** — when `memoryAutoCapture` is enabled (default: off) and `enableMemory` is on, key facts are automatically distilled from the conversation every N turns (controlled by `memoryAutoCaptureInterval`, default: 5) and saved to the memory database. Uses the configured Secondary Agent endpoint for extraction. The extraction prompt asks for 3–7 specific, useful facts; results are tagged `"auto"` in the DB to distinguish them from manually saved memories. Runs fire-and-forget and never blocks the user's turn (N.13)
- Two new config fields: `memoryAutoCapture` (boolean, default off) and `memoryAutoCaptureInterval` (integer slider 1–20, default 5)
- `recentUserMessages` rolling buffer added to `PluginState` (capped at 15 entries) — supplies context to the extractor without requiring full history access
- `getDb` exported from `memoryTools.ts`; new `insertAutoMemory(cwd, fact)` exported helper
- 6 tests in `tests/phaseN13.test.js` (3 pass unconditionally; 3 require the native SQLite binding)

---

## [3.9.0] — 2026-06-03

### Added
- **`interrupt_sub_agent`** — queue a steering message or cancellation for the current or next sub-agent run. Messages are injected as system messages at the start of the next agent turn via a module-level pending queue. If `cancel: true`, also signals the loop to exit cleanly after its current turn and return partial results with `status: "cancelled"`. Returns `sub_agent_currently_running` so callers know whether the message applies to an active run or will be held for the next one (N.16)
- Sub-agent loop now checks `pendingSubAgentMessages` and `cancelSubAgentRequested` at the start of every turn (in `runAgentLoop` in `subAgentTools.ts`)
- 7 new tests in `tests/phaseN16.test.js`

### Note on architecture
`interrupt_sub_agent` works as a pre-turn injection queue. True mid-turn interruption (while `await fetch()` is in flight) requires concurrent execution, which is not supported by the current single-threaded tool-call model. The queue approach provides full value when the agent is between turns, and is a clean foundation for future streaming-based concurrency.

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
