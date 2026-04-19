"""Router agent module for decision-making in CI/CD workflows.

This module provides utilities for building prompts for the Router agent and parsing
its responses to determine the next action in the verification and deployment pipeline.
"""

import json
import re
from typing import Dict

# Valid decisions that the Router agent can make
VALID_DECISIONS = [
    "proceed_to_review",
    "proceed_to_test",
    "re_execute",
    "re_execute_with_findings",
    "skip",
    "escalate_to_human",
    "merge",
]


def build_router_prompt(
    card_title: str,
    last_verdict: str,
    attempt: int,
    verifier_result: str,
    max_attempts: int = 3,
) -> str:
    """Build a prompt for the Router agent to make routing decisions.

    The prompt includes information about the card, current attempt count,
    and the last verdict/result, along with a list of valid decisions.

    Args:
        card_title: The title of the task/card being executed
        last_verdict: The verdict from the last execution (e.g., "success", "failed")
        attempt: The current attempt number
        verifier_result: The detailed result from the verifier
        max_attempts: Maximum number of attempts allowed (default: 3)

    Returns:
        A formatted prompt string for the Router agent
    """
    decisions_list = "\n".join(f"  - {decision}" for decision in VALID_DECISIONS)

    prompt = f"""You are the Router agent. Based on the current state, decide the next action.

**Card Information:**
- Title: {card_title}
- Current Attempt: {attempt}/{max_attempts}
- Last Verdict: {last_verdict}
- Verifier Result: {verifier_result}

**Valid Decisions:**
{decisions_list}

Based on this information, determine which decision to make. Respond with a JSON object containing:
- "decision": one of the valid decisions above
- "reason": a brief explanation of why you chose this decision
"""
    return prompt


def parse_router_response(response: str) -> Dict[str, str]:
    """Parse the Router agent's response and extract the decision.

    This function safely extracts JSON from the response, which may be embedded
    in markdown code blocks or provided as plain JSON. If parsing fails or the
    decision is invalid, it defaults to escalating to a human.

    Args:
        response: The response text from the Router agent

    Returns:
        A dictionary with "decision" and "reason" keys. If parsing fails or
        the decision is invalid, escalates to "escalate_to_human".
    """
    if not response or not isinstance(response, str):
        return {
            "decision": "escalate_to_human",
            "reason": "No response provided",
        }

    json_obj = None

    # Try to extract JSON from markdown code block first
    markdown_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", response, re.DOTALL)
    if markdown_match:
        json_str = markdown_match.group(1).strip()
        try:
            json_obj = json.loads(json_str)
        except json.JSONDecodeError:
            pass

    # If no markdown block, try to parse the entire response as JSON
    if json_obj is None:
        try:
            json_obj = json.loads(response)
        except json.JSONDecodeError:
            return {
                "decision": "escalate_to_human",
                "reason": "Failed to parse JSON response",
            }

    # Validate that we have a decision
    if not isinstance(json_obj, dict) or "decision" not in json_obj:
        return {
            "decision": "escalate_to_human",
            "reason": "Decision field missing from response",
        }

    decision = json_obj.get("decision", "").strip()
    reason = json_obj.get("reason", "")

    # Validate that the decision is in the valid set
    if decision not in VALID_DECISIONS:
        return {
            "decision": "escalate_to_human",
            "reason": f"Invalid decision: {decision}",
        }

    return {
        "decision": decision,
        "reason": reason,
    }
