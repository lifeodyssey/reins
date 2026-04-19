#!/usr/bin/env bash
# Run API tests inside a microsandbox
# Usage: test.sh [sandbox-name] [test-endpoints...]
# Example: test.sh tester-b2 healthz conversations runtime
set -euo pipefail

SANDBOX_NAME="${1:-sandbox-test-$$}"
shift || true
TESTS="${*:-all}"

PROJECT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

echo "=== Sandbox Tester: $SANDBOX_NAME ==="
echo "Tests: $TESTS"
echo ""

# Create sandbox via MCP (caller should use MCP tools)
# This script is meant to be called from within a sandbox_shell session
# after the sandbox is already created and app is running.

PASS=0
FAIL=0
RESULTS=""

run_test() {
  local name="$1"
  local method="$2"
  local url="$3"
  local expect_code="$4"
  local extra_args="${5:-}"

  local response
  local http_code
  response=$(curl -s -w "\n%{http_code}" $extra_args -X "$method" "http://localhost:8080$url" 2>&1)
  http_code=$(echo "$response" | tail -1)
  local body=$(echo "$response" | head -n -1)

  if [ "$http_code" = "$expect_code" ]; then
    echo "PASS $name: HTTP $http_code"
    PASS=$((PASS + 1))
    RESULTS="$RESULTS\nPASS|$name|$http_code|$(echo "$body" | head -c 80)"
  else
    echo "FAIL $name: expected $expect_code, got $http_code"
    echo "  body: $(echo "$body" | head -c 120)"
    FAIL=$((FAIL + 1))
    RESULTS="$RESULTS\nFAIL|$name|$http_code|$(echo "$body" | head -c 80)"
  fi
}

# Core API tests
run_test "healthz" GET "/healthz" "200"
run_test "conversations_with_auth" GET "/v1/conversations" "200" '-H "X-User-Id: tester"'
run_test "conversations_no_auth" GET "/v1/conversations" "400"
run_test "runtime_valid" POST "/v1/runtime" "500" '-H "Content-Type: application/json" -H "X-User-Id: tester" -H "X-User-Type: human" -d '\''{"text":"hello","locale":"ja","session_id":"test"}'\'''
run_test "runtime_empty_text" POST "/v1/runtime" "422" '-H "Content-Type: application/json" -H "X-User-Id: tester" -H "X-User-Type: human" -d '\''{"text":"","locale":"ja","session_id":"test"}'\'''
run_test "feedback_invalid" POST "/v1/feedback" "422" '-H "Content-Type: application/json" -d '\''{"session_id":"t","rating":"good"}'\'''

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo -e "$RESULTS" | column -t -s'|'

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
