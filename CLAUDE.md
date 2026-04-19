# Reins — Claude Code Project Instructions

## Project Structure

- `reins/` is a **standalone git repo** (`git@github.com:lifeodyssey/reins.git`), nested inside `harness-engineering/`
- Always `cd` to `reins/` before git operations — the parent repo has its own history
- Plugin code lives at `plugins/reins/` (relative to repo root)

## Tech Stack

- **Runtime:** Bun (TypeScript)
- **SDK:** `@anthropic-ai/claude-agent-sdk` (npm)
- **UI:** Plain HTML/CSS/JS served by Bun HTTP + WebSocket (no framework)
- **Build:** `bun build --compile src/server.ts --outfile reins` → single native binary (~59MB, <200ms)
- **CI:** GitHub Actions — `oven-sh/setup-bun` + cross-compile for macOS ARM64, Linux x64, Windows x64

## TS SDK Notes (`@anthropic-ai/claude-agent-sdk`)

The TS SDK API differs from the Python SDK:

- **No `ClaudeSDKClient`** — use `query()` for everything (oneshot and session-based)
- `query()` returns a `Query` (extends `AsyncGenerator<SDKMessage>`) with `.interrupt()` and `.close()`
- **Message content path:** `SDKAssistantMessage` wraps a `BetaMessage` — access content at `msg.message.content`, not `msg.content`
- **Message type field:** discriminate on `msg.type` — values are `'assistant'`, `'user'`, `'result'`, `'system'`, `'rate_limit_event'`
- **Options:** `query({ prompt, options: { model, systemPrompt, allowedTools } })`
- For sessions: use `unstable_v2_createSession()` / `.send()` / `.stream()` if back-and-forth is needed; otherwise `query()` per task is sufficient

## CI / GitHub Actions

- **Release trigger:** tag push (`v*`) only, not push to main
- **Version sync:** always bump `package.json` + `.claude-plugin/plugin.json` + git tag together — marketplace uses package version, not tag
- **Action versions:** check latest with `curl -s https://api.github.com/repos/{owner}/{repo}/releases/latest | grep tag_name` before adding
- **macOS x64 (macos-13):** deprecated, removed — only build ARM64

## Build & Dev Gotchas

- `bun install` can hang on dependency resolution — fallback: `npm install --ignore-scripts`
- `bun build --compile` cross-compiles via `--target=bun-darwin-arm64|bun-linux-x64|bun-windows-x64`
- TypeScript 6 works fine with Bun and the SDK

## Security Hooks

This project has PreToolUse hooks that gate file writes:

- **innerHTML warning:** blocks `Write` if HTML contains `innerHTML`. Use `document.createElement()` + `textContent` instead
- **GitHub Actions warning:** blocks `Write` on `.yml` workflow files. Use `Edit` (targeted replacements) to bypass
- **Force push block:** `--force` / `-f` with `push` is blocked

## File Layout

```
plugins/reins/
├── .claude-plugin/plugin.json   ← marketplace metadata
├── src/                         ← TypeScript source (10 modules)
│   ├── server.ts                ← entry: Bun HTTP + WebSocket
│   ├── ui.ts                    ← HTML/CSS/JS as template literal
│   ├── stream.ts                ← SDK message → display formatter
│   ├── orchestrator.ts          ← CardState, SprintPlan, wave logic
│   ├── router.ts                ← routing decision prompt + parser
│   ├── verifier.ts              ← verification prompt + parser
│   ├── agents.ts                ← agent config registry
│   ├── state.ts                 ← Phase enum, AgentSession
│   ├── events.ts                ← JSONL event logger
│   └── github.ts                ← gh/git CLI wrapper
├── commands/                    ← slash commands (reins, reins-stop)
├── agents/                      ← agent .md definitions (unchanged)
├── skills/                      ← skill definitions
├── hooks/                       ← bash hook scripts (unchanged)
├── package.json
└── tsconfig.json
```

## Unchanged from Python era

- Agent definitions (`agents/*.md`) — pure markdown
- Hook scripts (`hooks/`) — pure bash
- Skills (`skills/`) — markdown (updated launch command)
- AGENTS.md, README.md
