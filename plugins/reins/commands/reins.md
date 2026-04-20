---
name: reins
description: "Launch the Reins sprint orchestrator. Opens a mission-control UI for multi-agent sprint management with live streaming, interrupt, and direct agent chat."
---

Launch the Reins orchestrator UI. This starts a Bun HTTP + WebSocket server
and opens the browser. The UI lets you:

- Talk to the Orchestrator (default) to run sprint flows
- Switch to direct chat with any agent (Executor, Reviewer, Tester, Planner)
- Watch real-time tool call streaming from each agent
- Interrupt agents mid-execution
- View sprint board, event timeline, and agent status

## Steps

1. Start the server and open browser:

```bash
lsof -ti :7860 | xargs kill 2>/dev/null || true
REINS_PROJECT_ROOT="$PWD" bun run "$CLAUDE_PLUGIN_ROOT/src/server.ts" &
UI_PID=$!
sleep 1 && open http://localhost:7860
echo "Reins UI started (PID: $UI_PID) on http://localhost:7860"
```

3. Tell the user:

"Reins orchestrator running at http://localhost:7860. Use the chat to run sprints, talk to agents, and manage your development workflow. Type `/reins-stop` to shut it down."
