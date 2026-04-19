# AGENTS.md

This file provides repo-wide guidance for agentic coding tools (Codex, Claude Code, Cursor, etc.).

## What This Is

Reins is a Claude Code plugin that orchestrates multi-agent sprints. It is NOT a Python library — it is a directory of `.md` agent definitions, skill instructions, hook scripts, and a Gradio UI.

## Source of Truth

```
.claude-plugin/plugin.json   ← Plugin manifest (name, version, description)
agents/*.md                   ← Agent definitions (Executor, Reviewer, Tester, Planner, Designer)
skills/*/SKILL.md             ← Skill definitions (sprint, plan, backend-tdd, frontend-tdd, sandbox-tester)
hooks/hooks.json              ← Hook registration (PreToolUse for Write/Edit/Bash)
hooks/scripts/*.sh            ← Hook implementations (bash, reads JSON from stdin)
commands/*.md                 ← Slash commands (/reins, /reins-stop)
scripts/*.py                  ← Gradio UI + orchestrator runtime (Python)
```

## Guardrails

- Agent `.md` files are prompts, not code. Do not add Python/JS logic to them.
- Hook scripts read JSON from stdin and output JSON to stdout. They must exit 0.
- `scripts/*.py` imports are relative (no `harness.` prefix). All modules live flat in `scripts/`.
- The Gradio UI runs via `uv run --with gradio --with claude-agent-sdk python scripts/gradio-ui.py`. No venv is committed.
- `package.json` exists for npm publishing only. There is no JS code.
- Version must match in both `package.json` and `.claude-plugin/plugin.json`.

## Agent Architecture

```
Orchestrator (Python state machine, scripts/gradio-ui.py)
  │
  ├── Router (1-shot query)     → scripts/router.py
  ├── Verifier (1-shot query)   → scripts/verifier.py
  │
  ├── Executor (ClaudeSDKClient session)  → agents/executor.md
  ├── Reviewer (ClaudeSDKClient session)  → agents/reviewer.md
  ├── Tester   (ClaudeSDKClient session)  → agents/tester.md
  ├── Planner  (ClaudeSDKClient session)  → agents/planner.md
  └── Designer (ClaudeSDKClient session)  → agents/designer.md
```

- Session agents stream tool calls to Gradio in real-time
- Router and Verifier are stateless 1-shot calls (no streaming)
- Agent sessions are per-card, per-task. Context resets between cards.

## External Dependencies (soft)

Agent `.md` files reference skills and MCP servers from other plugins. These are **soft dependencies** — agents work without them but are stronger with them:

| Reference in agents | Source plugin | Fallback without it |
|--------------------|--------------|-------------------|
| `superpowers:test-driven-development` | superpowers | Built-in TDD rules in executor.md |
| `superpowers:systematic-debugging` | superpowers | Agent reasons about bugs directly |
| `superpowers:verification-before-completion` | superpowers | Agent runs tests manually |
| `superpowers:brainstorming` | superpowers | Agent explores approaches inline |
| `coderabbit:code-review` | coderabbit | Agent does SOLID/clean code review using built-in checklist |
| `codex:codex-cli-runtime` | codex (OpenAI) | No cross-model review. Claude reviews alone. |
| `qodo:qodo-get-rules` | qodo | Agent skips project rules check |
| `/qa`, `/browse`, `/gstack` | gstack | Agent uses curl for API testing only. No browser testing. |
| `/investigate` | gstack | Agent debugs inline |
| `/design-review`, `/design-shotgun` | gstack | No visual audit capability |
| `/benchmark`, `/audit` | gstack | No performance/quality audit |
| `chrome-devtools-mcp` | chrome-devtools-mcp plugin | No browser automation for Tester |
| `supabase` MCP | supabase MCP | No direct SQL access |
| `context7` MCP | context7 MCP | Agent uses training knowledge for framework docs |
| `serena` MCP | serena MCP | Agent uses Glob/Grep instead of semantic code nav |

## Commands

```bash
# Development
uv run python scripts/gradio-ui.py          # Launch Gradio UI on :7860
uv run pytest scripts/                       # Run tests (if test files exist in scripts/)

# Testing hooks
echo '{"tool_input":{"file_path":"tests/test_foo.py","content":".skip()"}}' | bash hooks/scripts/check-write.sh
echo '{"tool_input":{"command":"git push --force"}}' | bash hooks/scripts/check-bash.sh

# Release
# 1. Update version in package.json AND .claude-plugin/plugin.json
# 2. git tag v{version}
# 3. git push origin main --tags
# CI auto-creates GitHub Release on tag push.
```

## File Conventions

- Agent definitions: kebab-case `.md` in `agents/`
- Skills: kebab-case directory in `skills/` with `SKILL.md`
- Commands: kebab-case `.md` in `commands/`
- Hook scripts: `check-*.sh` in `hooks/scripts/`
- Python modules: snake_case `.py` in `scripts/`
- Versions: semver in `package.json` + `.claude-plugin/plugin.json` (must match)

## MUST NOT

- Commit `.venv/`, `node_modules/`, `__pycache__/`, `.harness/`, `.reins/`
- Add `harness.` prefix to Python imports (modules are flat in `scripts/`)
- Put JS/TS code in this repo (it's Python + Markdown + Bash)
- Modify hook scripts to require external binaries beyond `jq` and `bash`
