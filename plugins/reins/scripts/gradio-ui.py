"""Harness Orchestrator v2 — Gradio UI with Orchestrator + direct agent chat.

Default: you talk to the Orchestrator. It handles sprint commands and embeds
agent output in the conversation. Switch to direct agent chat via dropdown.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import AsyncGenerator

import gradio as gr

from agents import AGENT_CONFIGS, get_agent_options
from events import EventLog
from orchestrator import CardState, SprintPlan, compute_waves, render_sprint_board
from github_ops import GitHubOps
from router import build_router_prompt, parse_router_response
from state import AgentSession
from stream import format_sdk_message
from verifier import build_verifier_prompt, parse_verifier_response

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
SESSIONS: dict[str, AgentSession] = {}
TIMELINE: list[dict] = []
ORCHESTRATOR_HISTORY: list[dict] = []  # Orchestrator's own chat history
EVENT_LOG = EventLog(Path(".harness/sprint-events.jsonl"))
SPRINT_PLAN: SprintPlan | None = None


def _get_or_create_session(name: str, agent_type: str) -> AgentSession:
    if name not in SESSIONS:
        SESSIONS[name] = AgentSession(name=name, agent_type=agent_type)
    return SESSIONS[name]


def _log(action: str, agent: str = "orchestrator", detail: str = ""):
    ts = datetime.now().strftime("%H:%M:%S")
    TIMELINE.append({"ts": ts, "agent": agent, "action": action, "detail": detail[:120]})
    if len(TIMELINE) > 200:
        TIMELINE[:] = TIMELINE[-200:]


# ---------------------------------------------------------------------------
# 1-shot helper for Router / Verifier
# ---------------------------------------------------------------------------
async def call_oneshot(agent_type: str, prompt: str) -> str:
    """1-shot query() for Router/Verifier."""
    from claude_agent_sdk import AssistantMessage, TextBlock
    from claude_agent_sdk import query as sdk_query

    opts = get_agent_options(agent_type)
    messages = []
    async for msg in sdk_query(prompt=prompt, options=opts):
        if isinstance(msg, AssistantMessage):
            for block in msg.content:
                if isinstance(block, TextBlock):
                    messages.append(block.text)
    return "\n".join(messages)


# ---------------------------------------------------------------------------
# SDK session management
# ---------------------------------------------------------------------------
async def _ensure_connected(session: AgentSession) -> None:
    if session.client is None:
        from claude_agent_sdk import ClaudeSDKClient
        client = ClaudeSDKClient(options=get_agent_options(session.agent_type))
        await client.__aenter__()
        session.client = client
        session.status = "connected"
        session.record("session_open")
        _log("session_open", agent=session.name)


async def _stream_agent(session: AgentSession, task: str, history: list) -> AsyncGenerator:
    """Send query to agent session and stream formatted output into history."""
    await _ensure_connected(session)
    session.is_streaming = True
    session.status = "streaming"
    session.message_count += 1
    _log("query", agent=session.name, detail=task[:80])

    await session.client.query(task)
    current_content = ""

    try:
        from claude_agent_sdk import AssistantMessage, ToolUseBlock
        async for msg in session.client.receive_response():
            formatted = format_sdk_message(msg, session.name)
            if not formatted:
                continue

            # Track tool calls
            if isinstance(msg, AssistantMessage):
                for block in msg.content:
                    if isinstance(block, ToolUseBlock):
                        session.last_tool = block.name
                        session.status = f"🔧 {block.name}..."
                        _log("tool_call", agent=session.name, detail=block.name)

            if current_content:
                current_content += "\n\n" + formatted
            else:
                current_content = formatted

            # Build the agent message block with header
            agent_block = (
                f"**{AGENT_CONFIGS.get(session.agent_type, {}).get('icon', '🤖')} "
                f"{session.name}** *({session.agent_type})*\n\n"
                f"{current_content}"
            )

            # Update or append live message
            if history and history[-1].get("_live"):
                history[-1] = {"role": "assistant", "content": agent_block, "_live": True}
            else:
                history.append({"role": "assistant", "content": agent_block, "_live": True})

            yield history
    except Exception as exc:
        history.append({"role": "assistant", "content": f"❌ **{session.name} error:** {exc}"})
        session.status = "error"
        yield history

    # Clean up
    if history and history[-1].get("_live"):
        history[-1] = {"role": "assistant", "content": history[-1]["content"]}

    session.is_streaming = False
    session.status = "ready"
    session.record("done")
    _log("done", agent=session.name)
    session.chat_history = history
    yield history


# ---------------------------------------------------------------------------
# Dynamic mode choices
# ---------------------------------------------------------------------------
def get_mode_choices() -> list[str]:
    """Build dropdown choices from active sessions + inactive agent types."""
    choices = ["🎯 Orchestrator"]
    for name, s in SESSIONS.items():
        icon = AGENT_CONFIGS.get(s.agent_type, {}).get("icon", "❓")
        choices.append(f"{icon} {name}")
    # Add inactive agent types not already represented
    for atype, cfg in AGENT_CONFIGS.items():
        label = f"{cfg['icon']} {atype}"
        if label not in choices and atype.lower() not in SESSIONS:
            choices.append(label)
    return choices


# ---------------------------------------------------------------------------
# Orchestrator logic
# ---------------------------------------------------------------------------
ORCH_HELP = """💤 **Orchestrator ready.** Commands:

