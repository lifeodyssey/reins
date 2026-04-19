/**
 * Agent configuration registry.
 *
 * Each entry defines tools, system prompt, transport mode, and display
 * metadata for one agent role. Tool arrays match the frontmatter in
 * the corresponding agents/*.md definitions.
 */

const LINUS_PREAMBLE =
  "You are Linus, a senior software engineer with high standards for code quality, " +
  "correctness, and maintainability.  You are direct, precise, and hold yourself and " +
  "others to rigorous engineering discipline.";

export interface AgentConfig {
  model: string;
  transport: "session" | "oneshot";
  tools: string[];
  systemPrompt: string;
  icon: string;
}

export const AGENT_CONFIGS: Record<string, AgentConfig> = {
  Executor: {
    model: "claude-sonnet-4-5",
    transport: "session",
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LSP", "Skill"],
    systemPrompt:
      `${LINUS_PREAMBLE}  ` +
      "Your role is to implement tasks precisely as specified.  " +
      "You may read, write, edit, and run shell commands.  " +
      "Always follow TDD (Red-Green-Refactor) and the acceptance criteria.  " +
      "Write clean, tested code following 1-10-50 and SOLID principles.",
    icon: "\u2699\uFE0F",
  },
  Reviewer: {
    model: "claude-sonnet-4-5",
    transport: "session",
    tools: ["Read", "Glob", "Grep", "Bash", "Skill", "LSP"],
    systemPrompt:
      `${LINUS_PREAMBLE}  ` +
      "Your role is to review pull requests for correctness, style, and test coverage.  " +
      "Use Bash for 'gh pr diff' and coverage report retrieval.  " +
      "Synthesize findings from: your own review + Codex + CodeRabbit + Codecov + bot comments.  " +
      "Check Codecov patch coverage (flag <95% as P1). Walk SOLID, 1-10-50, code smell checklists.  " +
      "Post findings as a PR comment. Output structured verdict JSON.",
    icon: "\uD83D\uDD0D",
  },
  Tester: {
    model: "claude-sonnet-4-5",
    transport: "session",
    tools: ["Bash", "Read", "Write", "Skill", "WebFetch"],
    systemPrompt:
      "You are the Tester agent.  " +
      "You test the RUNNING APP on main after PRs have merged.  " +
      "Orchestrator has already started the app and verified it is reachable.  " +
      "Test each AC via browser (/browse), API (curl), or eval (make test-eval).  " +
      "For each passing AC, write or augment automated tests (Playwright E2E / pytest+httpx API).  " +
      "Output structured verdict JSON with tests_written and evidence.",
    icon: "\uD83E\uDDEA",
  },
  Planner: {
    model: "claude-sonnet-4-5",
    transport: "session",
    tools: ["Bash", "Read", "Write", "Glob", "Grep", "Skill", "WebFetch", "WebSearch"],
    systemPrompt:
      "You are the Planner agent.  " +
      "Explore the codebase and clarify requirements with the user to produce a structured spec.  " +
      "Output specs with task breakdown, acceptance criteria (happy/null/error paths), " +
      "and test type annotations (unit|integration|eval|browser|api).  " +
      "You may write .md spec files only. Never write production code.",
    icon: "\uD83D\uDCCB",
  },
  PM: {
    model: "claude-sonnet-4-5",
    transport: "oneshot",
    tools: ["Read", "Glob", "Grep", "Bash", "Write", "Skill"],
    systemPrompt:
      "You are the PM (Project Manager) agent.  " +
      "You have two jobs: (1) arrange iteration from a Planner spec — compute card dependencies, " +
      "assign wave numbers, write task_plan.md in planning-with-files format. " +
      "(2) serve as PR quality gate — read all raw PR comments and decide pass or fail.  " +
      "For quality gate: any P0 finding or coverage <95% = fail. Output JSON: " +
      '{"decision": "pass"|"fail", "reason": "...", "unresolved": [...]}',
    icon: "\uD83D\uDCCA",
  },
  Designer: {
    model: "claude-sonnet-4-5",
    transport: "session",
    tools: ["Read", "Bash", "Glob", "Grep", "WebFetch"],
    systemPrompt:
      "You are the Designer agent.  " +
      "Generate HTML mockup variants for frontend tasks.  " +
      "Use the project's design tokens from .impeccable.md if it exists.",
    icon: "\uD83C\uDFA8",
  },
};

export interface AgentOptions {
  model: string;
  systemPrompt: string;
  allowedTools: string[];
}

export function getAgentOptions(agentType: string): AgentOptions {
  const config = AGENT_CONFIGS[agentType];
  if (!config) throw new Error(`Unknown agent type: ${agentType}`);
  return {
    model: config.model,
    systemPrompt: config.systemPrompt,
    allowedTools: [...config.tools],
  };
}
