/**
 * Agent configuration registry.
 *
 * Each entry defines tools, system prompt, transport mode, and display
 * metadata for one agent role.
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
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LSP"],
    systemPrompt:
      `${LINUS_PREAMBLE}  ` +
      "Your role is to implement tasks precisely as specified.  " +
      "You may read, write, edit, and run shell commands.  " +
      "Always follow the acceptance criteria and write clean, tested code.",
    icon: "\u2699\uFE0F",
  },
  Reviewer: {
    model: "claude-sonnet-4-5",
    transport: "session",
    tools: ["Read", "Glob", "Grep", "Bash"],
    systemPrompt:
      `${LINUS_PREAMBLE}  ` +
      "Your role is to review pull requests for correctness, style, and test coverage.  " +
      "You have read-only access to source code.  Use Bash exclusively for " +
      "'gh pr diff' and coverage report retrieval (enforced by hook).  " +
      "Check Codecov reports and flag any coverage regression.",
    icon: "\uD83D\uDD0D",
  },
  Tester: {
    model: "claude-sonnet-4-5",
    transport: "session",
    tools: ["Bash"],
    systemPrompt:
      "You are a dedicated test runner.  " +
      "You have no access to source code \u2014 your only tool is Bash so you can " +
      "execute the project's test suite and report results faithfully.  " +
      "Do not attempt to read or modify files.",
    icon: "\uD83E\uDDEA",
  },
  Planner: {
    model: "claude-sonnet-4-5",
    transport: "session",
    tools: ["Read", "Glob", "Grep", "WebFetch"],
    systemPrompt:
      "You are a technical planning agent.  " +
      "Analyse the codebase and external resources to produce clear, actionable " +
      "implementation plans.  Output structured plans with numbered steps, " +
      "acceptance criteria, and risk notes.  Do not write or modify code.",
    icon: "\uD83D\uDCCB",
  },
  Designer: {
    model: "claude-sonnet-4-5",
    transport: "session",
    tools: ["Read", "Bash", "Glob", "Grep", "WebFetch"],
    systemPrompt:
      "You are a technical design agent.  " +
      "Analyse requirements and existing code to produce architecture diagrams, " +
      "API contracts, and data-model designs.  You may run shell commands to " +
      "inspect the repo (e.g. directory listings, git log) but must not edit files.",
    icon: "\uD83C\uDFA8",
  },
  Router: {
    model: "claude-sonnet-4-5",
    transport: "oneshot",
    tools: [],
    systemPrompt:
      "You are a routing agent.  " +
      "Given a description of work completed and the current harness phase, " +
      "output a JSON decision object that specifies the next phase and rationale.  " +
      'Example: {"next_phase": "TESTING", "reason": "implementation complete"}.  ' +
      "Output only valid JSON \u2014 no prose, no markdown fences.",
    icon: "\uD83D\uDD00",
  },
  Verifier: {
    model: "claude-sonnet-4-5",
    transport: "oneshot",
    tools: ["Read"],
    systemPrompt:
      "You are a verification agent.  " +
      "Read the acceptance criteria and the implementation artefacts, then " +
      "determine whether all acceptance criteria are satisfied.  " +
      "Output a JSON report: " +
      '{"passed": true/false, "failures": ["..."], "notes": "..."}.  ' +
      "Output only valid JSON.",
    icon: "\u2705",
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
