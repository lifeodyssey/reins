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
// Find system Claude CLI (compiled binary can't use node_modules native)
// ---------------------------------------------------------------------------
function findClaudePath(): string | undefined {
  const result = Bun.spawnSync(["which", "claude"]);
  const path = result.stdout.toString().trim();
  return path || undefined;
}

const CLAUDE_PATH = findClaudePath();

function sdkOptions(opts: ReturnType<typeof getAgentOptions>) {
  return {
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    allowedTools: opts.allowedTools,
    ...(CLAUDE_PATH ? { pathToClaudeCodeExecutable: CLAUDE_PATH } : {}),
  };
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
    options: sdkOptions(opts),
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
    options: sdkOptions(opts),
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
// Plan helpers
// ---------------------------------------------------------------------------
interface PendingPlan {
  name: string;
  cards: { title: string; slug: string; wave: number; ac: string[] }[];
}

let PENDING_PLAN: PendingPlan | null = null;

function parseIssueNumbers(message: string): number[] {
  const match = message.match(/--issues\s+([\d,\s]+)/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
}

function fetchIssueDetails(issueNumbers: number[]): { number: number; title: string; body: string; labels: string[] }[] {
  const issues: { number: number; title: string; body: string; labels: string[] }[] = [];
  for (const num of issueNumbers) {
    const result = Bun.spawnSync(["gh", "issue", "view", String(num), "--json", "number,title,body,labels"]);
    if (result.exitCode === 0) {
      try {
        const data = JSON.parse(result.stdout.toString().trim());
        issues.push({
          number: data.number,
          title: data.title,
          body: data.body ?? "",
          labels: (data.labels ?? []).map((l: any) => l.name),
        });
      } catch {}
    }
  }
  return issues;
}

function parsePlannerOutput(history: ChatMessage[]): PendingPlan | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.role === "assistant" && entry.content.includes("planner")) {
      const jsonMatch = entry.content.match(/```json\s*\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[1]);
          if (data.name && Array.isArray(data.cards)) return data as PendingPlan;
        } catch {
          continue;
        }
      }
    }
  }
  return null;
}

function computeNextTag(): { latest: string; next: string } {
  const result = Bun.spawnSync(["git", "tag", "--sort=-v:refname"]);
  const tags = result.stdout.toString().trim().split("\n").filter(Boolean);
  const latest = tags[0] ?? "v0.0.0";
  const parts = latest.replace(/^v/, "").split(".");
  const nextPatch = parseInt(parts[2] ?? "0", 10) + 1;
  return { latest, next: `v${parts[0] ?? "0"}.${parts[1] ?? "0"}.${nextPatch}` };
}

// ---------------------------------------------------------------------------
// Verify + Route loop (re-entrant, bounded by reviewRound)
// ---------------------------------------------------------------------------
async function verifyAndRoute(card: CardState, history: ChatMessage[]): Promise<ChatMessage[]> {
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
  } catch (e: any) {
    vResult = { approved: false, acResults: [], issues: [`Verifier error: ${e.message}`] };
    history.push({ role: "assistant", content: `\u274C **Verifier error for Card ${card.id}:** ${e.message}` });
    pushFullState(history);
  }

  const routerPrompt = buildRouterPrompt(
    card.title,
    vResult.approved ? "approve" : "request_changes",
    card.reviewRound + 1,
    JSON.stringify(vResult),
  );
  let rResult: { decision: string; reason: string };
  try {
    const rRaw = await callOneshot("Router", routerPrompt);
    rResult = parseRouterResponse(rRaw);
  } catch (e: any) {
    rResult = { decision: "escalate_to_human", reason: `Router error: ${e.message}` };
    history.push({ role: "assistant", content: `\u274C **Router error for Card ${card.id}:** ${e.message}` });
    pushFullState(history);
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

  switch (rResult.decision) {
    case "merge":
      card.status = "merged";
      break;
    case "skip":
      card.status = "skipped";
      break;
    case "escalate_to_human":
      card.status = "blocked";
      history.push({
        role: "assistant",
        content: `**Card ${card.id} escalated.** ${rResult.reason}\n\n\`resolve ${card.id}\` to unblock, \`skip ${card.id}\` to skip.`,
      });
      break;
    case "re_execute":
    case "re_execute_with_findings": {
      card.reviewRound++;
      if (card.reviewRound >= 3) {
        card.status = "blocked";
        history.push({
          role: "assistant",
          content: `**Card ${card.id} blocked** after ${card.reviewRound} attempts. Escalating.\n\n\`resolve ${card.id}\` or \`skip ${card.id}\``,
        });
      } else {
        card.status = "executing";
        history.push({
          role: "assistant",
          content: `\u{1F504} **Re-executing Card ${card.id}** (attempt ${card.reviewRound + 1}). Reason: ${rResult.reason}`,
        });
        pushFullState(history);
        const reExec = getOrCreateSession(`executor-${card.slug}`, "Executor");
        try {
          history = await streamAgent(
            reExec,
            `Re-implement Card ${card.id}: ${card.title}. Previous issues: ${rResult.reason}. ` +
              `ACs: ${card.acceptanceCriteria.join(", ")}. Branch: ${cardBranch(card)}`,
            history,
          );
        } catch (e: any) {
          history.push({ role: "assistant", content: `\u274C Re-executor error: ${e.message}` });
        }
        // Recurse through verify+route again
        history = await verifyAndRoute(card, history);
      }
      break;
    }
    case "proceed_to_review": {
      card.status = "reviewing";
      const reReviewer = getOrCreateSession(`reviewer-${card.slug}`, "Reviewer");
      history = await streamAgent(
        reReviewer,
        `Re-review Card ${card.id}: ${card.title}. ACs: ${card.acceptanceCriteria.join(", ")}.`,
        history,
      );
      history = await verifyAndRoute(card, history);
      break;
    }
    case "proceed_to_test":
      card.status = "merged"; // test phase picks up "merged" cards
      break;
    default:
      card.status = "blocked";
      history.push({
        role: "assistant",
        content: `**Card ${card.id}: unknown decision** \`${rResult.decision}\`. Escalating.\n\n\`resolve ${card.id}\` or \`skip ${card.id}\``,
      });
      break;
  }

  pushFullState(history);
  return history;
}

