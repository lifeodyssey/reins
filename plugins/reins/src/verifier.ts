/**
 * Verifier agent: builds prompts and parses verification results.
 */

export interface AcResult {
  criterion: string;
  met: boolean;
}

export interface VerifierResult {
  approved: boolean;
  acResults: AcResult[];
  issues: string[];
}

export function buildVerifierPrompt(
  acceptanceCriteria: string[],
  gitDiff: string,
  agentSummary: string,
  testResults = "",
): string {
  const maxDiffLen = 3000;
  let diffSection = gitDiff;
  if (gitDiff.length > maxDiffLen) {
    diffSection = gitDiff.slice(0, maxDiffLen) + `\n\n[DIFF TRUNCATED - total length was ${gitDiff.length} chars]`;
  }

  let prompt = "# Verification Request\n\n";
  prompt += "## Acceptance Criteria to Verify\n";
  acceptanceCriteria.forEach((ac, i) => {
    prompt += `${i + 1}. ${ac}\n`;
  });

  prompt += "\n## Git Changes\n```diff\n" + diffSection + "\n```\n";
  prompt += "\n## Agent Summary\n" + agentSummary + "\n";

  if (testResults) {
    prompt += "\n## Test Results\n" + testResults + "\n";
  }

  prompt += `
## Verification Task
Please analyze the changes against the acceptance criteria and provide your assessment in JSON format.

Respond with ONLY valid JSON (no additional text) containing:
{
    "approved": boolean,
    "ac_results": [
        {
            "criterion": "string - the acceptance criterion",
            "met": boolean
        }
    ],
    "issues": ["string - list of any issues or concerns found"]
}

Where:
- approved: true if ALL acceptance criteria are met and no issues remain
- ac_results: Assessment of each criterion
- issues: List of any blocking issues, edge cases, or concerns
`;

  return prompt;
}

export function parseVerifierResponse(response: string): VerifierResult {
  // Try code block
  let jsonStr: string;
  const mdMatch = response.match(/```(?:json)?\s*\n?(.*?)\n?```/s);
  if (mdMatch) {
    jsonStr = mdMatch[1];
  } else {
    const btMatch = response.match(/`(?:json)?\s*\n?(.*?)\n?`/s);
    jsonStr = btMatch ? btMatch[1] : response;
  }

  try {
    const data = JSON.parse(jsonStr);
    let issues = data.issues ?? [];
    if (!Array.isArray(issues)) issues = [String(issues)];
    return {
      approved: Boolean(data.approved),
      acResults: data.ac_results ?? [],
      issues,
    };
  } catch (e: any) {
    return {
      approved: false,
      acResults: [],
      issues: [`Failed to parse JSON from response: ${e.message}`],
    };
  }
}
