# LM Studio Toolbox — Custom Plugin Guide

The toolbox supports user-defined tool plugins. Drop a `.js` file into the plugin directory and it is registered alongside every built-in tool the next time the plugin starts.

**Plugin directory:** `~/.lm-studio-toolbox/plugins/`

---

## Quick Start

Create the plugin directory if it doesn't exist, then drop a `.js` file in:

```bash
mkdir -p ~/.lm-studio-toolbox/plugins
```

Restart the LM Studio Toolbox plugin (or reload the plugin in LM Studio's plugin manager) for new files to take effect.

---

## Plugin Format

A plugin file may export one of three shapes:

### 1 — Plain object (single tool, no Zod dependency)

```js
// ~/.lm-studio-toolbox/plugins/greet.js
module.exports = {
  name: "greet_user",
  description: "Say hello to the user by name.",
  implementation: async ({ name }) => {
    return { message: `Hello, ${name}!` };
  },
};
```

Parameters default to an empty schema when omitted — the model can still call the tool; it just receives no typed arguments.

### 2 — Factory function (receives `{ z }` — recommended)

The loader passes Zod's `z` object to any exported function. Use this to define typed parameters without a separate `require("zod")` call:

```js
// ~/.lm-studio-toolbox/plugins/call_api.js
module.exports = function ({ z }) {
  return {
    name: "call_internal_api",
    description: "POST to an internal REST API endpoint.",
    parameters: {
      endpoint: z.string().describe("Relative path, e.g. /users/123"),
      payload:  z.string().optional().describe("JSON body string"),
    },
    implementation: async ({ endpoint, payload }) => {
      const res = await fetch(`https://api.internal${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      return { status: res.status, body: await res.text() };
    },
  };
};
```

### 3 — Array (multiple tools from one file)

```js
// ~/.lm-studio-toolbox/plugins/deploy.js
module.exports = function ({ z }) {
  const envSchema = { env: z.enum(["staging", "production"]) };

  return [
    {
      name: "deploy_app",
      description: "Deploy the app to an environment.",
      parameters: envSchema,
      implementation: async ({ env }) => {
        // ... your deploy logic
        return { deployed: true, env };
      },
    },
    {
      name: "rollback_deploy",
      description: "Roll back the last deployment.",
      parameters: envSchema,
      implementation: async ({ env }) => {
        // ... rollback logic
        return { rolled_back: true, env };
      },
    },
  ];
};
```

---

## Parameter Schemas

Both Zod raw shapes and wrapped `z.object({})` are accepted:

```js
// Raw shape (preferred — matches built-in tool convention)
parameters: { name: z.string(), age: z.number().int() }

// Wrapped z.object() — also works; unwrapped automatically
parameters: z.object({ name: z.string(), age: z.number().int() })
```

---

## Error Handling

- Files with **syntax errors** are skipped with a `console.warn` — other plugins and all built-in tools continue loading normally.
- Entries missing a `name` or `implementation` are skipped individually.
- Runtime errors inside `implementation` are caught by the toolbox and returned to the model as `{ error: "..." }`.

---

## Examples

| Use case | Pattern |
|----------|---------|
| Call a company API | Factory with `z.string()` params and `fetch()` |
| Run a custom deploy script | Object export, `child_process.execFile()` |
| Read a proprietary file format | Object export, return parsed data as JSON |
| Chain two operations | Array export |

---

## Notes

- Plugins run with **full Node.js privileges** — no sandbox. Only install plugins you trust.
- If a plugin name collides with a built-in tool, the **built-in wins** (plugins are appended after all built-ins are registered).
- The `disabledTools` config field applies to plugin tools the same way it does to built-ins.
- Plugins are loaded at **startup only** — changes require a plugin restart.
