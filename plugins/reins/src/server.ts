/**
 * Reins orchestrator — Bun HTTP + WebSocket server.
 *
 * Pipeline runner: starts subagents + state transitions.
 * CLI operations (gh/git/curl) are glue code between agent calls.
 * Only branch logic: PM returns pass/fail → if/else.
 */

import { AGENT_CONFIGS, getAgentOptions } from "./agents";
import { EventLog } from "./events";
import { GitHubOps } from "./github";
import { AgentSession, Phase, type ChatMessage } from "./state";
import { formatSdkMessage } from "./stream";
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
let currentPhase: Phase = Phase.IDLE;

// Pending plan from Planner+PM, awaiting user approval
interface PendingPlan {
  name: string;
  cards: { title: string; slug: string; wave: number; ac: string[]; dependsOn: number[] }[];
}
let PENDING_PLAN: PendingPlan | null = null;

const PROJECT_ROOT = process.env.REINS_PROJECT_ROOT || process.cwd();
const GH = new GitHubOps(PROJECT_ROOT);
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
    try { ws.send(json); } catch {}
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
// Claude CLI path (for compiled binary)
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
    cwd: PROJECT_ROOT,
    ...(CLAUDE_PATH ? { pathToClaudeCodeExecutable: CLAUDE_PATH } : {}),
  };
}

// ---------------------------------------------------------------------------
// SDK: 1-shot query
// ---------------------------------------------------------------------------
async function callOneshot(agentType: string, prompt: string): Promise<string> {
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const opts = getAgentOptions(agentType);
    const texts: string[] = [];
    for await (const msg of query({ prompt, options: sdkOptions(opts) })) {
      if (msg.type === "assistant") {
        for (const block of (msg as any).message?.content ?? []) {
          if (block.type === "text") texts.push(block.text);
        }
      }
    }
    return texts.join("\n");
  } catch (e: any) {
    return JSON.stringify({ decision: "fail", reason: e.message });
  }
}