// ---------------------------------------------------------------------------
// Orchestrator logic
// ---------------------------------------------------------------------------
async function orchestratorChat(message: string, history: ChatMessage[]): Promise<ChatMessage[]> {
  if (!message.trim()) {
    pushFullState(history);
    return history;
  }

  history = [...history, { role: "user", content: message }];
  const msg = message.trim().toLowerCase();

  // /plan command — fetch issues, run Planner, parse output
  if (msg.includes("/plan")) {
    const issueNums = parseIssueNumbers(message);
    log("plan_start", "orchestrator", issueNums.length > 0 ? `issues: ${issueNums.join(",")}` : "explore");
    history.push({ role: "assistant", content: "\uD83D\uDCCB Opening **Planner** session..." });
    pushFullState(history);

    let plannerPrompt: string;
    if (issueNums.length > 0) {
      const issues = fetchIssueDetails(issueNums);
      if (issues.length === 0) {
        history.push({ role: "assistant", content: `\u274C Could not fetch any issues. Check \`gh auth status\` and issue numbers.` });
        orchestratorHistory = history;
        pushFullState(history);
        return history;
      }
      const issueContext = issues
        .map((i) => `### Issue #${i.number}: ${i.title}\n${i.body}\nLabels: ${i.labels.join(", ") || "none"}`)
        .join("\n\n");
      plannerPrompt =
        `You have the following GitHub issues to plan:\n\n${issueContext}\n\n` +
        `Explore the codebase to understand the current architecture, then produce a sprint spec.\n\n` +
        `Include a Task Breakdown where each task has a title, slug, wave number, and acceptance criteria.\n` +
        `Tasks that can run in parallel share a wave. Dependent tasks go in later waves.\n\n` +
        `IMPORTANT: At the end, output a JSON block fenced with \`\`\`json containing:\n` +
        `{"name": "iter-name", "cards": [{"title": "...", "slug": "...", "wave": 1, "ac": ["criterion 1", "criterion 2"]}]}`;
    } else {
      plannerPrompt =
        `Explore the codebase and propose work for the next iteration.\n\n` +
        `Produce a sprint spec with a Task Breakdown. Each task needs a title, slug, wave number, and acceptance criteria.\n\n` +
        `IMPORTANT: At the end, output a JSON block fenced with \`\`\`json containing:\n` +
        `{"name": "iter-name", "cards": [{"title": "...", "slug": "...", "wave": 1, "ac": ["criterion 1", "criterion 2"]}]}`;
    }

    const planner = getOrCreateSession("planner", "Planner");
    try {
      history = await streamAgent(planner, plannerPrompt, history);
    } catch (e: any) {
      history.push({ role: "assistant", content: `\u274C Planner error: ${e.message}` });
    }

    const parsed = parsePlannerOutput(history);
    if (parsed) {
      PENDING_PLAN = parsed;
      const cardTable = parsed.cards
        .map((c, i) => `| ${i + 1} | ${c.title} | ${c.wave} | \`card-${i + 1}-${c.slug}\` |`)
        .join("\n");
      history.push({
        role: "assistant",
        content:
          `---\n\n**Sprint: ${parsed.name}** (${parsed.cards.length} cards)\n\n` +
          `| # | Title | Wave | Branch |\n|---|-------|------|--------|\n${cardTable}\n\n` +
          `---\n\n**Approve?** \`approve\` / \`revise: <feedback>\``,
      });
    } else {
      history.push({
        role: "assistant",
        content: `---\n\n\u26A0\uFE0F Could not parse structured plan from Planner output.\nReview the spec above and try \`/plan\` again, or manually create a plan.`,
      });
    }
    orchestratorHistory = history;
    pushFullState(history);
    return history;
  }

  // revise: <feedback> — re-invoke Planner
  if (msg.startsWith("revise:") || msg.startsWith("revise ")) {
    const feedback = message.trim().slice(message.indexOf(":") + 1 || message.indexOf(" ") + 1).trim();
    const planner = getOrCreateSession("planner", "Planner");
    try {
      history = await streamAgent(planner, `Revise the plan based on this feedback: ${feedback}`, history);
    } catch (e: any) {
      history.push({ role: "assistant", content: `\u274C Planner error: ${e.message}` });
    }
    const parsed = parsePlannerOutput(history);
    if (parsed) PENDING_PLAN = parsed;
    history.push({ role: "assistant", content: `---\n\n**Approve?** \`approve\` / \`revise: <feedback>\`` });
    orchestratorHistory = history;
    pushFullState(history);
    return history;
  }

  // approve — create sprint from PENDING_PLAN
  if (msg === "approve") {
    if (!PENDING_PLAN) {
      history.push({ role: "assistant", content: "\u26A0\uFE0F No plan to approve. Run \`/plan\` first." });
      orchestratorHistory = history;
      pushFullState(history);
      return history;
    }

    EVENT_LOG.append("orchestrator", "sprint_start");
    log("sprint_start", "orchestrator", `approve \u2192 ${PENDING_PLAN.name}`);

    SPRINT_PLAN = {
      name: PENDING_PLAN.name,
      cards: PENDING_PLAN.cards.map((c, i) => createCard(i + 1, c.title, c.slug, c.wave, c.ac)),
    };
    PENDING_PLAN = null;

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

      // Phase 3: Verify + Route (with re-execution support)
      for (const card of waveCards) {
        history = await verifyAndRoute(card, history);
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
        "`deploy` \u2014 preview tag + confirm\n" +
        "`skip-deploy` \u2014 done, don't deploy yet",
    });
    EVENT_LOG.append("orchestrator", "sprint_complete");
    orchestratorHistory = history;
    pushFullState(history);
    return history;
  }

  // deploy — preview what will happen
  if (msg === "deploy" && SPRINT_PLAN) {
    const { latest, next } = computeNextTag();
    history.push({
      role: "assistant",
      content:
        `\uD83D\uDE80 **Deploy preview:**\n` +
        `- Latest tag: \`${latest}\`\n` +
        `- Next tag: \`${next}\`\n` +
        `- Will run: \`git tag ${next} && git push origin ${next}\`\n\n` +
        `**Confirm?** \`confirm-deploy\` / \`skip-deploy\``,
    });
    orchestratorHistory = history;
    pushFullState(history);
    return history;
  }

  // confirm-deploy — actually tag and push
  if (msg === "confirm-deploy" && SPRINT_PLAN) {
    const { next } = computeNextTag();
    const tagResult = Bun.spawnSync(["git", "tag", next]);
    if (tagResult.exitCode !== 0) {
      history.push({ role: "assistant", content: `\u274C Could not create tag \`${next}\`: ${tagResult.stderr.toString().trim()}` });
      orchestratorHistory = history;
      pushFullState(history);
      return history;
    }
    const pushResult = Bun.spawnSync(["git", "push", "origin", next]);
    if (pushResult.exitCode !== 0) {
      history.push({ role: "assistant", content: `\u274C Could not push tag \`${next}\`: ${pushResult.stderr.toString().trim()}` });
      orchestratorHistory = history;
      pushFullState(history);
      return history;
    }
    history.push({ role: "assistant", content: `\u2705 **Deployed \`${next}\`.** CI triggered. Sprint done.` });
    EVENT_LOG.append("orchestrator", "deploy", { tag: next });
    log("deploy", "orchestrator", `tagged ${next}`);
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

  // resolve <cardId> — unblock escalated card
  if (msg.startsWith("resolve ") && SPRINT_PLAN) {
    const cardId = parseInt(msg.split(" ")[1], 10);
    const card = SPRINT_PLAN.cards.find((c) => c.id === cardId);
    if (card && card.status === "blocked") {
      card.status = "merged";
      history.push({ role: "assistant", content: `\u2705 Card ${cardId} resolved \u2192 merged.` });
    } else {
      history.push({ role: "assistant", content: `\u26A0\uFE0F Card ${cardId} not found or not blocked.` });
    }
    orchestratorHistory = history;
    pushFullState(history);
    return history;
  }

  // skip <cardId> — skip blocked card
  if (msg.startsWith("skip ") && SPRINT_PLAN) {
    const cardId = parseInt(msg.split(" ")[1], 10);
    const card = SPRINT_PLAN.cards.find((c) => c.id === cardId);
    if (card) {
      card.status = "skipped";
      history.push({ role: "assistant", content: `\u23ED\uFE0F Card ${cardId} skipped.` });
    } else {
      history.push({ role: "assistant", content: `\u26A0\uFE0F Card ${cardId} not found.` });
    }
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
