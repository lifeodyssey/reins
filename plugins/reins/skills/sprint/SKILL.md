---
name: sprint
description: "Run a multi-agent sprint. Use when the user wants to plan, execute, review, and test a set of GitHub issues as a coordinated sprint."
version: 0.1.0
---

# Reins Sprint

Launch the Reins orchestrator to run a multi-agent sprint.

## When to use
- User says "start a sprint", "plan issues", "run /reins"
- User wants to orchestrate multiple agents on a set of tasks

## Steps

1. **Launch the server:**

```bash
lsof -ti :7860 | xargs kill 2>/dev/null || true
REINS_PROJECT_ROOT="$PWD" bun run "$CLAUDE_PLUGIN_ROOT/src/server.ts" &
sleep 1 && open http://localhost:7860
```

2. **Tell the user:**

The Reins orchestrator is running at http://localhost:7860.

Describe what you want to build — the Orchestrator will plan, execute, review, and test it.

Type `/reins-stop` to shut it down.
