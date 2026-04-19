#!/bin/bash
# Reins PreToolUse hook for Write/Edit
# Blocks test tampering (.skip, .only) and warns on hollow implementations.
# Input: JSON on stdin with tool_name, tool_input fields

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.file // ""')
CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // ""')

# H1: Block test tampering
if echo "$FILE_PATH" | grep -qE '(/tests/|/test_)'; then
  if echo "$CONTENT" | grep -qE '\.skip\(|pytest\.mark\.skip|\.only\('; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Test tampering blocked: .skip() or .only() detected. Fix the implementation, not the test."}}'
    exit 0
  fi
fi

# H2: Warn on hollow implementation (many hardcoded returns)
if ! echo "$FILE_PATH" | grep -qE '(/tests/|/test_)'; then
  COUNT=$(echo "$CONTENT" | grep -c 'return {' || true)
  if [ "$COUNT" -gt 5 ]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"⚠️ Warning: possible hollow implementation — '"$COUNT"' hardcoded return dicts detected."}}'
    exit 0
  fi
fi

# Allow
echo '{}'
