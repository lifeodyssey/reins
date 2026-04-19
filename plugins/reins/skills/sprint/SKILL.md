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
cd "$CLAUDE_PLUGIN_ROOT"
lsof -ti :7860 | xargs kill 2>/dev/null || true
bun run src/server.ts &
sleep 1
open http://localhost:7860
```

2. **Tell the user:**

The Reins orchestrator is running at http://localhost:7860.

In the UI you can:
- **Talk to the Orchestrator** (default) — run `/plan --issues 71,72,73` to start a sprint
- **Switch to any agent** — use the Mode dropdown to talk directly to Executor, Reviewer, Tester, or Planner
- **Watch tool calls stream** in real-time as agents work
- **Interrupt** any agent mid-execution
- **View the Sprint Board** tab for card status
- **View the Timeline** for event history

The sprint flow is: Plan → Approve → Execute → Verify → Route → Review → Test → Merge.

Each card runs in its own git worktree. Parallel cards within a wave. Router and Verifier make agentic decisions at each step.

Type `/reins-stop` to shut it down.