// ---------------------------------------------------------------------------
// SDK: stream agent to UI via WebSocket
// ---------------------------------------------------------------------------
async function streamAgent(session: AgentSession, task: string, history: ChatMessage[]): Promise<ChatMessage[]> {
  session.isStreaming = true;
  session.status = "streaming";
  session.messageCount++;
  log("query", session.name, task.slice(0, 80));

  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const opts = getAgentOptions(session.agentType);
  const q = query({ prompt: task, options: sdkOptions(opts) });
  session.client = q;
  let currentContent = "";

  try {
    for await (const msg of q) {
      const formatted = formatSdkMessage(msg, session.name);
      if (!formatted) continue;
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
// Glue: parse plan JSON from agent output
// ---------------------------------------------------------------------------
function parsePlannerOutput(history: ChatMessage[]): PendingPlan | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.role !== "assistant") continue;
    const jsonMatch = entry.content.match(/```json\s*\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        if (data.name && Array.isArray(data.cards)) return data as PendingPlan;
      } catch { continue; }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Glue: collect PR comments (programmatic, no agent)
// ---------------------------------------------------------------------------
function collectPrComments(prNumber: number): string {
  const { stdout } = Bun.spawnSync(["gh", "pr", "view", String(prNumber), "--json", "comments"], { cwd: PROJECT_ROOT });
  return stdout.toString();
}

// ---------------------------------------------------------------------------
// Glue: health check (programmatic, no agent)
// ---------------------------------------------------------------------------
function checkAppHealth(): boolean {
  const r = Bun.spawnSync(["curl", "-sf", "http://localhost:8080/healthz"]);
  return r.exitCode === 0;
}

// ---------------------------------------------------------------------------
// Glue: compute next git tag
// ---------------------------------------------------------------------------
function computeNextTag(): { latest: string; next: string } {
  const result = Bun.spawnSync(["git", "tag", "--sort=-v:refname"], { cwd: PROJECT_ROOT });
  const tags = result.stdout.toString().trim().split("\n").filter(Boolean);
  const latest = tags[0] ?? "v0.0.0";
  const parts = latest.replace(/^v/, "").split(".");
  const nextPatch = parseInt(parts[2] ?? "0", 10) + 1;
  return { latest, next: `v${parts[0] ?? "0"}.${parts[1] ?? "0"}.${nextPatch}` };
}

// ---------------------------------------------------------------------------
// ReAct Loop: one card through execute → review → PM decide → fix
// ---------------------------------------------------------------------------
async function reactLoop(card: CardState, history: ChatMessage[]): Promise<ChatMessage[]> {
  // Phase 1: Executor
  card.status = "executing";
  const worktreePath = GH.createWorktree(cardBranch(card));
  log("worktree", "pipeline", `created ${worktreePath}`);

  const executor = getOrCreateSession(`executor-${card.slug}`, "Executor");
  history.push({ role: "assistant", content: `\u26A1 **executor-${card.slug}** implementing Card ${card.id}: ${card.title}...` });
  pushFullState(history);
  try {
    history = await streamAgent(executor, `Implement Card ${card.id}: ${card.title}. ACs: ${card.acceptanceCriteria.join(", ")}. Branch: ${cardBranch(card)}. Worktree: ${worktreePath}`, history);
  } catch (e: any) {
    history.push({ role: "assistant", content: `\u274C Executor error: ${e.message}` });
  }
  EVENT_LOG.append("executor", "done", { card: card.id });

  // Glue: create PR
  const prUrl = GH.createPr(cardBranch(card), `Card ${card.id}: ${card.title}`, card.acceptanceCriteria.join("\n- "));
  const prMatch = prUrl.match(/\/(\d+)$/);
  card.prNumber = prMatch ? parseInt(prMatch[1], 10) : null;
  if (card.prNumber) {
    history.push({ role: "assistant", content: `\uD83D\uDD17 PR #${card.prNumber} created` });
    pushFullState(history);
  }

  // Phase 2a: Codex Reviewer (parallel) + wait bot comments
  card.status = "reviewing";
  history.push({ role: "assistant", content: `\uD83D\uDD0D Reviewing Card ${card.id}... (Codex + bots + Reviewer)` });
  pushFullState(history);

  // Start Codex review (fire-and-forget, posts to PR)
  if (card.prNumber) {
    Bun.spawn(["codex", "review", "--model", "gpt-5.4", "--pr", String(card.prNumber)]);
    log("codex_review", "pipeline", `PR #${card.prNumber}`);
  }

  // Wait for bot comments (poll up to 5 min)
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline && card.prNumber) {
    const comments = collectPrComments(card.prNumber);
    if (comments.includes("codecov") || comments.includes("coderabbit")) break;
    await new Promise((r) => setTimeout(r, 15000));
  }

  // Phase 2b: Reviewer (Claude)
  const reviewer = getOrCreateSession(`reviewer-${card.slug}`, "Reviewer");
  try {
    history = await streamAgent(
      reviewer,
      card.prNumber
        ? `Review PR #${card.prNumber}. ACs: ${card.acceptanceCriteria.join(", ")}. Run gh pr diff ${card.prNumber} to read the diff. Read all bot comments with gh pr view ${card.prNumber} --json comments. Synthesize findings from your review + Codex + all bots. Post your findings as a PR comment.`
        : `Review Card ${card.id}: ${card.title}. ACs: ${card.acceptanceCriteria.join(", ")}.`,
      history,
    );
  } catch (e: any) {
    history.push({ role: "assistant", content: `\u274C Reviewer error: ${e.message}` });
  }
  EVENT_LOG.append("reviewer", "review", { card: card.id });

  // Phase 3: PM quality gate
  if (!card.prNumber) {
    card.status = "blocked";
    history.push({ role: "assistant", content: `\u274C Card ${card.id}: no PR created. Blocked.` });
    pushFullState(history);
    return history;
  }

  const rawComments = collectPrComments(card.prNumber);
  const pmResult = await callOneshot("PM", `You are the PR quality gate. Read these raw PR comments and decide pass or fail.\n\nPR #${card.prNumber} comments:\n${rawComments}`);

  let pmDecision: { decision: string; reason: string } = { decision: "fail", reason: "could not parse PM response" };
  try {
    const match = pmResult.match(/```json\s*\n([\s\S]*?)\n```/) || [null, pmResult];
    pmDecision = JSON.parse(match[1] ?? pmResult);
  } catch {}

  const pmIcon = pmDecision.decision === "pass" ? "\u2713" : "\u2717";
  history.push({
    role: "assistant",
    content: `${pmIcon} **PM** Card ${card.id}: \`${pmDecision.decision}\` \u2014 ${pmDecision.reason}`,
  });
  EVENT_LOG.append("pm", "gate", { card: card.id, decision: pmDecision.decision });

  if (pmDecision.decision === "pass") {
    // Glue: rebase + merge + cleanup
    GH.rebaseBranch(cardBranch(card));
    GH.mergePr(card.prNumber);
    GH.removeWorktree(cardBranch(card));
    card.status = "merged";
    log("merge", "pipeline", `card ${card.id} PR #${card.prNumber}`);
  } else if (card.reviewRound < 3) {
    // Fail: send raw comments to Executor, loop
    card.reviewRound++;
    history.push({
      role: "assistant",
      content: `\u{1F504} Re-executing Card ${card.id} (round ${card.reviewRound}/3)...`,
    });
    pushFullState(history);

    const reExecutor = getOrCreateSession(`executor-${card.slug}`, "Executor");
    try {
      history = await streamAgent(
        reExecutor,
        `Card ${card.id} PR #${card.prNumber} needs fixes. Read the PR comments with: gh pr view ${card.prNumber} --json comments\nFix all issues and push to the same branch.`,
        history,
      );
    } catch (e: any) {
      history.push({ role: "assistant", content: `\u274C Re-executor error: ${e.message}` });
    }

    // Recurse through review cycle
    history = await reactLoop(card, history);
  } else {
    card.status = "blocked";
    history.push({
      role: "assistant",
      content: `\u274C Card ${card.id} blocked after 3 rounds. \`resolve ${card.id}\` or \`skip ${card.id}\``,
    });
  }

  pushFullState(history);
  return history;
}