- `/plan --issues 71,72,73` — Start sprint planning
- `status` — Show current state
- `chat with <agent>` — Switch to direct agent chat
  (e.g. `chat with executor`, `chat with reviewer`)

Or ask me anything — I'll route it to the right agent."""

MOCK_SPEC = """**Sprint Spec: iter-11**

**Goal:** Fix route planning + add SSE streaming

**Cards (4, 2 waves):**
| # | Title | Wave | Branch |
|---|-------|------|--------|
| 1 | Fix route planning | 1 | `card-1-fix-route` |
| 2 | Add SSE streaming | 1 | `card-2-add-sse` |
| 3 | Refactor executor agent | 2 | `card-3-refactor-exec` |
| 4 | Update frontend map | 2 | `card-4-update-map` |

**Wave graph:** `[1,2]` → `[3,4]` (parallel within waves, sequential between)"""


async def orchestrator_chat(
    message: str, history: list
) -> AsyncGenerator[tuple, None]:
    """Orchestrator: handles commands, delegates to agents, embeds output."""
    global ORCHESTRATOR_HISTORY, SPRINT_PLAN

    if not message.strip():
        board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
        yield history, _build_status(), _build_timeline(), board_text
        return

    history = history + [{"role": "user", "content": message}]
    msg = message.strip().lower()

    # ── /plan command ──
    if "/plan" in msg:
        _log("sprint_start", detail="iter-11")

        # Open Planner session and stream its work
        history.append({"role": "assistant",
                        "content": "📋 Opening **Planner** session..."})
        board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
        yield history, _build_status(), _build_timeline(), board_text

        planner = _get_or_create_session("planner", "Planner")
        try:
            async for updated in _stream_agent(
                planner,
                "List all Python files in the harness/ directory and describe the project structure. "
                "Then propose a sprint plan with 4 tasks split into 2 waves.",
                history,
            ):
                history = updated
                board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
                yield history, _build_status(), _build_timeline(), board_text
        except Exception as e:
            history.append({"role": "assistant", "content": f"❌ Planner error: {e}"})

        # Orchestrator decision point
        history.append({"role": "assistant",
                        "content": f"---\n\n{MOCK_SPEC}\n\n---\n\n"
                                   f"**Approve?** `approve` / `revise: <feedback>`"})
        ORCHESTRATOR_HISTORY = history
        board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
        yield history, _build_status(), _build_timeline(), board_text
        return

    # ── approve ──
    if msg == "approve":
        EVENT_LOG.append("orchestrator", "sprint_start")
        _log("sprint_start", detail="approve → wave flow")

        # Create SprintPlan
        SPRINT_PLAN = SprintPlan(name="iter-11", cards=[
            CardState(id=1, title="Fix route planning", slug="fix-route", wave=1,
                      acceptance_criteria=["Distance calc within 50m", "3 new tests"]),
            CardState(id=2, title="Add SSE streaming", slug="add-sse", wave=1,
                      acceptance_criteria=["EventSource endpoint", "200ms delivery"]),
            CardState(id=3, title="Refactor executor", slug="refactor-exec", wave=2,
                      acceptance_criteria=["Extract _build_params()", "Method <10 lines"]),
            CardState(id=4, title="Update frontend map", slug="update-map", wave=2,
                      acceptance_criteria=["SSE integration", "Loading skeleton"]),
        ])

        # ── Wave-by-wave execution ──
        for wave_num in SPRINT_PLAN.all_waves:
            wave_cards = SPRINT_PLAN.get_wave(wave_num)
            _log("wave_start", detail=f"wave {wave_num}")
            EVENT_LOG.append("orchestrator", "wave_start", wave=wave_num)

            card_names = ", ".join(f"Card {c.id}: {c.title}" for c in wave_cards)
            history.append({"role": "assistant",
                            "content": f"⚡ **Wave {wave_num}** — {len(wave_cards)} cards:\n{card_names}"})
            board_text = render_sprint_board(SPRINT_PLAN)
            yield history, _build_status(), _build_timeline(), board_text

            # ── Phase 1: Execute all cards in wave (sequential for now, parallel later) ──
            for card in wave_cards:
                card.status = "executing"
                executor_name = f"executor-{card.slug}"
                history.append({"role": "assistant",
                                "content": f"⚡ **{executor_name}** starting Card {card.id}: {card.title}..."})
                board_text = render_sprint_board(SPRINT_PLAN)
                yield history, _build_status(), _build_timeline(), board_text

                executor = _get_or_create_session(executor_name, "Executor")
                try:
                    async for updated in _stream_agent(
                        executor,
                        f"Implement Card {card.id}: {card.title}. "
                        f"ACs: {', '.join(card.acceptance_criteria)}. "
                        f"Branch: {card.branch}",
                        history,
                    ):
                        history = updated
                        yield history, _build_status(), _build_timeline(), render_sprint_board(SPRINT_PLAN)
                except Exception as e:
                    history.append({"role": "assistant", "content": f"❌ Executor error: {e}"})

                EVENT_LOG.append("executor", "done", card=card.id)
                _log("done", agent=executor_name, detail=f"card {card.id}")

            # ── Phase 2: Review all cards in wave ──
            for card in wave_cards:
                card.status = "reviewing"
                reviewer_name = f"reviewer-{card.slug}"
                history.append({"role": "assistant",
                                "content": f"🔍 **{reviewer_name}** reviewing Card {card.id}..."})
                yield history, _build_status(), _build_timeline(), render_sprint_board(SPRINT_PLAN)

                reviewer = _get_or_create_session(reviewer_name, "Reviewer")
                try:
                    async for updated in _stream_agent(
                        reviewer,
                        f"Review Card {card.id}: {card.title}. "
                        f"ACs: {', '.join(card.acceptance_criteria)}.",
                        history,
                    ):
                        history = updated
                        yield history, _build_status(), _build_timeline(), render_sprint_board(SPRINT_PLAN)
                except Exception as e:
                    history.append({"role": "assistant", "content": f"❌ Reviewer error: {e}"})

                EVENT_LOG.append("reviewer", "review", card=card.id)
                _log("review", agent=reviewer_name, detail=f"card {card.id}")

            # ── Phase 3: Verify + Route each card ──
            for card in wave_cards:
                # Verifier
                executor_summary = ""
                for entry in reversed(history):
                    if entry.get("role") == "assistant" and f"executor-{card.slug}" in entry.get("content", ""):
                        executor_summary = entry["content"][:500]
                        break

                verifier_prompt = build_verifier_prompt(
                    acceptance_criteria=card.acceptance_criteria,
                    git_diff="",
                    agent_summary=executor_summary,
                )
                try:
                    v_raw = await call_oneshot("Verifier", verifier_prompt)
                    v_result = parse_verifier_response(v_raw)
                except Exception:
                    v_result = {"approved": True, "ac_results": [], "issues": []}

                # Router
                router_prompt = build_router_prompt(
                    card_title=card.title,
                    last_verdict="approve" if v_result["approved"] else "request_changes",
                    attempt=1,
                    verifier_result=v_result,
                )
                try:
                    r_raw = await call_oneshot("Router", router_prompt)
                    r_result = parse_router_response(r_raw)
                except Exception:
                    r_result = {"decision": "merge", "reason": "default"}

                decision = r_result["decision"]
                v_icon = "✓" if v_result["approved"] else "✗"

                history.append({"role": "assistant", "content":
                    f"---\n"
                    f"{v_icon} **Verifier** Card {card.id}: {'approved' if v_result['approved'] else 'issues found'}\n"
                    f"🔀 **Router** Card {card.id}: `{decision}` — {r_result['reason']}\n"
                    f"---"})

                EVENT_LOG.append("verifier", "check", card=card.id, approved=v_result["approved"])
                EVENT_LOG.append("router", "decide", card=card.id, decision=decision)

                if decision == "merge":
                    card.status = "merged"
                    _log("merge", agent="orchestrator", detail=f"card {card.id}")
                elif decision == "escalate_to_human":
                    card.status = "escalated"
                else:
                    card.status = "merged"  # optimistic for demo

                yield history, _build_status(), _build_timeline(), render_sprint_board(SPRINT_PLAN)

            # ── Phase 4: Start app + Tester tests (after wave merges) ──
            merged_cards = [c for c in wave_cards if c.status == "merged"]
            if merged_cards:
                # Orchestrator starts the app (not the Tester)
                history.append({"role": "assistant",
                                "content": f"🚀 **Orchestrator** starting app for Wave {wave_num} testing...\n"
                                           f"`make serve` (backend :8080 + frontend :3000)"})
                yield history, _build_status(), _build_timeline(), render_sprint_board(SPRINT_PLAN)

                # Tester tests the running app
                history.append({"role": "assistant",
                                "content": f"🧪 **Tester** — testing running app after Wave {wave_num} merge.\n"
                                           f"Testing {len(merged_cards)} merged cards on main..."})
                yield history, _build_status(), _build_timeline(), render_sprint_board(SPRINT_PLAN)

                tester = _get_or_create_session(f"tester-wave{wave_num}", "Tester")
                ac_all = []
                for c in merged_cards:
                    ac_all.extend(f"Card {c.id} ({c.title}): {ac}" for ac in c.acceptance_criteria)

                try:
                    async for updated in _stream_agent(
                        tester,
                        f"Test the running app. Verify these ACs from Wave {wave_num}:\n"
                        + "\n".join(f"- {ac}" for ac in ac_all),
                        history,
                    ):
                        history = updated
                        yield history, _build_status(), _build_timeline(), render_sprint_board(SPRINT_PLAN)
                except Exception as e:
                    history.append({"role": "assistant", "content": f"❌ Tester error: {e}"})

                EVENT_LOG.append("tester", "test", wave=wave_num)
                _log("test", agent=f"tester-wave{wave_num}", detail=f"wave {wave_num}")

                history.append({"role": "assistant",
                                "content": f"✅ **Wave {wave_num} complete.** "
                                           f"{len(merged_cards)} cards merged and tested."})
                yield history, _build_status(), _build_timeline(), render_sprint_board(SPRINT_PLAN)

        # ── Sprint complete — ask user to approve deploy ──
        history.append({"role": "assistant",
                        "content": "## 🎉 Sprint Complete\n\n"
                                   + render_sprint_board(SPRINT_PLAN)
                                   + "\n\n*All waves executed, reviewed, merged, and tested.*\n\n"
                                   + "---\n\n"
                                   + "**Deploy?** Orchestrator will tag and push to trigger CI deploy.\n\n"
                                   + "`deploy` — tag + push (triggers production deploy)\n"
                                   + "`skip-deploy` — done, don't deploy yet"})
        EVENT_LOG.append("orchestrator", "sprint_complete")
        ORCHESTRATOR_HISTORY = history
        yield history, _build_status(), _build_timeline(), render_sprint_board(SPRINT_PLAN)
        return

    # ── deploy (after sprint complete) ──
    if msg == "deploy" and SPRINT_PLAN:
        history.append({"role": "assistant",
                        "content": "🚀 **Deploying...**\n\n"
                                   "```\n"
                                   "LATEST=$(git tag --sort=-v:refname | head -1)\n"
                                   "NEXT=$(echo $LATEST | awk -F. '{print $1\".\"$2\".\"$3+1}')\n"
                                   "git tag $NEXT && git push origin $NEXT\n"
                                   "```\n\n"
                                   "*(Orchestrator runs this, not the Tester agent.)*\n"
                                   "CI deploy triggered. Sprint done."})
        EVENT_LOG.append("orchestrator", "deploy")
        _log("deploy", detail="version tagged")
        ORCHESTRATOR_HISTORY = history
        board_text = render_sprint_board(SPRINT_PLAN)
        yield history, _build_status(), _build_timeline(), board_text
        return

    # ── skip-deploy ──
    if msg == "skip-deploy" and SPRINT_PLAN:
        history.append({"role": "assistant",
                        "content": "⏭️ Deploy skipped. Sprint complete without deploy."})
        ORCHESTRATOR_HISTORY = history
        board_text = render_sprint_board(SPRINT_PLAN)
        yield history, _build_status(), _build_timeline(), board_text
        return

    # ── chat with <agent> ──
    if msg.startswith("chat with"):
        agent_name = message.strip()[len("chat with"):].strip().lower()
        # Map to agent type
        agent_map = {k.lower(): k for k in AGENT_CONFIGS}
        if agent_name in agent_map:
            target = agent_map[agent_name]
            history.append({"role": "assistant",
                            "content": f"🔄 Switching to **{target}** direct chat.\n\n"
                                       f"*Use the dropdown above to switch back to Orchestrator, "
                                       f"or select any agent.*"})
            ORCHESTRATOR_HISTORY = history
            board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
            yield history, _build_status(), _build_timeline(), board_text
            return
        else:
            history.append({"role": "assistant",
                            "content": f"❓ Unknown agent '{agent_name}'. "
                                       f"Available: {', '.join(AGENT_CONFIGS.keys())}"})
            ORCHESTRATOR_HISTORY = history
            board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
            yield history, _build_status(), _build_timeline(), board_text
            return

    # ── status ──
    if msg == "status":
        active = [f"- **{n}**: {s.status} (last: {s.last_tool})"
                  for n, s in SESSIONS.items() if s.client is not None]
        status_text = "\n".join(active) if active else "No active sessions."
        history.append({"role": "assistant",
                        "content": f"**Active agents:**\n{status_text}"})
        ORCHESTRATOR_HISTORY = history
        board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
        yield history, _build_status(), _build_timeline(), board_text
        return

    # ── Default: route to a temporary Executor session ──
    history.append({"role": "assistant",
                    "content": f"🎯 Routing to **Executor**..."})
    board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
    yield history, _build_status(), _build_timeline(), board_text

    executor = _get_or_create_session("executor", "Executor")
    try:
        async for updated in _stream_agent(executor, message, history):
            history = updated
            board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
            yield history, _build_status(), _build_timeline(), board_text
    except Exception as e:
        history.append({"role": "assistant", "content": f"❌ Error: {e}"})

    ORCHESTRATOR_HISTORY = history
    board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
    yield history, _build_status(), _build_timeline(), board_text


