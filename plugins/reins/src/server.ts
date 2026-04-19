/**
 * Reins orchestrator — Bun HTTP + WebSocket server.
 *
 * Entry point: serves the mission-control UI on :7860 and handles
 * all orchestration via WebSocket messages.
 *
 * Uses `query()` from @anthropic-ai/claude-agent-sdk for all agent
 * interactions (both oneshot and session-based).
 */

import { AGENT_CONFIGS, getAgentOptions } from "./agents";
import { EventLog } from "./events";
import { buildRouterPrompt, parseRouterResponse } from "./router";
import { AgentSession, type ChatMessage } from "./state";
import { formatSdkMessage } from "./stream";
import { buildVerifierPrompt, parseVerifierResponse } from "./verifier";
import {
  type CardState,
  type SprintPlan,
  allWaves,
  cardBranch,
  createCard,
  getWave,
  renderSprintBoard,
} from "./orchestrator";
import { HTML } from "./ui";

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
const SESSIONS = new Map<string, AgentSession>();
const TIMELINE: { ts: string; agent: string; action: string; detail: string }[] = [];
let orchestratorHistory: ChatMessage[] = [];
const EVENT_LOG = new EventLog(".harness/sprint-events.jsonl");
let SPRINT_PLAN: SprintPlan | null = null;

// All connected WebSocket clients
const clients = new Set<any>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getOrCreateSession(name: string, agentType: string): AgentSession {
  let s = SESSIONS.get(name);
  if (!s) {
    s = new AgentSession(name, agentType);
    SESSIONS.set(name, s);
  }
  return s;
}

function log(action: string, agent = "orchestrator", detail = ""): void {
  const ts = new Date().toTimeString().slice(0, 8);
  TIMELINE.push({ ts, agent, action, detail: detail.slice(0, 120) });
  if (TIMELINE.length > 200) TIMELINE.splice(0, TIMELINE.length - 200);
}

function broadcast(msg: Record<string, unknown>): void {
  const json = JSON.stringify(msg);
  for (const ws of clients) {
    try {
      ws.send(json);
    } catch {}
  }
}

function pushFullState(history: ChatMessage[]): void {
  broadcast({
    type: "full",
    history: history.map(({ role, content }) => ({ role, content })),
    status: buildStatus(),
    timeline: buildTimeline(),
    board: renderSprintBoard(SPRINT_PLAN),
  });
}

// ---------------------------------------------------------------------------
// SDK query helper
// ---------------------------------------------------------------------------
async function runQuery(
  prompt: string,
  opts: ReturnType<typeof getAgentOptions>,
): Promise<{ messages: any[]; queryHandle: any }> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const q = query({
    prompt,
    options: {
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      allowedTools: opts.allowedTools,
    },
  });
  const messages: any[] = [];
  for await (const msg of q) {
    messages.push(msg);
  }
  return { messages, queryHandle: q };
}

// ---------------------------------------------------------------------------
// 1-shot helper (Router / Verifier)
// ---------------------------------------------------------------------------
async function callOneshot(agentType: string, prompt: string): Promise<string> {
  try {
    const opts = getAgentOptions(agentType);
    const { messages } = await runQuery(prompt, opts);
    const texts: string[] = [];
    for (const msg of messages) {
      if (msg.type === "assistant") {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text") texts.push(block.text);
        }
      }
    }
    return texts.join("\n");
  } catch (e: any) {
    return JSON.stringify({ decision: "escalate_to_human", reason: e.message });
  }
}

