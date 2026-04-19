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

- [Claude Code](https://claude.ai/code) with Max subscription
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- [gh](https://cli.github.com/) (GitHub CLI, authenticated)

## License

MIT
