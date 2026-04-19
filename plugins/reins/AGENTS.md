# AGENTS.md

This file provides repo-wide guidance for agentic coding tools (Codex, Claude Code, Cursor, etc.).

## What This Is

Reins is a Claude Code plugin that orchestrates multi-agent sprints. It is a TypeScript Bun server with `.md` agent definitions, skill instructions, and hook scripts.

## Source of Truth

```
.claude-plugin/plugin.json   ← Plugin manifest (name, version, description)
agents/*.md                   ← Agent definitions (Executor, Reviewer, Tester, Planner, Designer)
skills/*/SKILL.md             ← Skill definitions (sprint, plan, backend-tdd, frontend-tdd, sandbox-tester)
hooks/hooks.json              ← Hook registration (PreToolUse for Write/Edit/Bash)
hooks/scripts/*.sh            ← Hook implementations (bash, reads JSON from stdin)
commands/*.md                 ← Slash commands (/reins, /reins-stop)
src/*.ts                      ← Bun server + orchestrator runtime (TypeScript)
```

## Guardrails

- Agent `.md` files are prompts, not code. Do not add TS/JS logic to them.
- Hook scripts read JSON from stdin and output JSON to stdout. They must exit 0.
- The server runs via `bun run src/server.ts`. Entry point is `src/server.ts`.
- Version must match in both `package.json` and `.claude-plugin/plugin.json`.

## Agent Architecture

```
Orchestrator (Bun HTTP + WebSocket, src/server.ts)
  │
  ├── Router (1-shot query)     → src/router.ts
  ├── Verifier (1-shot query)   → src/verifier.ts
  │
  ├── Executor (query session)  → agents/executor.md
  ├── Reviewer (query session)  → agents/reviewer.md
  ├── Tester   (query session)  → agents/tester.md
  ├── Planner  (query session)  → agents/planner.md
  └── Designer (query session)  → agents/designer.md
```

- Session agents stream tool calls to the UI via WebSocket in real-time
- Router and Verifier are stateless 1-shot calls (no streaming)
- Agent sessions are per-card, per-task. Context resets between cards.
- SDK uses `query()` from `@anthropic-ai/claude-agent-sdk` for all agent interactions

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
bun run src/server.ts                    # Launch server on :7860
bun run build                            # Compile to native binary

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
- TypeScript modules: kebab-case `.ts` in `src/`
- Versions: semver in `package.json` + `.claude-plugin/plugin.json` (must match)

## MUST NOT

- Commit `node_modules/`, `.harness/`, `.reins/`, `bun.lockb`
- Put Python code in this repo (it's TypeScript + Markdown + Bash)
- Modify hook scripts to require external binaries beyond `jq` and `bash`