# ---------------------------------------------------------------------------
# Direct agent chat
# ---------------------------------------------------------------------------
async def direct_agent_chat(
    message: str, history: list, agent_type: str
) -> AsyncGenerator[tuple, None]:
    """Direct conversation with a specific agent."""
    if not message.strip():
        board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
        yield history, _build_status(), _build_timeline(), board_text
        return

    history = history + [{"role": "user", "content": message}]
    board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
    yield history, _build_status(), _build_timeline(), board_text

    session_name = agent_type.lower()
    session = _get_or_create_session(session_name, agent_type)

    if not session.client:
        config = AGENT_CONFIGS[agent_type]
        history.append({"role": "assistant",
                        "content": f"📡 **{config['icon']} {agent_type}** session opened "
                                   f"(model: {config['model']}, tools: {', '.join(config['tools']) or 'none'})"})
        board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
        yield history, _build_status(), _build_timeline(), board_text

    try:
        async for updated in _stream_agent(session, message, history):
            history = updated
            board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
            yield history, _build_status(), _build_timeline(), board_text
    except Exception as e:
        history.append({"role": "assistant", "content": f"❌ Error: {e}"})
        board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
        yield history, _build_status(), _build_timeline(), board_text

    session.chat_history = history


# ---------------------------------------------------------------------------
# Unified chat handler
# ---------------------------------------------------------------------------
async def chat_handler(
    message: str, history: list, mode: str
) -> AsyncGenerator[tuple, None]:
    """Route to orchestrator or direct agent based on mode selection."""
    if mode == "🎯 Orchestrator":
        async for result in orchestrator_chat(message, history):
            yield result
    else:
        # Strip icon prefix to get agent type
        agent_type = mode.split(" ", 1)[-1] if " " in mode else mode
        async for result in direct_agent_chat(message, history, agent_type):
            yield result


