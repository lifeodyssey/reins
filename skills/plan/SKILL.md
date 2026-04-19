---
name: plan
description: "Sprint planning only. Use when the user wants to plan a sprint without launching the full UI. Runs the Planner agent to generate a spec from GitHub issues."
version: 0.1.0
---

# Reins Plan

Run the Planner agent to generate a sprint spec from GitHub issues.

## When to use
- User says "plan a sprint", "plan these issues"
- User wants a spec without the full Gradio UI

## Steps

1. Dispatch the Planner agent (from `$CLAUDE_PLUGIN_ROOT/agents/planner.md`)
2. The Planner reads the codebase and issues, produces a sprint spec
3. Present the spec for user approval
4. If approved, save to `docs/specs/YYYY-MM-DD-sprint.md`