// ---------------------------------------------------------------------------
// Stream agent: fire query() and push each message to UI via WebSocket
// ---------------------------------------------------------------------------
async function streamAgent(session: AgentSession, task: string, history: ChatMessage[]): Promise<ChatMessage[]> {
  session.isStreaming = true;
  session.status = "streaming";
  session.messageCount++;
  log("query", session.name, task.slice(0, 80));

  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const opts = getAgentOptions(session.agentType);
  const q = query({
    prompt: task,
    options: {
      model: opts.model,
      systemPrompt: opts.systemPrompt,
      allowedTools: opts.allowedTools,
    },
  });

  // Store the Query handle so we can interrupt it
  session.client = q;
  let currentContent = "";

  try {
    for await (const msg of q) {
      const formatted = formatSdkMessage(msg, session.name);
      if (!formatted) continue;

      // Track tool calls
      if (msg.type === "assistant") {
        for (const block of (msg as any).message?.content ?? []) {
          if (block.type === "tool_use") {
            session.lastTool = block.name;
            session.status = `\u{1F527} ${block.name}...`;
            log("tool_call", session.name, block.name);
          }
        }
      }

      currentContent = currentContent ? currentContent + "\n\n" + formatted : formatted;

      const config = AGENT_CONFIGS[session.agentType];
      const icon = config?.icon ?? "\uD83E\uDD16";
      const agentBlock = `**${icon} ${session.name}** *(${session.agentType})*\n\n${currentContent}`;

      // Update or append live message
      if (history.length > 0 && history[history.length - 1]._live) {
        history[history.length - 1] = { role: "assistant", content: agentBlock, _live: true };
      } else {
        history.push({ role: "assistant", content: agentBlock, _live: true });
      }

      pushFullState(history);
    }
  } catch (err: any) {
    history.push({ role: "assistant", content: `\u274C **${session.name} error:** ${err.message}` });
    session.status = "error";
    pushFullState(history);
  }

  // Finalize live message
  if (history.length > 0 && history[history.length - 1]._live) {
    delete history[history.length - 1]._live;
  }

  session.isStreaming = false;
  session.status = "ready";
  session.client = null;
  session.record("done");
  log("done", session.name);
  session.chatHistory = history;
  pushFullState(history);
  return history;
}

// ---------------------------------------------------------------------------
// Orchestrator logic
// ---------------------------------------------------------------------------
const MOCK_SPEC = `**Sprint Spec: iter-11**

**Goal:** Fix route planning + add SSE streaming

**Cards (4, 2 waves):**
| # | Title | Wave | Branch |
|---|-------|------|--------|
| 1 | Fix route planning | 1 | \`card-1-fix-route\` |
| 2 | Add SSE streaming | 1 | \`card-2-add-sse\` |
| 3 | Refactor executor agent | 2 | \`card-3-refactor-exec\` |
| 4 | Update frontend map | 2 | \`card-4-update-map\` |

**Wave graph:** \`[1,2]\` \u2192 \`[3,4]\` (parallel within waves, sequential between)`;