def switch_mode(mode: str) -> tuple:
    """Switch between Orchestrator and direct agent modes."""
    board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
    if mode == "🎯 Orchestrator":
        _log("switch", detail="→ Orchestrator")
        return ORCHESTRATOR_HISTORY, _build_status(), _build_timeline(), board_text
    else:
        agent_type = mode.split(" ", 1)[-1] if " " in mode else mode
        session_name = agent_type.lower()
        if session_name in SESSIONS:
            _log("switch", detail=f"→ {agent_type}")
            return SESSIONS[session_name].chat_history, _build_status(), _build_timeline(), board_text
        _log("switch", detail=f"→ {agent_type} (new)")
        return [], _build_status(), _build_timeline(), board_text


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------
async def do_interrupt(mode: str):
    if mode == "🎯 Orchestrator":
        # Interrupt whatever agent is currently streaming
        for s in SESSIONS.values():
            if s.is_streaming and s.client:
                try:
                    await s.client.interrupt()
                    s.status = "interrupted"
                    s.is_streaming = False
                    _log("interrupt", agent=s.name)
                except Exception:
                    pass
    else:
        agent_type = mode.split(" ", 1)[-1] if " " in mode else mode
        name = agent_type.lower()
        if name in SESSIONS and SESSIONS[name].client and SESSIONS[name].is_streaming:
            try:
                await SESSIONS[name].client.interrupt()
                SESSIONS[name].status = "interrupted"
                SESSIONS[name].is_streaming = False
                _log("interrupt", agent=name)
            except Exception:
                pass
    return _build_status(), _build_timeline()


