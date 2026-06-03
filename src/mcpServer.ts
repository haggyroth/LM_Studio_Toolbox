/**
 * LM Studio Toolbox — MCP Server entry point (Phase M.5)
 *
 * Exposes the toolbox's tool surface via the Model Context Protocol stdio
 * transport so non-LM-Studio clients (Claude Desktop, Cursor, VS Code
 * Copilot Chat, Continue.dev, …) can use the same tools.
 *
 * Usage:
 *   node dist/mcpServer.js
 *
 * Config:  ~/.lm-studio-toolbox/mcp-config.json
 * Example: see mcp-config.example.json in the project root.
 *
 * Tools that require a live LM Studio instance (consult_secondary_agent,
 * rag_local_files with embedding, browser tools) are excluded automatically.
 * They return a clear "requires LM Studio" message if somehow invoked.
 */

// @modelcontextprotocol/sdk has "type": "module" but ships a full CJS dist.
// Our project is CommonJS.  We resolve the CJS files relative to node_modules
// using __dirname from the compiled output (dist/mcpServer.js → project root →
// node_modules).  The exports map is bypassed entirely — we load the .js files
// directly.  All instances are typed `any`.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
import { resolve as resolvePath } from "path";
// __dirname in the compiled output is dist/; go up one level to project root
const _mcpSdkCjs             = resolvePath(__dirname, "..", "node_modules", "@modelcontextprotocol", "sdk", "dist", "cjs");
const { McpServer }            = require(`${_mcpSdkCjs}/server/mcp`)   as any;
const { StdioServerTransport } = require(`${_mcpSdkCjs}/server/stdio`) as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parseProtectedPaths, type ToolCtxLike } from "./tools/helpers";
import { createFileTools } from "./tools/fileTools";
import { createWebTools } from "./tools/webTools";
import { createGitTools } from "./tools/gitTools";
import { createGithubTools } from "./tools/githubTools";
import { createMiscTools } from "./tools/miscTools";
import { createCodeTools } from "./tools/codeTools";
import { createMemoryTools } from "./tools/memoryTools";
import type { PluginState } from "./stateManager";

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_DIR  = join(homedir(), ".lm-studio-toolbox");
const CONFIG_PATH = join(CONFIG_DIR, "mcp-config.json");

interface McpConfig {
  /** Workspace root directory (default: process.cwd()) */
  cwd?: string;
  /** Newline- or comma-separated absolute paths that are always off-limits */
  protectedPaths?: string;
  // ── Permission flags (all default to false for safety) ────────────────────
  allowGit?: boolean;
  allowGitHubTools?: boolean;
  allowDb?: boolean;
  allowJavascript?: boolean;
  allowPython?: boolean;
  allowShell?: boolean;
  allowTerminal?: boolean;
  allowNotify?: boolean;
  enableMemory?: boolean;
  enableWikipedia?: boolean;
  /** Comma-separated tool names to exclude (same as the disabledTools plugin config) */
  disabledTools?: string;
}

const DEFAULT_CONFIG: McpConfig = {
  allowGit: true,
  allowGitHubTools: false,
  allowDb: false,
  allowJavascript: false,
  allowPython: false,
  allowShell: false,
  allowTerminal: false,
  allowNotify: false,
  enableMemory: false,
  enableWikipedia: true,
};

function loadConfig(): McpConfig {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
  } catch {
    // No config yet — write the example and use defaults
    if (!existsSync(CONFIG_PATH)) {
      try {
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
        process.stderr.write(`[mcp] Created default config at ${CONFIG_PATH}\n`);
      } catch { /* ignore write errors */ }
    }
    return DEFAULT_CONFIG;
  }
}

// ── Minimal PluginState stub ──────────────────────────────────────────────────

function makeFullState(cwd: string): PluginState {
  return {
    currentWorkingDirectory: cwd,
    messageCount: 0,
    dontAskToCompress: false,
    subAgentDocsInjected: false,
    uiLanguageOverride: "auto",
  };
}

// ── Server bootstrap ──────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  const cwd = config.cwd ?? process.cwd();

  // Build a minimal ToolContext — client and embeddings are unavailable in MCP mode.
  // Tools that need them (sub-agent, local RAG, browser) are excluded below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx: any = {
    cwd,
    browserSession: null,
    fullState: makeFullState(cwd),
    client: null,                          // no LM Studio client
    pluginConfig: { get: () => null },     // no plugin settings panel
    allowJavascript:    config.allowJavascript    ?? false,
    allowPython:        config.allowPython        ?? false,
    allowTerminal:      config.allowTerminal      ?? false,
    allowShell:         config.allowShell         ?? false,
    allowBrowserControl: false,            // browser needs Puppeteer + session mgmt
    enableMemory:       config.enableMemory       ?? false,
    enableWikipedia:    config.enableWikipedia    ?? true,
    enableLocalRag:     false,             // needs LM Studio embedding model
    enableSecondary:    false,             // needs LM Studio endpoint
    allowGit:           config.allowGit           ?? true,
    allowDb:            config.allowDb            ?? false,
    allowNotify:        config.allowNotify        ?? false,
    allowGitHubTools:   config.allowGitHubTools   ?? false,
    embeddingModelName: "",
    protectedPaths: parseProtectedPaths(config.protectedPaths ?? ""),
  };

  // Assemble tools — excludes sub-agent and browser (need LM Studio)
  const allTools = [
    ...createFileTools(ctx),
    ...createWebTools(ctx),
    ...createGitTools(ctx),
    ...createGithubTools(ctx),
    ...createMiscTools(ctx),
    ...createCodeTools(ctx),
    ...createMemoryTools(ctx),
  ];

  // Apply disabledTools filter (same logic as toolsProvider.ts)
  const disabledSet = new Set(
    (config.disabledTools ?? "").split(",").map(s => s.trim()).filter(Boolean)
  );
  const tools = disabledSet.size > 0
    ? allTools.filter(t => !disabledSet.has(t.name))
    : allTools;

  // ── MCP tool-call context ──────────────────────────────────────────────────
  // Status messages go to stderr (not stdout, which is the MCP transport).
  const mcpToolCtx: ToolCtxLike = {
    status: (text: string) => process.stderr.write(`[status] ${text}\n`),
    warn:   (text: string) => process.stderr.write(`[warn]   ${text}\n`),
  };

  // ── Register with McpServer ────────────────────────────────────────────────
  const server = new McpServer({
    name:    "lm-studio-toolbox",
    version: "2.0.0",
  });

  for (const t of tools) {
    // lmstudio/sdk stores the full ZodObject under `parametersSchema`.
    // McpServer.tool() expects a ZodRawShape (the `.shape` property).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shape = (t as any).parametersSchema?.shape ?? {};
    server.tool(t.name, t.description, shape, async (args: Record<string, unknown>) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (t as any).implementation(args, mcpToolCtx);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          }],
          isError: true,
        };
      }
    });
  }

  // ── Connect transport ──────────────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[lm-studio-toolbox MCP] Server started.\n` +
    `  CWD:          ${cwd}\n` +
    `  Tools:        ${tools.length} registered\n` +
    `  Config:       ${CONFIG_PATH}\n` +
    `  Git:          ${ctx.allowGit ? "enabled" : "disabled"}\n` +
    `  Code exec:    ${(ctx.allowPython || ctx.allowJavascript || ctx.allowShell) ? "enabled" : "disabled"}\n` +
    `  Wikipedia:    ${ctx.enableWikipedia ? "enabled" : "disabled"}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`[lm-studio-toolbox MCP] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