async function orchestratorChat(message: string, history: ChatMessage[]): Promise<ChatMessage[]> {
  if (!message.trim()) {
    pushFullState(history);
    return history;
  }

  history = [...history, { role: "user", content: message }];
  const msg = message.trim().toLowerCase();

  // /plan command
  if (msg.includes("/plan")) {
    log("sprint_start", "orchestrator", "iter-11");
    history.push({ role: "assistant", content: "\uD83D\uDCCB Opening **Planner** session..." });
    pushFullState(history);

    const planner = getOrCreateSession("planner", "Planner");
    try {
      history = await streamAgent(
        planner,
        "List all Python files in the harness/ directory and describe the project structure. " +
          "Then propose a sprint plan with 4 tasks split into 2 waves.",
        history,
      );
    } catch (e: any) {
      history.push({ role: "assistant", content: `\u274C Planner error: ${e.message}` });
    }

    history.push({
      role: "assistant",
      content: `---\n\n${MOCK_SPEC}\n\n---\n\n**Approve?** \`approve\` / \`revise: <feedback>\``,
    });
    orchestratorHistory = history;
    pushFullState(history);
    return history;
  }

  // approve
  if (msg === "approve") {
    EVENT_LOG.append("orchestrator", "sprint_start");
    log("sprint_start", "orchestrator", "approve \u2192 wave flow");

    SPRINT_PLAN = {
      name: "iter-11",
      cards: [
        createCard(1, "Fix route planning", "fix-route", 1, ["Distance calc within 50m", "3 new tests"]),
        createCard(2, "Add SSE streaming", "add-sse", 1, ["EventSource endpoint", "200ms delivery"]),
        createCard(3, "Refactor executor", "refactor-exec", 2, ['Extract _build_params()', "Method <10 lines"]),
        createCard(4, "Update frontend map", "update-map", 2, ["SSE integration", "Loading skeleton"]),
      ],
    };

    for (const waveNum of allWaves(SPRINT_PLAN)) {
      const waveCards = getWave(SPRINT_PLAN, waveNum);
      log("wave_start", "orchestrator", `wave ${waveNum}`);
      EVENT_LOG.append("orchestrator", "wave_start", { wave: waveNum });

      const cardNames = waveCards.map((c) => `Card ${c.id}: ${c.title}`).join(", ");
      history.push({
        role: "assistant",
        content: `\u26A1 **Wave ${waveNum}** \u2014 ${waveCards.length} cards:\n${cardNames}`,
      });
      pushFullState(history);

      // Phase 1: Execute
      for (const card of waveCards) {
        card.status = "executing";
        const executorName = `executor-${card.slug}`;
        history.push({
          role: "assistant",
          content: `\u26A1 **${executorName}** starting Card ${card.id}: ${card.title}...`,
        });
        pushFullState(history);

        const executor = getOrCreateSession(executorName, "Executor");
        try {
          history = await streamAgent(
            executor,
            `Implement Card ${card.id}: ${card.title}. ` +
              `ACs: ${card.acceptanceCriteria.join(", ")}. ` +
              `Branch: ${cardBranch(card)}`,
            history,
          );
        } catch (e: any) {
          history.push({ role: "assistant", content: `\u274C Executor error: ${e.message}` });
        }
        EVENT_LOG.append("executor", "done", { card: card.id });
        log("done", executorName, `card ${card.id}`);
      }

      // Phase 2: Review
      for (const card of waveCards) {
        card.status = "reviewing";
        const reviewerName = `reviewer-${card.slug}`;
        history.push({ role: "assistant", content: `\uD83D\uDD0D **${reviewerName}** reviewing Card ${card.id}...` });
        pushFullState(history);

        const reviewer = getOrCreateSession(reviewerName, "Reviewer");
        try {
          history = await streamAgent(
            reviewer,
            `Review Card ${card.id}: ${card.title}. ACs: ${card.acceptanceCriteria.join(", ")}.`,
            history,
          );
        } catch (e: any) {
          history.push({ role: "assistant", content: `\u274C Reviewer error: ${e.message}` });
        }
        EVENT_LOG.append("reviewer", "review", { card: card.id });
        log("review", reviewerName, `card ${card.id}`);
      }

      // Phase 3: Verify + Route
      for (const card of waveCards) {
        let executorSummary = "";
        for (let i = history.length - 1; i >= 0; i--) {
          const entry = history[i];
          if (entry.role === "assistant" && entry.content.includes(`executor-${card.slug}`)) {
            executorSummary = entry.content.slice(0, 500);
            break;
          }
        }

        const verifierPrompt = buildVerifierPrompt(card.acceptanceCriteria, "", executorSummary);
        let vResult: { approved: boolean; acResults: any[]; issues: string[] };
        try {
          const vRaw = await callOneshot("Verifier", verifierPrompt);
          vResult = parseVerifierResponse(vRaw);
        } catch {
          vResult = { approved: true, acResults: [], issues: [] };
        }

        const routerPrompt = buildRouterPrompt(
          card.title,
          vResult.approved ? "approve" : "request_changes",
          1,
          JSON.stringify(vResult),
        );
        let rResult: { decision: string; reason: string };
        try {
          const rRaw = await callOneshot("Router", routerPrompt);
          rResult = parseRouterResponse(rRaw);
        } catch {
          rResult = { decision: "merge", reason: "default" };
        }

        const vIcon = vResult.approved ? "\u2713" : "\u2717";
        history.push({
          role: "assistant",
          content:
            `---\n${vIcon} **Verifier** Card ${card.id}: ${vResult.approved ? "approved" : "issues found"}\n` +
            `\uD83D\uDD00 **Router** Card ${card.id}: \`${rResult.decision}\` \u2014 ${rResult.reason}\n---`,
        });

        EVENT_LOG.append("verifier", "check", { card: card.id, approved: vResult.approved });
        EVENT_LOG.append("router", "decide", { card: card.id, decision: rResult.decision });

        if (rResult.decision === "merge") card.status = "merged";
        else if (rResult.decision === "escalate_to_human") card.status = "blocked";
        else card.status = "merged";

        pushFullState(history);
      }

      // Phase 4: Test merged cards
      const merged = waveCards.filter((c) => c.status === "merged");
      if (merged.length > 0) {
        history.push({
          role: "assistant",
          content:
            `\uD83D\uDE80 **Orchestrator** starting app for Wave ${waveNum} testing...\n` +
            "`make serve` (backend :8080 + frontend :3000)",
        });
        pushFullState(history);

        history.push({
          role: "assistant",
          content:
            `\uD83E\uDDEA **Tester** \u2014 testing running app after Wave ${waveNum} merge.\n` +
            `Testing ${merged.length} merged cards on main...`,
        });
        pushFullState(history);

        const tester = getOrCreateSession(`tester-wave${waveNum}`, "Tester");
        const acAll = merged.flatMap((c) => c.acceptanceCriteria.map((ac) => `Card ${c.id} (${c.title}): ${ac}`));

        try {
          history = await streamAgent(
            tester,
            `Test the running app. Verify these ACs from Wave ${waveNum}:\n` + acAll.map((ac) => `- ${ac}`).join("\n"),
            history,
          );
        } catch (e: any) {
          history.push({ role: "assistant", content: `\u274C Tester error: ${e.message}` });
        }

        EVENT_LOG.append("tester", "test", { wave: waveNum });
        log("test", `tester-wave${waveNum}`, `wave ${waveNum}`);

        history.push({
          role: "assistant",
          content: `\u2705 **Wave ${waveNum} complete.** ${merged.length} cards merged and tested.`,
        });
        pushFullState(history);
      }
    }

    // Sprint complete
    history.push({
      role: "assistant",
      content:
        "## \uD83C\uDF89 Sprint Complete\n\n" +
        renderSprintBoard(SPRINT_PLAN) +
        "\n\n*All waves executed, reviewed, merged, and tested.*\n\n---\n\n" +
        "**Deploy?** Orchestrator will tag and push to trigger CI deploy.\n\n" +
        "`deploy` \u2014 tag + push (triggers production deploy)\n" +
        "`skip-deploy` \u2014 done, don't deploy yet",
    });
    EVENT_LOG.append("orchestrator", "sprint_complete");
    orchestratorHistory = history;
    pushFullState(history);
    return history;
  }

  // deploy
  if (msg === "deploy" && SPRINT_PLAN) {
    history.push({
      role: "assistant",
      content:
        "\uD83D\uDE80 **Deploying...**\n\n```\n" +
        "LATEST=$(git tag --sort=-v:refname | head -1)\n" +
        "NEXT=$(echo $LATEST | awk -F. '{print $1\".\"$2\".\"$3+1}')\n" +
        "git tag $NEXT && git push origin $NEXT\n" +
        "```\n\n*(Orchestrator runs this, not the Tester agent.)*\nCI deploy triggered. Sprint done.",
    });
    EVENT_LOG.append("orchestrator", "deploy");
    log("deploy", "orchestrator", "version tagged");
    orchestratorHistory = history;
    pushFullState(history);
    return history;
  }

  // skip-deploy
  if (msg === "skip-deploy" && SPRINT_PLAN) {
    history.push({ role: "assistant", content: "\u23ED\uFE0F Deploy skipped. Sprint complete without deploy." });
    orchestratorHistory = history;
    pushFullState(history);
    return history;
  }

  // chat with <agent>
  if (msg.startsWith("chat with")) {
    const agentName = message.trim().slice("chat with".length).trim().toLowerCase();
    const agentMap = Object.fromEntries(Object.keys(AGENT_CONFIGS).map((k) => [k.toLowerCase(), k]));
    if (agentMap[agentName]) {
      history.push({
        role: "assistant",
        content: `\uD83D\uDD04 Switching to **${agentMap[agentName]}** direct chat.\n\n*Use the dropdown above to switch back to Orchestrator.*`,
      });
    } else {
      history.push({
        role: "assistant",
        content: `\u2753 Unknown agent '${agentName}'. Available: ${Object.keys(AGENT_CONFIGS).join(", ")}`,
      });
    }
    orchestratorHistory = history;
    pushFullState(history);
    return history;
  }

  // status
  if (msg === "status") {
    const active = [...SESSIONS.entries()]
      .filter(([, s]) => s.client)
      .map(([n, s]) => `- **${n}**: ${s.status} (last: ${s.lastTool})`);
    history.push({
      role: "assistant",
      content: `**Active agents:**\n${active.length > 0 ? active.join("\n") : "No active sessions."}`,
    });
    orchestratorHistory = history;
    pushFullState(history);
    return history;
  }

  // Default: route to Executor
  history.push({ role: "assistant", content: "\uD83C\uDFAF Routing to **Executor**..." });
  pushFullState(history);

  const executor = getOrCreateSession("executor", "Executor");
  try {
    history = await streamAgent(executor, message, history);
  } catch (e: any) {
    history.push({ role: "assistant", content: `\u274C Error: ${e.message}` });
  }
  orchestratorHistory = history;
  pushFullState(history);
  return history;
}

