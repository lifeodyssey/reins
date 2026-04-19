#!/bin/bash
# Reins PreToolUse hook for Bash
# Blocks force push. Context-aware: if REINS_AGENT is "tester" or "reviewer",
# applies bash whitelist.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# H5: Block force push (all agents)
if echo "$COMMAND" | grep -q 'push' && echo "$COMMAND" | grep -qE '\-\-force|\s-f\s|-f$'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Force push is not allowed."}}'
  exit 0
fi

# Allow
echo '{}'
