"""Verifier agent for validating work against acceptance criteria."""

import json
import re
from typing import Any


def build_verifier_prompt(
    acceptance_criteria: list[str],
    git_diff: str,
    agent_summary: str,
    test_results: str = "",
) -> str:
    """Build a prompt for the verifier agent to validate work.

    Args:
        acceptance_criteria: List of acceptance criteria to verify
        git_diff: Git diff showing changes made
        agent_summary: Summary of work completed by the agent
        test_results: Optional test results summary

    Returns:
        A prompt string asking for JSON output with approval status
    """
    # Truncate diff if too long
    max_diff_length = 3000
    if len(git_diff) > max_diff_length:
        truncated_diff = git_diff[:max_diff_length]
        diff_section = f"{truncated_diff}\n\n[DIFF TRUNCATED - total length was {len(git_diff)} chars]"
    else:
        diff_section = git_diff

    # Build the prompt
    prompt = "# Verification Request\n\n"

    prompt += "## Acceptance Criteria to Verify\n"
    for i, ac in enumerate(acceptance_criteria, 1):
        prompt += f"{i}. {ac}\n"

    prompt += "\n## Git Changes\n"
    prompt += "```diff\n"
    prompt += diff_section
    prompt += "\n```\n"

    prompt += "\n## Agent Summary\n"
    prompt += agent_summary + "\n"

    if test_results:
        prompt += "\n## Test Results\n"
        prompt += test_results + "\n"

    prompt += "\n## Verification Task\n"
    prompt += """Please analyze the changes against the acceptance criteria and provide your assessment in JSON format.

Respond with ONLY valid JSON (no additional text) containing:
{
    "approved": boolean,
    "ac_results": [
        {
            "criterion": "string - the acceptance criterion",
            "met": boolean - whether this criterion is met
        }
    ],
    "issues": ["string - list of any issues or concerns found"]
}

Where:
- approved: true if ALL acceptance criteria are met and no issues remain
- ac_results: Assessment of each criterion
- issues: List of any blocking issues, edge cases, or concerns
"""

    return prompt


def parse_verifier_response(response: str) -> dict[str, Any]:
    """Parse verifier response and extract JSON with approval status.

    Attempts to extract and parse JSON from the response, handling:
    - Raw JSON
    - JSON in ```json code blocks
    - JSON in `json` blocks

    Args:
        response: The verifier agent's response

    Returns:
        Dictionary with keys:
        - approved: bool - whether changes are approved
        - ac_results: list - results for each acceptance criterion
        - issues: list - list of any issues found

        If parsing fails, returns approved=False with issues explaining the failure
    """
    # Try to find JSON in code blocks first
    json_match = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', response, re.DOTALL)
    if json_match:
        json_str = json_match.group(1)
    else:
        # Try to find JSON in backticks
        json_match = re.search(r'`(?:json)?\s*\n?(.*?)\n?`', response, re.DOTALL)
        if json_match:
            json_str = json_match.group(1)
        else:
            # Try to parse entire response as JSON
            json_str = response

    # Attempt to parse JSON
    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as e:
        return {
            "approved": False,
            "ac_results": [],
            "issues": [f"Failed to parse JSON from response: {str(e)}"],
        }

    # Validate and extract required fields with defaults
    result = {
        "approved": data.get("approved", False),
        "ac_results": data.get("ac_results", []),
        "issues": data.get("issues", []),
    }

    # Ensure issues is a list
    if not isinstance(result["issues"], list):
        result["issues"] = [str(result["issues"])]

    return result
