---
name: sandbox-tester
description: >
  Run API tests in an isolated microsandbox microVM with embedded Postgres.
  Use when tester agents need to start the full app and test API endpoints
  in an isolated environment. Each sandbox has its own network stack, DB,
  and app instance. Trigger on: "sandbox test", "test in sandbox",
  "run API tests isolated", "sandbox-tester".
compatibility: >
  Requires microsandbox MCP server connected, pre-built Linux venv at
  .sandbox-venv/, pgembed wheels at .pg-wheels/, uv binary at /tmp/uv-linux/.
  Run scripts/setup.sh if prerequisites missing.
---

# Sandbox Tester

Test API endpoints inside an isolated microsandbox microVM with embedded Postgres.

## Prerequisites check

First verify setup is ready:

```bash
bash .claude/skills/sandbox-tester/scripts/setup.sh --check
```

If any prerequisite is missing, run full setup:

```bash
bash .claude/skills/sandbox-tester/scripts/setup.sh
```

## Test workflow

Execute these steps using microsandbox MCP tools (`mcp__microsandbox__*`):

### Step 1: Create sandbox

Call `mcp__microsandbox__sandbox_create` with:
- **name**: `tester-{purpose}` (e.g., `tester-wave1`)
- **image**: `microsandbox/python`
- **memoryMib**: `8192`
- **cpus**: `4`
- **volumes**:
  - `{project_root}/.sandbox-venv` → `/app`
  - `{project_root}/.pg-wheels` → `/wheels` (readonly)
  - `/tmp/uv-linux` → `/uv-bin` (readonly)

### Step 2: Install and start Postgres

Call `mcp__microsandbox__sandbox_shell` with:
```
/uv-bin/uv venv /tmp/pgvenv --python 3.13 -q && /uv-bin/uv pip install --python /tmp/pgvenv/bin/python3 /wheels/pgembed-0.2.0-cp313-cp313-manylinux_2_28_aarch64.whl /wheels/fasteners-0.20-py3-none-any.whl /wheels/platformdirs-4.9.6-py3-none-any.whl /wheels/psutil-7.2.2-cp36-abi3-manylinux2014_aarch64.manylinux_2_17_aarch64.manylinux_2_28_aarch64.whl -q && echo "pgembed installed"
```

Then initialize and start Postgres as daemon:
```
/tmp/pgvenv/bin/python3 -c "import pgembed; pgembed.get_server('/tmp/pgdata')" && nohup $(find /tmp/pgvenv -name postgres -type f | head -1) -D /tmp/pgdata -k /tmp/pgdata > /tmp/pg.log 2>&1 & sleep 2 && echo "PG ready"
```

### Step 3: Run migrations

```
cd /app && .venv/bin/python3 -c "
import asyncio, asyncpg, glob, os
async def m():
    c = await asyncpg.connect(host='/tmp/pgdata', user='postgres', database='postgres')
    for f in sorted(glob.glob('supabase/migrations/*.sql')):
        try: await c.execute(open(f).read())
        except: pass
    await c.close()
asyncio.run(m())
print('migrated')
"
```

Note: PostGIS-dependent migrations will skip (bangumi, points). conversations and user_memory tables will be created.

### Step 4: Start app

```
cd /app && SUPABASE_DB_URL="postgresql://postgres@localhost/postgres?host=/tmp/pgdata" APP_ENV=development nohup .venv/bin/python3 -m uvicorn backend.interfaces.fastapi_service:app --host 0.0.0.0 --port 8080 > /tmp/app.log 2>&1 &
```

IMPORTANT: Use `.venv/bin/python3 -m uvicorn`, NOT `.venv/bin/uvicorn` (shebang path mismatch).

Wait 8 seconds, then verify with:
```
sleep 8 && curl -s http://localhost:8080/healthz
```

Expected: `{"status":"ok","service":"seichijunrei-runtime",...}`

### Step 5: Run API tests

Run ONE test per `sandbox_shell` call to avoid sandbox crashes on long commands:

```
echo "TEST: healthz" && curl -s -w "\nHTTP_%{http_code}" http://localhost:8080/healthz
```

```
echo "TEST: conversations" && curl -s -w "\nHTTP_%{http_code}" http://localhost:8080/v1/conversations -H "X-User-Id: tester"
```

```
echo "TEST: no auth 400" && curl -s -w "\nHTTP_%{http_code}" http://localhost:8080/v1/conversations
```

```
echo "TEST: runtime" && curl -s -w "\nHTTP_%{http_code}" -X POST http://localhost:8080/v1/runtime -H "Content-Type: application/json" -H "X-User-Id: tester" -H "X-User-Type: human" -d '{"text":"hello","locale":"ja","session_id":"test"}'
```

```
echo "TEST: empty text 422" && curl -s -w "\nHTTP_%{http_code}" -X POST http://localhost:8080/v1/runtime -H "Content-Type: application/json" -H "X-User-Id: tester" -H "X-User-Type: human" -d '{"text":"","locale":"ja","session_id":"test"}'
```

```
echo "TEST: SSE stream" && curl -s -N --max-time 15 -X POST http://localhost:8080/v1/runtime/stream -H "Content-Type: application/json" -H "X-User-Id: tester" -H "X-User-Type: human" -d '{"text":"hello","locale":"ja","session_id":"test-sse"}'
```

### Step 6: Cleanup

Call `mcp__microsandbox__sandbox_stop` then `mcp__microsandbox__sandbox_remove` with the sandbox name.

## Known limitations

- **8GB RAM minimum** — uvicorn + Postgres + 200 packages needs memory
- **PostGIS unavailable** — bangumi, points, routes tables won't migrate
- **No LLM keys** — runtime/stream endpoints return 500 graceful error (expected)
- **One test per shell call** — long compound commands can crash the sandbox session
- **Shebang mismatch** — always use `python3 -m <tool>` not direct binary calls