// ---------------------------------------------------------------------------
// Orchestrator: state-driven message handling
// ---------------------------------------------------------------------------
async function orchestratorChat(message: string, history: ChatMessage[]): Promise<ChatMessage[]> {
  if (!message.trim()) {
    pushFullState(history);
    return history;
  }

  history = [...history, { role: "user", content: message }];
  const msg = message.trim().toLowerCase();

  // --- Global commands (any state) ---
  if (msg === "status") {
    const active = [...SESSIONS.entries()]
      .filter(([, s]) => s.client)
      .map(([n, s]) => `- **${n}**: ${s.status} (last: ${s.lastTool})`);
    history.push({ role: "assistant", content: `**Phase:** ${currentPhase}\n**Active agents:**\n${active.length > 0 ? active.join("\n") : "None"}` });
    orchestratorHistory = history;
    pushFullState(history);
    return history;
  }

  if (msg.startsWith("resolve ") && SPRINT_PLAN) {
    const cardId = parseInt(msg.split(" ")[1], 10);
    const card = SPRINT_PLAN.cards.find((c) => c.id === cardId);
    if (card && card.status === "blocked") {
      card.status = "merged";
      history.push({ role: "assistant", content: `\u2705 Card ${cardId} resolved.` });
    } else {
      history.push({ role: "assistant", content: `\u26A0\uFE0F Card ${cardId} not found or not blocked.` });
    }
    orchestratorHistory = history;
    pushFullState(history);
    return history;
  }

  if (msg.startsWith("skip ") && SPRINT_PLAN) {
    const cardId = parseInt(msg.split(" ")[1], 10);
    const card = SPRINT_PLAN.cards.find((c) => c.id === cardId);
    if (card) {
      card.status = "skipped";
      history.push({ role: "assistant", content: `\u23ED\uFE0F Card ${cardId} skipped.` });
    }
    orchestratorHistory = history;
    pushFullState(history);
    return history;
  }

  // --- State-specific handling ---
  switch (currentPhase) {
    case Phase.IDLE: {
      // Any message in IDLE = start planning
      currentPhase = Phase.ELABORATING;
      log("plan_start", "pipeline", message.slice(0, 80));
      history.push({ role: "assistant", content: "\uD83D\uDCCB Starting planning..." });
      pushFullState(history);

      // Start Planner
      const planner = getOrCreateSession("planner", "Planner");
      try {
        history = await streamAgent(
          planner,
          `The user wants: "${message}"\n\nExplore the codebase, clarify requirements, and produce a spec with task breakdown and ACs. At the end, output a JSON block with: {"name": "iter-name", "cards": [{"title": "...", "slug": "...", "wave": 1, "dependsOn": [], "ac": ["..."]}]}`,
          history,
        );
      } catch (e: any) {
        history.push({ role: "assistant", content: `\u274C Planner error: ${e.message}` });
      }

      // Parse spec and run PM to arrange iteration
      const parsed = parsePlannerOutput(history);
      if (parsed) {
        PENDING_PLAN = parsed;
        currentPhase = Phase.AWAITING_APPROVAL;

        const cardTable = parsed.cards
          .map((c, i) => `| ${i + 1} | ${c.title} | ${c.wave} | \`card-${i + 1}-${c.slug}\` |`)
          .join("\n");
        history.push({
          role: "assistant",
          content:
            `---\n\n**Sprint: ${parsed.name}** (${parsed.cards.length} cards)\n\n` +
            `| # | Title | Wave | Branch |\n|---|-------|------|--------|\n${cardTable}\n\n` +
            `---\n\n**Approve?** \`approve\` / or give feedback to revise`,
        });
      } else {
        currentPhase = Phase.IDLE;
        history.push({
          role: "assistant",
          content: `\u26A0\uFE0F Could not parse plan from Planner output. Describe what you need and I'll try again.`,
        });
      }
      break;
    }

    case Phase.ELABORATING: {
      // Forward message to Planner as follow-up
      const planner = getOrCreateSession("planner", "Planner");
      try {
        history = await streamAgent(planner, message, history);
      } catch (e: any) {
        history.push({ role: "assistant", content: `\u274C Planner error: ${e.message}` });
      }

      const parsed = parsePlannerOutput(history);
      if (parsed) {
        PENDING_PLAN = parsed;
        currentPhase = Phase.AWAITING_APPROVAL;
        history.push({ role: "assistant", content: `---\n\n**Approve?** \`approve\` / or give feedback` });
      }
      break;
    }

    case Phase.AWAITING_APPROVAL: {
      const positive = ["approve", "approved", "lgtm", "ok", "yes", "confirm",
        "\u597D\u7684", "\u53EF\u4EE5", "\u786E\u8BA4", "\u5F00\u59CB\u5427", "\u6CA1\u95EE\u9898"].includes(msg);

      if (positive && PENDING_PLAN) {
        // Create sprint from plan
        currentPhase = Phase.EXECUTING;
        EVENT_LOG.append("orchestrator", "sprint_start");
        log("sprint_start", "pipeline", PENDING_PLAN.name);

        SPRINT_PLAN = {
          name: PENDING_PLAN.name,
          cards: PENDING_PLAN.cards.map((c, i) => createCard(i + 1, c.title, c.slug, c.wave, c.ac, c.dependsOn ?? [])),
        };
        PENDING_PLAN = null;

        // Execute waves
        for (const waveNum of allWaves(SPRINT_PLAN)) {
          const waveCards = getWave(SPRINT_PLAN, waveNum);
          log("wave_start", "pipeline", `wave ${waveNum}`);
          EVENT_LOG.append("orchestrator", "wave_start", { wave: waveNum });

          const cardNames = waveCards.map((c) => `Card ${c.id}: ${c.title}`).join(", ");
          history.push({ role: "assistant", content: `\u26A1 **Wave ${waveNum}** \u2014 ${waveCards.length} cards: ${cardNames}` });
          pushFullState(history);

          // ReAct Loop per card (parallel execute, sequential merge)
          // Cards in the same wave execute in parallel, but merge sequentially
          const cardPromises = waveCards.map((card) => reactLoop(card, [...history]));
          const cardHistories = await Promise.all(cardPromises);
          // Merge all card histories into main history
          for (const cardHistory of cardHistories) {
            const newEntries = cardHistory.filter((h) => !history.includes(h));
            history.push(...newEntries);
          }
          pushFullState(history);

          // After wave merge: Tester
          const merged = waveCards.filter((c) => c.status === "merged");
          if (merged.length > 0) {
            // Glue: start app + health check
            history.push({ role: "assistant", content: `\uD83D\uDE80 Starting app for Wave ${waveNum} testing...` });
            pushFullState(history);
            Bun.spawnSync(["make", "serve"]);
            await new Promise((r) => setTimeout(r, 5000));

            const healthy = checkAppHealth();
            if (!healthy) {
              history.push({ role: "assistant", content: `\u26A0\uFE0F App health check failed. Skipping Tester for Wave ${waveNum}.` });
              pushFullState(history);
            } else {
              // Start Tester
              const tester = getOrCreateSession(`tester-wave${waveNum}`, "Tester");
              const acAll = merged.flatMap((c) => c.acceptanceCriteria.map((ac) => `Card ${c.id} (${c.title}): ${ac}`));
              try {
                history = await streamAgent(
                  tester,
                  `Test the running app. Verify these ACs from Wave ${waveNum}:\n${acAll.map((ac) => `- ${ac}`).join("\n")}\n\nFor each passing AC, write or augment automated tests.`,
                  history,
                );
              } catch (e: any) {
                history.push({ role: "assistant", content: `\u274C Tester error: ${e.message}` });
              }

              // PM reviews Tester findings
              const testerOutput = history.filter((h) => h.content.includes(`tester-wave${waveNum}`)).pop()?.content ?? "";
              const pmTesterResult = await callOneshot("PM", `Review these Tester findings and decide pass or fail:\n\n${testerOutput}`);
              history.push({ role: "assistant", content: `\uD83D\uDCCA PM reviewed Tester findings: ${pmTesterResult.slice(0, 200)}` });

              EVENT_LOG.append("tester", "test", { wave: waveNum });
              log("test", `tester-wave${waveNum}`, `wave ${waveNum}`);
            }

            history.push({
              role: "assistant",
              content: `\u2705 **Wave ${waveNum} complete.** ${merged.length} cards merged.`,
            });
            pushFullState(history);
          }
        }

        // Sprint complete
        currentPhase = Phase.AWAITING_DEPLOY;
        history.push({
          role: "assistant",
          content:
            "## \uD83C\uDF89 Sprint Complete\n\n" +
            renderSprintBoard(SPRINT_PLAN) +
            "\n\n*All waves executed, reviewed, and tested.*\n\n" +
            "`deploy` \u2014 bump version + tag + push\n" +
            "`skip-deploy` \u2014 done without deploy",
        });
        EVENT_LOG.append("orchestrator", "sprint_complete");
      } else if (msg === "cancel") {
        PENDING_PLAN = null;
        currentPhase = Phase.IDLE;
        history.push({ role: "assistant", content: "Cancelled. Describe new work when ready." });
      } else {
        // Treat as revision feedback → back to Planner
        currentPhase = Phase.ELABORATING;
        const planner = getOrCreateSession("planner", "Planner");
        try {
          history = await streamAgent(planner, `Revise the plan based on this feedback: ${message}`, history);
        } catch (e: any) {
          history.push({ role: "assistant", content: `\u274C Planner error: ${e.message}` });
        }
        const parsed = parsePlannerOutput(history);
        if (parsed) {
          PENDING_PLAN = parsed;
          currentPhase = Phase.AWAITING_APPROVAL;
        }
        history.push({ role: "assistant", content: `---\n\n**Approve?** \`approve\` / or give more feedback` });
      }
      break;
    }

    case Phase.EXECUTING: {
      // During execution, user can only resolve/skip blocked cards
      history.push({
        role: "assistant",
        content: `Sprint is running. Available: \`resolve <id>\` / \`skip <id>\` / \`status\``,
      });
      break;
    }

    case Phase.AWAITING_DEPLOY: {
      if (msg === "deploy" || msg === "\u90E8\u7F72" || msg === "\u53D1\u5E03") {
        const { latest, next } = computeNextTag();
        history.push({
          role: "assistant",
          content: `\uD83D\uDE80 **Deploy preview:** \`${latest}\` \u2192 \`${next}\`\n\n\`confirm-deploy\` / \`skip-deploy\``,
        });
        currentPhase = Phase.DEPLOY_VERIFY;
      } else if (msg === "skip-deploy") {
        currentPhase = Phase.COMPLETE;
        history.push({ role: "assistant", content: "\u23ED\uFE0F Deploy skipped. Sprint complete." });
      }
      break;
    }

    case Phase.DEPLOY_VERIFY: {
      if (msg === "confirm-deploy" || msg === "confirm" || msg === "\u786E\u8BA4") {
        const { next } = computeNextTag();
        // Glue: bump version in package files
        const bumpResult = Bun.spawnSync(["node", "-e", `
          const fs = require('fs');
          for (const f of ['plugins/reins/package.json', 'plugins/reins/.claude-plugin/plugin.json']) {
            try { const j = JSON.parse(fs.readFileSync(f)); j.version = '${next.replace("v", "")}'; fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\\n'); } catch {}
          }
        `]);

        const tagResult = Bun.spawnSync(["git", "tag", next]);
        if (tagResult.exitCode !== 0) {
          history.push({ role: "assistant", content: `\u274C Tag failed: ${tagResult.stderr.toString().trim()}` });
          break;
        }
        const pushResult = Bun.spawnSync(["git", "push", "origin", next]);
        if (pushResult.exitCode !== 0) {
          history.push({ role: "assistant", content: `\u274C Push failed: ${pushResult.stderr.toString().trim()}` });
          break;
        }

        // Deploy verification: wait for CI + health check
        history.push({ role: "assistant", content: `\u2705 Tagged \`${next}\`. Waiting for CI...` });
        pushFullState(history);
        await new Promise((r) => setTimeout(r, 30000));

        const deployHealthy = checkAppHealth();
        if (deployHealthy) {
          currentPhase = Phase.COMPLETE;
          history.push({ role: "assistant", content: `\u2705 **Deployed \`${next}\` successfully.** Sprint complete.` });
          EVENT_LOG.append("orchestrator", "deploy", { tag: next });
        } else {
          history.push({
            role: "assistant",
            content: `\u26A0\uFE0F Deploy verification failed. Creating hotfix card...`,
          });
          // TODO: create hotfix card and re-enter EXECUTING
          currentPhase = Phase.AWAITING_DEPLOY;
        }
      } else if (msg === "cancel" || msg === "\u53D6\u6D88") {
        currentPhase = Phase.AWAITING_DEPLOY;
        history.push({ role: "assistant", content: "Deploy cancelled. `deploy` to try again." });
      }
      break;
    }

    case Phase.COMPLETE: {
      // New message after completion → start new sprint
      currentPhase = Phase.IDLE;
      SPRINT_PLAN = null;
      return orchestratorChat(message, history);
    }
  }

  orchestratorHistory = history;
  pushFullState(history);
  return history;
}

