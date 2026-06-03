# Sub-Agent Delegation Guide

You have access to `consult_secondary_agent` — a tool that delegates a task to a second language model running at a separate endpoint. Use it when a task is well-defined enough to hand off entirely and large enough to justify the overhead of a separate session.

---

## Choosing a Role

Pass `agent_role` to match the work. File-writing roles have filesystem access automatically — you do **not** need `allow_tools: true` for them.

| Role | Use for | Gets filesystem? |
|------|---------|:---:|
| `coder` | Write, edit, or refactor code | ✅ |
| `reviewer` | Find bugs, security issues, and logic errors | ✅ |
| `tester` | Write tests and run the test suite | ✅ |
| `debugger` | Diagnose failing tests or runtime errors | ✅ |
| `documenter` | Write or update docs, READMEs, changelogs | ✅ |
| `planner` | Break a complex task into an ordered plan (no code) | ✅ |
| `data_analyst` | Query databases and transform structured data | ✅ |
| `researcher` | Gather and summarise information from the web | web only |
| `general` | Anything that doesn't fit the above | ✅ |

---

## Minimal Usage

```json
{"tool": "consult_secondary_agent", "args": {"task": "Write a function that parses ISO dates.", "agent_role": "coder"}}
```

For research tasks (needs web):
```json
{"tool": "consult_secondary_agent", "args": {"task": "Summarise the latest React 19 release notes.", "agent_role": "researcher", "allow_tools": true}}
```

---

## Providing Context

Always pass `context` when the task depends on information the sub-agent cannot read itself:

```json
{
  "tool": "consult_secondary_agent",
  "args": {
    "task": "Add input validation to the register endpoint.",
    "agent_role": "coder",
    "context": "The project uses Express 4 + Zod. The register route is in src/routes/auth.ts line 42."
  }
}
```

Avoid passing large file dumps in `context` — the sub-agent can `read_file` itself.

---

## Trusting the Output

The sub-agent saves files directly to disk. When the result contains `[GENERATED_FILES]`, those files **already exist** — do not recreate them.

```
[GENERATED_FILES]: /workspace/src/auth.ts, /workspace/src/auth.test.ts
```

If `showFullCodeOutput` is off (default), code blocks are hidden to save context:
```
[System: Code Block Hidden for Brevity. The code has been handled/saved by the sub-agent. Do NOT request it again. Proceed.]
```
This is a **success signal**. Accept it and move on.

---

## Re-Reading Results

If you need to inspect the sub-agent's last output without running a new session:

```json
{"tool": "get_sub_agent_result", "args": {}}
```

This retrieves the persisted result from the previous run instantly.

---

## Understanding Status Fields

Every result includes a `status` field:

| Status | Meaning | What to do |
|--------|---------|------------|
| `completed` | Task finished normally | Trust the output |
| `failed` | Sub-agent output `TASK_FAILED` | Retry with more context or split the task |
| `stalled` | 3+ turns with no tool calls or completion | Split the task into smaller steps |
| `timeout` | Wall-clock deadline exceeded | Increase `subAgentTimeLimit` or narrow the task |
| `cancelled` | Cancelled via `interrupt_sub_agent` | Re-invoke if needed |

---

## Role Chaining

Run multiple roles in sequence — each receives the previous role's output:

```json
{
  "tool": "consult_secondary_agent",
  "args": {
    "task": "Implement the auth module",
    "agent_role": "coder",
    "chain": ["tester", "reviewer"]
  }
}
```

`coder` writes the code → `tester` writes and runs tests → `reviewer` audits the result.

---

## Mid-Run Steering

If the sub-agent starts going in the wrong direction, queue a correction for the next turn:

```json
{"tool": "interrupt_sub_agent", "args": {"message": "Stop working on auth — focus on the database layer instead."}}
```

To cancel the run entirely: `{"cancel": true}`.

---

## When NOT to Delegate

- **Quick reads or lookups** — use `read_file`, `search_directory`, or `find_symbol` directly.
- **Simple one-tool tasks** — a single `web_search` or `git_status` doesn't warrant a sub-agent.
- **Tasks requiring your direct context** — the sub-agent starts a fresh session and cannot see the current conversation.
- **Already done** — if `[GENERATED_FILES]` appeared, the files exist. Don't re-delegate the same task.

---

## Verification Checklist

After the sub-agent returns:
1. Check `status` — `completed` means success; anything else has guidance in the table above.
2. If `[GENERATED_FILES]` is present, trust it — don't `read_file` every output file unless you specifically need to show content to the user.
3. If the result is unclear, call `get_sub_agent_result` instead of re-invoking `consult_secondary_agent`.
