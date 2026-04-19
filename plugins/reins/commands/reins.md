---
name: reins
description: "Launch the Reins sprint orchestrator. Opens a Gradio UI for multi-agent sprint management with live streaming, interrupt, and direct agent chat."
---

Launch the Reins orchestrator UI. This starts a Gradio web server and opens
the browser. The UI lets you:

- Talk to the Orchestrator (default) to run sprint flows
- Switch to direct chat with any agent (Executor, Reviewer, Tester, Planner)
- Watch real-time tool call streaming from each agent
- Interrupt agents mid-execution
- View sprint board, event timeline, and agent status

## Steps

1. Start the Gradio server:

```bash
cd "$CLAUDE_PLUGIN_ROOT"
uv run --with gradio --with claude-agent-sdk python scripts/gradio-ui.py &
UI_PID=$!
echo "Reins UI started (PID: $UI_PID) on http://localhost:7860"
```

2. Open the browser:

```bash
sleep 3
open http://localhost:7860
```

3. Tell the user:

"Reins orchestrator running at http://localhost:7860. Use the chat to run sprints, talk to agents, and manage your development workflow. Type `/reins stop` to shut it down."
