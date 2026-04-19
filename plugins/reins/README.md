# Reins

Harness engineering framework for Claude Code. A multi-agent sprint orchestrator that turns GitHub issues into merged PRs.

Label issues, run `/reins`, watch agents plan, execute, review, and test your code — with live streaming, interrupt, and direct agent chat. Built on harness engineering patterns from Anthropic, OpenAI, Stripe, and Martin Fowler.

## Install

```bash
claude plugin add github:lifeodyssey/reins
```

## Usage

```
/reins          Launch the orchestrator UI (Gradio)
/reins-stop     Stop the orchestrator
```

In the UI:
- **Orchestrator** (default) — run sprints: `/plan --issues 71,72,73` → `approve`
- **Executor** — direct chat, watch TDD in real-time
- **Reviewer** — direct chat, ask about findings
- **Tester** — direct chat, watch API tests
- **Planner** — direct chat, discuss architecture

## Architecture

```
You ──→ Orchestrator (Python state machine)
              │
              ├── Router (opus 1-shot) ── decides next step
              ├── Verifier (opus 1-shot) ── checks ACs
              │
              ├── Executor (sonnet session) ── TDD, creates PR
              ├── Reviewer (sonnet session) ── posts findings to PR
              ├── Tester (sonnet session) ── browser/API tests
              └── Planner (sonnet session) ── sprint specs
```

- **Turn-based sessions:** watch agents stream tool calls, interrupt, send feedback
- **Parallel waves:** cards within a wave run in separate git worktrees
- **Early-merge with rebase:** fast cards don't wait for slow ones
- **Permission hooks:** block test tampering, force push, source code leaks

## Requirements

### Required

- [Claude Code](https://claude.ai/code) with Max subscription
- [uv](https://docs.astral.sh/uv/) — Python package manager (runs Gradio UI)
- [gh](https://cli.github.com/) — GitHub CLI, authenticated (PR/merge/comment ops)

### Recommended Plugins

Reins agents include built-in rules for TDD, SOLID, clean code, and code review. These plugins add **extra capabilities** on top — if installed, agents automatically use them. If not, agents work with Claude's built-in abilities.

| Plugin | What it adds | Which agents use it |
|--------|-------------|-------------------|
| [superpowers](https://github.com/anthropics/superpowers) | TDD workflow, systematic debugging, verification checks, brainstorming | Executor, Planner |
| [coderabbit](https://github.com/coderabbitai/coderabbit) | Structured AI code review with CodeRabbit | Reviewer |
| [codex](https://github.com/openai/codex) | GPT-5.2 cross-review, independent second opinion | Executor, Reviewer |
| [gstack](https://github.com/garrytan/gstack) | Browser QA testing (`/qa`, `/browse`), benchmarks, audits | Tester |
| [qodo](https://qodo.ai) | Project coding rules enforcement | Reviewer |

### Recommended MCP Servers

| MCP Server | What it adds | Which agents use it |
|-----------|-------------|-------------------|
| chrome-devtools-mcp | Browser automation, screenshots, Lighthouse audits, a11y testing | Tester |
| supabase | SQL execution, migration management, query optimization | Executor, Reviewer, Tester |
| context7 | Framework docs lookup (latest API references) | Executor, Reviewer |
| serena | Semantic code navigation (find symbols, references) | Executor, Reviewer |

### Without any plugins/MCP

Reins still works. Each agent's prompt includes:
- **Executor:** Full TDD process, SOLID/clean code rules, smell prevention checklist, naming conventions
- **Reviewer:** 1-10-50 rule, code smell catalog, refactoring suggestions, SOLID checklist, test smell detection
- **Tester:** API testing via curl, edge case generation, evidence collection
- **Planner:** Spec structure, AC category rules, quality ratchet

The external tools make agents *better* (CodeRabbit catches things Claude misses, Codex provides genuine second opinions, gstack enables real browser testing). But the core harness works without them.

## Included Skills

| Skill | Description |
|-------|-------------|
| `sprint` | Full sprint orchestration (plan → execute → review → test → merge) |
| `plan` | Sprint planning only (generate spec from issues) |
| `backend-tdd` | Python/FastAPI TDD workflow |
| `frontend-tdd` | React/Next.js TDD workflow |
| `sandbox-tester` | Isolated sandbox testing |

## Permission Hooks

Reins registers these hooks to enforce agent boundaries:

| Hook | Event | What it blocks |
|------|-------|---------------|
| check-write | PreToolUse (Write/Edit) | `.skip()`, `.only()` in test files. Warns on 5+ hardcoded returns. |
| check-bash | PreToolUse (Bash) | `git push --force`, `git push -f` |

## License

MIT
