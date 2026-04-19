/**
 * Router agent: builds prompts and parses routing decisions.
 */

export const VALID_DECISIONS = [
  "proceed_to_review",
  "proceed_to_test",
  "re_execute",
  "re_execute_with_findings",
  "skip",
  "escalate_to_human",
  "merge",
] as const;

export type Decision = (typeof VALID_DECISIONS)[number];

export interface RouterResult {
  decision: string;
  reason: string;
}

export function buildRouterPrompt(
  cardTitle: string,
  lastVerdict: string,
  attempt: number,
  verifierResult: string,
  maxAttempts = 3,
): string {
  const decisionsList = VALID_DECISIONS.map((d) => `  - ${d}`).join("\n");

  return `You are the Router agent. Based on the current state, decide the next action.

**Card Information:**
- Title: ${cardTitle}
- Current Attempt: ${attempt}/${maxAttempts}
- Last Verdict: ${lastVerdict}
- Verifier Result: ${verifierResult}

**Valid Decisions:**
${decisionsList}

Based on this information, determine which decision to make. Respond with a JSON object containing:
- "decision": one of the valid decisions above
- "reason": a brief explanation of why you chose this decision
`;
}

export function parseRouterResponse(response: string): RouterResult {
  if (!response || typeof response !== "string") {
    return { decision: "escalate_to_human", reason: "No response provided" };
  }

  let jsonObj: any = null;

  // Try markdown code block first
  const mdMatch = response.match(/```(?:json)?\s*\n?(.*?)\n?```/s);
  if (mdMatch) {
    try {
      jsonObj = JSON.parse(mdMatch[1].trim());
    } catch {}
  }

  // Try raw JSON
  if (jsonObj === null) {
    try {
      jsonObj = JSON.parse(response);
    } catch {
      return { decision: "escalate_to_human", reason: "Failed to parse JSON response" };
    }
  }

  if (typeof jsonObj !== "object" || !jsonObj || !("decision" in jsonObj)) {
    return { decision: "escalate_to_human", reason: "Decision field missing from response" };
  }

  const decision = String(jsonObj.decision ?? "").trim();
  const reason = String(jsonObj.reason ?? "");

  if (!(VALID_DECISIONS as readonly string[]).includes(decision)) {
    return { decision: "escalate_to_human", reason: `Invalid decision: ${decision}` };
  }

  return { decision, reason };
}
