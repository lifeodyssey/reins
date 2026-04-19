/**
 * Harness state machine: Phase enum, AgentSession, shared types.
 */

export const Phase = {
  IDLE: "idle",
  PLANNING: "planning",
  AWAITING_SPEC_APPROVAL: "spec_approval",
  DESIGNING: "designing",
  AWAITING_CARD_APPROVAL: "card_approval",
  EXECUTING: "executing",
  VERIFYING: "verifying",
  ROUTING: "routing",
  REVIEWING: "reviewing",
  TESTING: "testing",
  MERGING: "merging",
  ESCALATED: "escalated",
  COMPLETE: "complete",
} as const;

export type Phase = (typeof Phase)[keyof typeof Phase];

export function isTerminalPhase(phase: Phase): boolean {
  return phase === Phase.COMPLETE || phase === Phase.ESCALATED;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  _live?: boolean;
}

export interface LogEntry {
  ts: string;
  action: string;
  detail: string;
}

export class AgentSession {
  name: string;
  agentType: string;
  client: any = null;
  status = "idle";
  lastTool = "-";
  lastActivity = "-";
  messageCount = 0;
  chatHistory: ChatMessage[] = [];
  log: LogEntry[] = [];
  isStreaming = false;

  constructor(name: string, agentType: string) {
    this.name = name;
    this.agentType = agentType;
  }

  record(action: string, detail = ""): void {
    const ts = new Date().toTimeString().slice(0, 8);
    this.lastActivity = `${ts} ${action}`;
    this.log.push({ ts, action, detail: detail.slice(0, 150) });
    if (this.log.length > 100) {
      this.log = this.log.slice(-100);
    }
  }
}
