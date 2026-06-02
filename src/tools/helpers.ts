import { join, sep } from "path";
import { resolve, relative, isAbsolute } from "path";
import type { LMStudioClient } from "@lmstudio/sdk";
import { findLMStudioHome } from "../findLMStudioHome";

// ─── Path Safety ─────────────────────────────────────────────────────────────

/**
 * Resolve and validate a path is inside the workspace.
 * Optionally checks against a list of protected absolute paths that are
 * always off-limits regardless of CWD (from the protectedPaths config).
 */
export function validatePath(
  baseDir: string,
  requestedPath: string,
  protectedPaths: string[] = [],
): string {
  const resolved = resolve(baseDir, requestedPath);
  const rel = relative(baseDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Access Denied: Path '${requestedPath}' is outside the workspace.`);
  }
  for (const blocked of protectedPaths) {
    if (resolved === blocked || resolved.startsWith(blocked + sep)) {
      throw new Error(`Access Denied: '${resolved}' is within a protected path ('${blocked}').`);
    }
  }
  return resolved;
}

/**
 * Parse the raw protectedPaths config string (newline- or comma-separated
 * paths) into a list of resolved absolute path strings.
 */
export function parseProtectedPaths(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => resolve(p));     // expand ~ would require os.homedir(); resolve handles absolute paths
}

// ─── SSRF-safe fetch ─────────────────────────────────────────────────────────

/**
 * A drop-in replacement for `fetch()` that:
 *  - Enforces http/https scheme only
 *  - Blocks requests to loopback, private RFC-1918, link-local (cloud
 *    metadata), and other special-purpose address ranges (SSRF protection)
 *  - Applies a configurable timeout via AbortSignal (default 30 s)
 *
 * Throws on SSRF violations so callers can return a clean { error } message.
 */
export async function safeFetch(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  // 1. Scheme must be http or https
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error(`SSRF protection: only http:// and https:// URLs are allowed (got: ${url.slice(0, 80)}).`);
  }

  // 2. Parse and extract hostname
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url.slice(0, 80)}`);
  }

  // Strip surrounding brackets from IPv6 (e.g. [::1] → ::1)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  // 3. Block localhost/loopback names
  if (hostname === "localhost" || hostname === "0.0.0.0") {
    throw new Error(`SSRF protection: access to '${hostname}' is not allowed.`);
  }

  // 4. Block IPv4 private / loopback / link-local / special ranges
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (
      a === 0 ||                               // 0.x.x.x — "this" network
      a === 10 ||                              // 10.x.x.x — RFC-1918
      a === 127 ||                             // 127.x.x.x — loopback
      (a === 100 && b >= 64 && b <= 127) ||   // 100.64.x.x–100.127.x.x — CGNAT RFC-6598
      (a === 169 && b === 254) ||              // 169.254.x.x — link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||    // 172.16–31.x.x — RFC-1918
      (a === 192 && b === 168) ||             // 192.168.x.x — RFC-1918
      a === 198 ||                             // 198.18.x.x, 198.51.100.x (TEST-NET)
      a >= 224                                 // 224+ — multicast / reserved
    ) {
      throw new Error(`SSRF protection: access to private/reserved IP '${hostname}' is not allowed.`);
    }
  }

  // 5. Block IPv6 loopback and link-local
  if (
    hostname === "::1" ||
    hostname.startsWith("fe80") ||   // link-local
    hostname.startsWith("fc00") ||   // unique local (ULA)
    hostname.startsWith("fd")        // ULA (fd00::/8)
  ) {
    throw new Error(`SSRF protection: access to IPv6 special-purpose address '${hostname}' is not allowed.`);
  }

  // 6. Build signal: prefer caller's signal if provided, otherwise use timeout
  const { timeoutMs = 30_000, signal: callerSignal, ...fetchOptions } = options;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  // Combine caller signal + timeout signal if both present
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;

  return fetch(url, { ...fetchOptions, signal });
}

// ─── Path Heuristics ──────────────────────────────────────────────────────────

export function extractLikelyFilePath(text: string): string | null {
  const isPlausiblePath = (value: string): boolean => {
    const candidate = value.trim();
    if (!candidate) return false;
    if (/[,\r\n]/.test(candidate)) return false;
    if (candidate.includes("=") && !candidate.includes("\\") && !candidate.includes("/")) return false;
    if (/[<>|*?]/.test(candidate)) return false;
    const extensionMatch = candidate.match(/\.([A-Za-z0-9_-]{1,15})$/);
    if (!extensionMatch) return false;
    const extension = extensionMatch[1];
    if (!/[A-Za-z]/.test(extension)) return false;
    return true;
  };

  const patterns = [
    /['"]([A-Za-z]:\\[^'"\r\n]+)['"]/,
    /\b([A-Za-z]:\\[^\s'"]+(?:\.[A-Za-z0-9_-]+)?)\b/,
    /['"]((?:\.{0,2}[\\/])?[^'"\r\n]+\.[A-Za-z0-9_-]+)['"]/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const candidate = match[1].replace(/[),.;]+$/, "").trim();
    if (!isPlausiblePath(candidate)) continue;
    return candidate;
  }
  return null;
}

// ─── Permission Guard ─────────────────────────────────────────────────────────

export const createSafeToolImplementation = <TParameters, TReturn>(
  originalImplementation: (params: TParameters) => Promise<TReturn>,
  isEnabled: boolean,
  toolName: string,
) => async (params: TParameters): Promise<TReturn> => {
  if (!isEnabled) {
    throw new Error(
      `Tool '${toolName}' is disabled in the plugin settings. Please ask the user to enable 'Allow ${toolName.replace(/_/g, " ")}' (or similar) in the settings.`
    );
  }
  return originalImplementation(params);
};

// ─── RAG / Embeddings ─────────────────────────────────────────────────────────

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  const dotProduct = vecA.reduce((acc, val, i) => acc + val * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((acc, val) => acc + val * val, 0));
  const magB = Math.sqrt(vecB.reduce((acc, val) => acc + val * val, 0));
  if (magA === 0 || magB === 0) return 0;
  return dotProduct / (magA * magB);
}

export async function performRagOnText(
  text: string,
  query: string,
  client: LMStudioClient,
  embeddingModelName: string
) {
  const embeddingModel = await client.embedding.model(embeddingModelName);
  const chunks = text.split(/\n\s*\n/).filter(chunk => chunk.trim().length > 20);
  if (chunks.length === 0) {
    return [{ chunk: text.substring(0, 4000), score: 1 }];
  }

  const [queryEmbedding] = await embeddingModel.embed([query]);
  const chunkEmbeddings = await embeddingModel.embed(chunks);

  const similarities = chunkEmbeddings.map((chunkEmb, i) => ({
    chunk: chunks[i],
    score: cosineSimilarity(queryEmbedding.embedding, chunkEmb.embedding),
  }));

  similarities.sort((a, b) => b.score - a.score);
  return similarities.slice(0, 5);
}

// ─── Deno Runtime ─────────────────────────────────────────────────────────────

export function getDenoPath(): string {
  const lmstudioHome = findLMStudioHome();
  const utilPath = join(lmstudioHome, ".internal", "utils");
  return join(utilPath, process.platform === "win32" ? "deno.exe" : "deno");
}

// ─── Python Runtime ───────────────────────────────────────────────────────────

let _cachedPythonPath: string | null = null;

/**
 * Resolve the Python 3 binary on the current platform, caching the result.
 * Tries `python3` first (macOS/Linux), then `python` (Windows / some distros).
 * Throws if no Python 3 interpreter is found.
 */
export async function getPythonPath(): Promise<string> {
  if (_cachedPythonPath) return _cachedPythonPath;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFile } = require("child_process") as typeof import("child_process");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { promisify } = require("util") as typeof import("util");
  const execFileAsync = promisify(execFile);

  const candidates = process.platform === "win32"
    ? ["python", "python3"]   // Windows usually has "python" from Store / pyenv
    : ["python3", "python"];  // Unix: prefer explicit python3

  for (const candidate of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(candidate, ["--version"]);
      // Python 2 prints to stderr; Python 3 prints to stdout.
      const version = (stdout + stderr).trim();
      if (version.startsWith("Python 3")) {
        _cachedPythonPath = candidate;
        return candidate;
      }
    } catch {
      // Not found or not executable — try next candidate.
    }
  }

  throw new Error(
    "Python 3 interpreter not found. " +
    "Install Python 3 and ensure 'python3' or 'python' is on your PATH."
  );
}
