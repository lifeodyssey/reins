#!/usr/bin/env bash
# Setup the sandbox-tester environment (one-time)
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== Sandbox Tester Setup ==="

# 1. Check msb server
if ! command -v msb &>/dev/null; then
  echo "ERROR: msb not installed. Run: curl -fsSL https://get.microsandbox.dev | sh"
  exit 1
fi

echo "1. msb: $(msb --version)"

# 2. Check/start msb server
if ! msb server status &>/dev/null; then
  echo "2. Starting msb server..."
  msb server start --dev -d
else
  echo "2. msb server: running"
fi

# 3. Download pgembed Linux wheels
if [ ! -f ".pg-wheels/pgembed-0.2.0-cp313-cp313-manylinux_2_28_aarch64.whl" ]; then
  echo "3. Downloading pgembed Linux wheels..."
  mkdir -p .pg-wheels
  pip3 download pgembed \
    --platform manylinux_2_28_aarch64 \
    --python-version 3.13 \
    --only-binary=:all: \
    -d .pg-wheels
else
  echo "3. pgembed wheels: cached"
fi

# 4. Download uv Linux binary
if [ ! -f "/tmp/uv-linux/uv" ]; then
  echo "4. Downloading uv Linux binary..."
  mkdir -p /tmp/uv-linux
  curl -LsSf https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-unknown-linux-gnu.tar.gz \
    | tar xz -C /tmp/uv-linux --strip-components=1
else
  echo "4. uv Linux binary: cached"
fi

# 5. Build Linux venv via Docker
if [ ! -f ".sandbox-venv/.venv/bin/python3" ]; then
  echo "5. Building Linux venv via Docker (this takes a few minutes)..."
  mkdir -p .sandbox-venv
  docker run --rm \
    -v "$PROJECT_ROOT:/workspace:ro" \
    -v "$PROJECT_ROOT/.pg-wheels:/wheels:ro" \
    -v "$PROJECT_ROOT/.sandbox-venv:/output" \
    python:3.13-slim bash -c '
set -e
pip install uv -q 2>&1 | tail -1
cp -r /workspace/backend /workspace/pyproject.toml /workspace/uv.lock /workspace/README.md /workspace/pytest.ini /workspace/supabase /output/
cd /output
UV_LINK_MODE=copy uv sync --dev -q 2>&1 | tail -1
uv pip install /wheels/*.whl -q
uv run python3 -c "import asyncpg, pgembed; print(\"venv BUILD OK\")"
'
else
  echo "5. Linux venv: cached"
fi

echo ""
echo "=== Setup complete ==="
echo "Run: /sandbox-tester test"