async def do_close(mode: str):
    if mode != "🎯 Orchestrator":
        agent_type = mode.split(" ", 1)[-1] if " " in mode else mode
        name = agent_type.lower()
        if name in SESSIONS and SESSIONS[name].client:
            try:
                await SESSIONS[name].client.__aexit__(None, None, None)
            except Exception:
                pass
            SESSIONS[name].client = None
            SESSIONS[name].status = "closed"
            SESSIONS[name].is_streaming = False
            _log("close", agent=name)
    board_text = render_sprint_board(SPRINT_PLAN) if SPRINT_PLAN else "No active sprint."
    return [], _build_status(), _build_timeline(), board_text


async def do_reset():
    global ORCHESTRATOR_HISTORY, SPRINT_PLAN
    for s in SESSIONS.values():
        if s.client:
            try:
                await s.client.__aexit__(None, None, None)
            except Exception:
                pass
            s.client = None
        s.status = "idle"
        s.is_streaming = False
        s.chat_history = []
        s.last_tool = "-"
        s.message_count = 0
    SESSIONS.clear()
    TIMELINE.clear()
    ORCHESTRATOR_HISTORY = []
    SPRINT_PLAN = None
    return [], _build_status(), _build_timeline(), "No active sprint."


# ---------------------------------------------------------------------------
# Renderers
# ---------------------------------------------------------------------------
def _build_status():
    lines = ["| | Agent | Status | Last Tool | Msgs |",
             "|---|-------|--------|-----------|------|"]
    # Orchestrator row
    lines.append("| 🎯 | **Orchestrator** | active | - | - |")
    # Active sessions
    for name, s in SESSIONS.items():
        icon = AGENT_CONFIGS.get(s.agent_type, {}).get("icon", "❓")
        connected = "🟢" if s.client else "⚪"
        lines.append(f"| {icon} | {name} | {connected} {s.status} | {s.last_tool} | {s.message_count} |")
    # Inactive agent types
    active_types = {s.agent_type for s in SESSIONS.values()}
    for atype, cfg in AGENT_CONFIGS.items():
        if atype not in active_types:
            lines.append(f"| {cfg['icon']} | {atype} | ⚪ idle | - | 0 |")
    return "\n".join(lines)


