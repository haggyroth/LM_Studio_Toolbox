# Sub-Agent System — Guide & Troubleshooting

The sub-agent system lets the main model delegate tasks to a secondary language model running at any OpenAI-compatible endpoint — including models on a remote machine accessed via LM Studio's **LM Link** feature.

---

## How It Works

When `consult_secondary_agent` is called:

1. **Pre-flight check** — the toolbox pings `{endpoint}/models` with a 4-second timeout. If the endpoint is unreachable, the error is returned immediately (no wasted turns).
2. **System prompt** is built from:
   - `SUB_AGENT_INSTRUCTIONS.md` in the workspace (if present)
   - `toolbox_info.md` project history (if present)
   - The role persona (from `subAgentProfiles` config)
   - The list of allowed tools (auto-inferred from role — see below)
3. **Turn loop** runs up to 8 turns (configurable via `subAgentTimeLimit`). On each turn the sub-agent either calls a tool (handled locally by the plugin) or produces final output.
4. **Result** is returned to the main model and also persisted to `~/.lm-studio-toolbox/last_sub_agent_result.json`. Call `get_sub_agent_result` to re-read it without starting a new session.

---

## Role → Tool Access

File-writing roles have filesystem access enabled **automatically** — you don't need to pass `allow_tools: true`:

| Role | Filesystem | Web | Code |
|------|:---:|:---:|:---:|
| `coder` | ✅ | — | ✅ |
| `reviewer` | ✅ | — | — |
| `researcher` | — | ✅ | — |
| `debugger` | ✅ | — | ✅ |
| `tester` | ✅ | — | ✅ |
| `documenter` | ✅ | — | — |
| `planner` | ✅ | — | — |
| `data_analyst` | ✅ | — | ✅ |
| `general` | ✅ | — | — |

These are still gated by the **user's config flags** (`subAgentAllowFileSystem`, `subAgentAllowWeb`, `subAgentAllowCode`). If a flag is off, that tool category is unavailable regardless of role.

---

## LM Link — Remote Models

LM Link lets you expose a remote LM Studio instance over the network. A common setup:

- **voyager** (MacBook) — runs the LM Studio Toolbox plugin and hosts the main model
- **enterprise-e** (gaming PC) — hosts the larger secondary model via LM Studio
- LM Studio on voyager connects to enterprise-e via LM Link, making the remote model appear as a local endpoint

### How Tool Execution Works with LM Link

**Tool calls always execute on the machine running the plugin (voyager).** The remote model (enterprise-e) outputs JSON like `{"tool":"save_file","args":{...}}`; voyager's plugin intercepts it, runs the tool locally, and sends the result back to the remote model. The remote model never directly touches voyager's file system — it only receives text outputs.

This means:
- `save_file` writes to voyager's disk ✅
- `read_file` reads from voyager's disk ✅
- The remote model does **not** need any special file system permissions ✅

### LM Link Reliability Considerations

| Issue | Cause | Fix |
|-------|-------|-----|
| Sub-agent returns empty output | Remote model doesn't support JSON tool-call format | Use a stronger model; enable `enableSubAgentDebugLogging` to see raw responses |
| Slow turns / timeout | Network latency to remote host multiplied by 8 turns | Increase `subAgentTimeLimit`; reduce `loopLimit` for simple tasks |
| ECONNREFUSED error | LM Link not running or wrong endpoint configured | Verify LM Link is active on enterprise-e; check `secondaryAgentEndpoint` in plugin settings |
| Model uses wrong tool format | Smaller models hallucinate tool-call syntax | Increase model size; tune `subAgentProfiles` system prompt for the model's native format |
| Files not produced | `subAgentAllowFileSystem` is off | Enable it in plugin settings |

### Recommended Remote Config

```json
// ~/.lm-studio-toolbox/mcp-config.json  (for MCP mode)
// or plugin settings for LM Studio plugin mode

{
  "secondaryAgentEndpoint": "http://enterprise-e.local:1234/v1",
  "secondaryModelId": "your-model-id",
  "subAgentAllowFileSystem": true,
  "subAgentAllowWeb": false,
  "subAgentTimeLimit": 300
}
```

### Detecting Tool-Call Capability

Enable `enableSubAgentDebugLogging` in the plugin settings. This prints each raw response from the secondary model to LM Studio's plugin console. If you see the model outputting prose instead of JSON like `{"tool":"save_file",...}`, the model doesn't reliably support the expected JSON tool-call format.

**Models known to work well as sub-agents:**
- Qwen2.5-Coder (any size ≥ 7B)
- Llama 3.1 / 3.3 70B+
- Mistral-Nemo, Mistral-Small
- DeepSeek-Coder-V2

**Models that may struggle:**
- Models < 7B parameters
- Base models (not instruction-tuned)
- Models without code/tool-use training

---

## Common Problems

### "Sub-agent appears to be thinking but produces no files"

1. Check `subAgentAllowFileSystem` is enabled in plugin settings
2. Enable `enableSubAgentDebugLogging` and check the raw responses
3. The model may be outputting code in prose instead of calling `save_file`
4. Enable `subAgentAutoSave` — this auto-extracts code blocks and saves them even without explicit tool calls

### "Main model keeps calling sub-agent repeatedly"

The sub-agent tool is **synchronous** — it runs, returns, and is done. If the main model calls it again:
- The first result was unclear (no `[GENERATED_FILES]` marker, empty response)
- The main model didn't understand it should stop

Fix: call `get_sub_agent_result` instead of `consult_secondary_agent` to re-read without re-running.

### "Sub-agent defaults to coder role for everything"

The main model infers role from the task description. To fix:
- Explicitly pass `agent_role` in every `consult_secondary_agent` call
- Add a system prompt note in your startup.md explaining which role to use for which task

### "TASK_FAILED in response"

The sub-agent explicitly could not complete the task. The error is now returned directly to the main model with a clear message. Retry with a more detailed `context`, a stronger model, or split the task into smaller sub-tasks.

### "Sub-agent works locally but fails via LM Link"

1. Verify network connectivity: `curl http://enterprise-e.local:1234/v1/models`
2. Check the model is loaded on enterprise-e (not just LM Studio running — the model must be actively loaded)
3. Remote models may have lower context limits — reduce the task scope
4. Increase `subAgentTimeLimit` to account for network latency on each turn

---

## Debugging Checklist

- [ ] `enableSubAgentDebugLogging: true` — see raw model responses
- [ ] `subAgentAllowFileSystem: true` — required for any file-writing role
- [ ] Model is loaded at the configured endpoint (check `/v1/models`)
- [ ] `secondaryModelId` matches the model ID shown in LM Studio
- [ ] `subAgentTimeLimit` is high enough (default: 600s)
- [ ] If using LM Link: network path to remote host is open