// ---------------------------------------------------------------------------
// Direct agent chat
// ---------------------------------------------------------------------------
async function directAgentChat(message: string, history: ChatMessage[], agentType: string): Promise<ChatMessage[]> {
  if (!message.trim()) {
    pushFullState(history);
    return history;
  }

  history = [...history, { role: "user", content: message }];
  pushFullState(history);

  const sessionName = agentType.toLowerCase();
  const session = getOrCreateSession(sessionName, agentType);

  const config = AGENT_CONFIGS[agentType];
  if (config && session.messageCount === 0) {
    history.push({
      role: "assistant",
      content: `\uD83D\uDCE1 **${config.icon} ${agentType}** session opened (model: ${config.model}, tools: ${config.tools.join(", ") || "none"})`,
    });
    pushFullState(history);
  }

  try {
    history = await streamAgent(session, message, history);
  } catch (e: any) {
    history.push({ role: "assistant", content: `\u274C Error: ${e.message}` });
    pushFullState(history);
  }

  session.chatHistory = history;
  return history;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function doInterrupt(mode: string): Promise<void> {
  if (mode === "orchestrator") {
    for (const s of SESSIONS.values()) {
      if (s.isStreaming && s.client) {
        try {
          await s.client.interrupt();
          s.status = "interrupted";
          s.isStreaming = false;
          log("interrupt", s.name);
        } catch {}
      }
    }
  } else {
    const name = mode.toLowerCase();
    const s = SESSIONS.get(name);
    if (s?.client && s.isStreaming) {
      try {
        await s.client.interrupt();
        s.status = "interrupted";
        s.isStreaming = false;
        log("interrupt", name);
      } catch {}
    }
  }
  broadcast({ type: "status", status: buildStatus() });
  broadcast({ type: "timeline", timeline: buildTimeline() });
}

async function doClose(mode: string): Promise<void> {
  if (mode !== "orchestrator") {
    const name = mode.toLowerCase();
    const s = SESSIONS.get(name);
    if (s?.client) {
      try {
        s.client.close?.();
      } catch {}
      s.client = null;
      s.status = "closed";
      s.isStreaming = false;
      log("close", name);
    }
  }
  pushFullState([]);
}

async function doReset(): Promise<void> {
  for (const s of SESSIONS.values()) {
    if (s.client) {
      try {
        s.client.close?.();
      } catch {}
      s.client = null;
    }
    s.status = "idle";
    s.isStreaming = false;
    s.chatHistory = [];
    s.lastTool = "-";
    s.messageCount = 0;
  }
  SESSIONS.clear();
  TIMELINE.length = 0;
  orchestratorHistory = [];
  SPRINT_PLAN = null;
  pushFullState([]);
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------
function buildStatus(): string {
  const lines = [
    "| | Agent | Status | Last Tool | Msgs |",
    "|---|-------|--------|-----------|------|",
    "| \uD83C\uDFAF | Orchestrator | active | - | - |",
  ];

  for (const [name, s] of SESSIONS) {
    const icon = AGENT_CONFIGS[s.agentType]?.icon ?? "\u2753";
    const dot = s.client ? "\uD83D\uDFE2" : "\u26AA";
    lines.push(`| ${icon} | ${name} | ${dot} ${s.status} | ${s.lastTool} | ${s.messageCount} |`);
  }

  const activeTypes = new Set([...SESSIONS.values()].map((s) => s.agentType));
  for (const [atype, cfg] of Object.entries(AGENT_CONFIGS)) {
    if (!activeTypes.has(atype)) {
      lines.push(`| ${cfg.icon} | ${atype} | \u26AA idle | - | 0 |`);
    }
  }

  return lines.join("\n");
}

function buildTimeline(): string {
  if (TIMELINE.length === 0) return "No events yet.";
  return TIMELINE.slice(-30)
    .map((ev) => {
      const detail = ev.detail ? ` \u2014 ${ev.detail}` : "";
      return `${ev.ts} ${ev.agent} ${ev.action}${detail}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// WebSocket message handler
// ---------------------------------------------------------------------------
async function handleWsMessage(_ws: any, raw: string): Promise<void> {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  switch (data.type) {
    case "chat": {
      const mode = data.mode ?? "orchestrator";
      const message = data.message ?? "";
      if (mode === "orchestrator") {
        orchestratorHistory = await orchestratorChat(message, orchestratorHistory);
      } else {
        const agentType = mode;
        const name = agentType.toLowerCase();
        const session = SESSIONS.get(name);
        const history = session?.chatHistory ?? [];
        const result = await directAgentChat(message, history, agentType);
        const s = SESSIONS.get(name);
        if (s) s.chatHistory = result;
      }
      break;
    }
    case "interrupt":
      await doInterrupt(data.mode ?? "orchestrator");
      break;
    case "close":
      await doClose(data.mode ?? "orchestrator");
      break;
    case "reset":
      await doReset();
      break;
    case "switch_mode": {
      const mode = data.mode ?? "orchestrator";
      if (mode === "orchestrator") {
        pushFullState(orchestratorHistory);
      } else {
        const name = mode.toLowerCase();
        const s = SESSIONS.get(name);
        pushFullState(s?.chatHistory ?? []);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.REINS_PORT ?? "7860", 10);

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const ok = server.upgrade(req);
      return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }
    return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      const json = JSON.stringify({
        type: "full",
        history: orchestratorHistory.map(({ role, content }) => ({ role, content })),
        status: buildStatus(),
        timeline: buildTimeline(),
        board: renderSprintBoard(SPRINT_PLAN),
      });
      ws.send(json);
    },
    message(ws, raw) {
      handleWsMessage(ws, String(raw));
    },
    close(ws) {
      clients.delete(ws);
    },
  },
});

console.log(`Reins orchestrator running at http://localhost:${server.port}`);