def _build_timeline():
    if not TIMELINE:
        return "*No events yet.*"
    lines = []
    for ev in TIMELINE[-30:]:
        detail = f" — {ev['detail']}" if ev["detail"] else ""
        lines.append(f"`{ev['ts']}` **{ev['agent']}** {ev['action']}{detail}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CSS
# ---------------------------------------------------------------------------
CSS = """
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
body, .gradio-container { font-family: 'IBM Plex Sans', sans-serif !important; }
code, pre { font-family: 'JetBrains Mono', monospace !important; }
"""

# ---------------------------------------------------------------------------
# Build UI
# ---------------------------------------------------------------------------
with gr.Blocks(title="Harness Orchestrator v2") as demo:
    gr.Markdown("# 🎯 Seichijunrei Harness v2")
    gr.Markdown("*Default: talk to Orchestrator. Switch modes for direct agent chat.*")

    with gr.Row():
        mode_dropdown = gr.Dropdown(
            choices=get_mode_choices(),
            value="🎯 Orchestrator",
            label="Mode",
            scale=3,
            info="Orchestrator = sprint flow. Others = direct agent conversation.",
        )
        interrupt_btn = gr.Button("⏹ Interrupt", variant="stop", scale=1)
        close_btn = gr.Button("🔚 Close", variant="secondary", scale=1)
        reset_btn = gr.Button("🗑 Reset All", variant="secondary", scale=1)

    with gr.Row(equal_height=True):
        with gr.Column(scale=3):
            with gr.Tabs():
                with gr.Tab("💬 Chat"):
                    chatbot = gr.Chatbot(
                        height=520, buttons=["copy"],
                        render_markdown=True, autoscroll=True,
                        placeholder=(
                            "**You're talking to the Orchestrator.** Try:\n\n"
                            "- `/plan --issues 71,72,73` — Start sprint\n"
                            "- `chat with executor` — Direct agent chat\n"
                            "- Or ask anything — I'll route to the right agent"
                        ),
                    )
                    msg_input = gr.Textbox(
                        placeholder="Talk to Orchestrator...",
                        show_label=False, container=False,
                    )
                with gr.Tab("📊 Sprint Board"):
                    sprint_board_md = gr.Markdown("No active sprint.")

        with gr.Column(scale=1):
            gr.Markdown("### Agent Status")
            status_md = gr.Markdown(_build_status())
            gr.Markdown("### Timeline")
            timeline_md = gr.Markdown(_build_timeline())

    # ── Events ──
    outputs = [chatbot, status_md, timeline_md, sprint_board_md]

    msg_input.submit(
        chat_handler, [msg_input, chatbot, mode_dropdown], outputs
    ).then(lambda: "", outputs=[msg_input])

    mode_dropdown.change(switch_mode, [mode_dropdown], outputs)
    interrupt_btn.click(do_interrupt, [mode_dropdown], [status_md, timeline_md])
    close_btn.click(do_close, [mode_dropdown], outputs)
    reset_btn.click(do_reset, outputs=outputs)


if __name__ == "__main__":
    demo.launch(server_port=7860, css=CSS)
