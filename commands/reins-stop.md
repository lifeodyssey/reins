---
name: reins-stop
description: "Stop the Reins orchestrator UI."
---

Stop the running Reins Gradio server.

```bash
lsof -ti :7860 | xargs kill 2>/dev/null && echo "Reins stopped." || echo "Reins is not running."
```
