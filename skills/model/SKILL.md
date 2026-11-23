---
name: model
description: Use before delegating to a subagent (Agent tool) or writing a Workflow script, to pick haiku, sonnet or opus for each task, and when a gated model such as Fable seems needed or a pickwise hook denied a Fable call. Also for changing pickwise model settings.
---

# pickwise: pick the subagent model

Main chat chooses the model for every subagent. The cheapest model that does the task well wins.

## Choose

| Model | Use for |
|---|---|
| `haiku` | search, locate code, list files, read and summarize, 1-2 file mechanical edits, web fetch |
| `sonnet` | implement from a clear plan, write tests, code review, audits, most multi-file work |
| `opus` | architecture, hard debugging, security review, writing plans, tasks where sonnet already failed |

- Set `model` on every Agent call and on every `agent()` in a Workflow script. Never leave it to inherit the main chat model.
- A few tool calls of work: do it yourself, do not spawn a subagent.
- The pickwise session context shows the routing actually in force (the user can change it, see Settings).

## Gated models (default: `fable`)

Never use a gated model without the user's OK. Only when the task truly needs it:

1. Before the call, ask with AskUserQuestion. Say in one or two sentences why opus is not enough. Options, exactly:
   - `Use Opus instead (Recommended)`
   - `Use Fable` (the gated model's name)
   - `Cancel`
2. Act in the same turn:
   - `Use Fable`: make that one call with `model: fable`.
   - `Use Opus instead`: make the same call (same prompt, same subagent type) with `model: opus` and carry on.
   - `Cancel`: stop that task.

The pickwise hook enforces this. A gated call is denied unless the user picked `Use <Model>` in the last 10 minutes. Each approval allows one call. If a call is denied, ask as above. Do not retry blindly.

## Settings

Optional file `~/.claude/pickwise/config.json`. Missing keys keep their defaults:

```json
{
  "model": {
    "enabled": true,
    "gatedModels": ["fable"],
    "fallbackModel": "opus",
    "approvalMinutes": 10,
    "routing": { "haiku": "...", "sonnet": "...", "opus": "..." }
  }
}
```

The changes take effect in the next session. The session context is built at start.
