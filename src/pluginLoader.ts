/**
 * N.12: Custom tool plugin loader.
 *
 * At startup, scans a directory for .js/.cjs files and registers any exported
 * tool definitions alongside the built-in tools. Plugins may export:
 *
 *   - A single definition object: { name, description, parameters, implementation }
 *   - An array of definition objects
 *   - A factory function called with { z } that returns either of the above
 *
 * Parameters must be a Zod schema (plugins can require("zod") from shared
 * node_modules).  If omitted, an empty z.object({}) is used.
 *
 * Errors in individual plugin files are logged and skipped — a bad plugin
 * never prevents the rest of the toolbox from loading.
 */

import { tool, type Tool } from "@lmstudio/sdk";
import { z } from "zod";
import { readdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export const DEFAULT_PLUGIN_DIR = join(homedir(), ".lm-studio-toolbox", "plugins");

interface PluginDefinition {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  implementation?: unknown;
}

/**
 * Load all valid plugin tools from `pluginDir`.
 * Returns an empty array if the directory does not exist or is empty.
 */
export async function loadPlugins(pluginDir: string = DEFAULT_PLUGIN_DIR): Promise<Tool[]> {
  let files: string[];
  try {
    files = await readdir(pluginDir);
  } catch {
    return []; // directory absent — normal on a fresh install
  }

  const pluginFiles = files.filter(f => f.endsWith(".js") || f.endsWith(".cjs"));
  const loaded: Tool[] = [];

  for (const file of pluginFiles) {
    const fullPath = join(pluginDir, file);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      let exported = require(fullPath);

      // Factory pattern: call with { z } so the plugin doesn't need to require zod
      if (typeof exported === "function") {
        exported = exported({ z });
      }

      // Normalise to array of definitions
      const definitions: PluginDefinition[] = Array.isArray(exported) ? exported : [exported];

      for (const def of definitions) {
        if (!def || typeof def !== "object") {
          console.warn(`[plugins] Skipping entry in ${file}: not an object`);
          continue;
        }

        const { name, description, parameters, implementation } = def;

        if (typeof name !== "string" || !name.trim()) {
          console.warn(`[plugins] Skipping entry in ${file}: 'name' must be a non-empty string`);
          continue;
        }
        if (typeof implementation !== "function") {
          console.warn(`[plugins] Skipping '${name}' in ${file}: 'implementation' must be a function`);
          continue;
        }

        // Accept either a raw Zod shape { key: z.string() } or a z.object({...}).
        // The SDK's tool() expects a raw shape; unwrap ZodObject if needed.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let params: any = (parameters && typeof parameters === "object") ? parameters : {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((params as any)?._def?.typeName === "ZodObject") params = (params as any).shape;

        loaded.push(tool({
          name: name.trim(),
          description: typeof description === "string" && description ? description : `Custom plugin: ${name}`,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parameters: params as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          implementation: implementation as (...args: any[]) => Promise<unknown>,
        }));

        console.log(`[plugins] Loaded: '${name}' (${file})`);
      }
    } catch (e) {
      console.warn(`[plugins] Failed to load ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return loaded;
}