// ---------------------------------------------------------------------------
// Direct agent chat
// ---------------------------------------------------------------------------
async function directAgentChat(message: string, history: ChatMessage[], agentType: string): Promise<ChatMessage[]> {
  if (!message.trim()) { pushFullState(history); return history; }
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
        try { await s.client.interrupt(); s.status = "interrupted"; s.isStreaming = false; log("interrupt", s.name); } catch {}
      }
    }
  } else {
    const s = SESSIONS.get(mode.toLowerCase());
    if (s?.client && s.isStreaming) {
      try { await s.client.interrupt(); s.status = "interrupted"; s.isStreaming = false; log("interrupt", s.name); } catch {}
    }
  }
  broadcast({ type: "status", status: buildStatus() });
  broadcast({ type: "timeline", timeline: buildTimeline() });
}

async function doReset(): Promise<void> {
  for (const s of SESSIONS.values()) {
    if (s.client) { try { s.client.close?.(); } catch {} s.client = null; }
    s.status = "idle"; s.isStreaming = false; s.chatHistory = []; s.lastTool = "-"; s.messageCount = 0;
  }
  SESSIONS.clear(); TIMELINE.length = 0; orchestratorHistory = [];
  SPRINT_PLAN = null; PENDING_PLAN = null; currentPhase = Phase.IDLE;
  pushFullState([]);
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------
function buildStatus(): string {
  const lines = [
    `| | Agent | Status | Last Tool | Msgs | Phase: ${currentPhase} |`,
    "|---|-------|--------|-----------|------|------|",
  ];
  for (const [name, s] of SESSIONS) {
    const icon = AGENT_CONFIGS[s.agentType]?.icon ?? "\u2753";
    const dot = s.client ? "\uD83D\uDFE2" : "\u26AA";
    lines.push(`| ${icon} | ${name} | ${dot} ${s.status} | ${s.lastTool} | ${s.messageCount} |`);
  }
  return lines.join("\n");
}

function buildTimeline(): string {
  if (TIMELINE.length === 0) return "No events yet.";
  return TIMELINE.slice(-30)
    .map((ev) => `${ev.ts} ${ev.agent} ${ev.action}${ev.detail ? ` \u2014 ${ev.detail}` : ""}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// WebSocket handler
// ---------------------------------------------------------------------------
async function handleWsMessage(_ws: any, raw: string): Promise<void> {
  let data: any;
  try { data = JSON.parse(raw); } catch { return; }

  switch (data.type) {
    case "chat": {
      const mode = data.mode ?? "orchestrator";
      const message = data.message ?? "";
      if (mode === "orchestrator") {
        orchestratorHistory = await orchestratorChat(message, orchestratorHistory);
      } else {
        const name = mode.toLowerCase();
        const session = SESSIONS.get(name);
        const result = await directAgentChat(message, session?.chatHistory ?? [], mode);
        const s = SESSIONS.get(name);
        if (s) s.chatHistory = result;
      }
      break;
    }
    case "interrupt": await doInterrupt(data.mode ?? "orchestrator"); break;
    case "reset": await doReset(); break;
    case "switch_mode": {
      const mode = data.mode ?? "orchestrator";
      pushFullState(mode === "orchestrator" ? orchestratorHistory : (SESSIONS.get(mode.toLowerCase())?.chatHistory ?? []));
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
      ws.send(JSON.stringify({
        type: "full",
        history: orchestratorHistory.map(({ role, content }) => ({ role, content })),
        status: buildStatus(),
        timeline: buildTimeline(),
        board: renderSprintBoard(SPRINT_PLAN),
      }));
    },
    message(ws, raw) { handleWsMessage(ws, String(raw)); },
    close(ws) { clients.delete(ws); },
  },
});

console.log(`Reins orchestrator running at http://localhost:${server.port}`);
