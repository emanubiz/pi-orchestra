# Hermes MCP Control Plane

`pinodes-orchestra-mcp` exposes the Pinodes Orchestra REST control plane as an MCP server for Hermes and other MCP-capable hosts. The server is intentionally thin: it validates local safety constraints, forwards requests to the configured Orchestra backend, and returns JSON responses as MCP text content.

## Build

From the repository root:

```bash
npm install
npm run build -w mcp-server
npm test -w mcp-server
```

The compiled stdio entrypoint is:

```bash
/home/emanu/Scrivania/Workspace/pinodes-orchestra-mcp/mcp-server/dist/index.js
```

## Hermes Configuration

Example Hermes config:

```yaml
mcp_servers:
  pinodes_orchestra:
    command: "node"
    args:
      - "/home/emanu/Scrivania/Workspace/pinodes-orchestra-mcp/mcp-server/dist/index.js"
    env:
      PINODES_ORCHESTRA_URL: "<http://127.0.0.1:3847>"
      PINODES_ORCHESTRA_ALLOWED_ROOTS: "/home/emanu/Scrivania/Workspace"
      PINODES_ORCHESTRA_MCP_MODE: "safe"
```

Equivalent CLI registration:

```bash
hermes mcp add pinodes_orchestra --command node --args /home/emanu/Scrivania/Workspace/pinodes-orchestra-mcp/mcp-server/dist/index.js
hermes mcp test pinodes_orchestra
```

Keep secrets out of checked-in config. If the backend requires authentication, provide `PINODES_ORCHESTRA_TOKEN` through the host environment or a local secret store.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `PINODES_ORCHESTRA_URL` | `http://127.0.0.1:3847` | Base URL for the Orchestra backend. |
| `PINODES_ORCHESTRA_TOKEN` | unset | Optional token sent as `X-PiNodes-Orchestra-Token`. |
| `PINODES_ORCHESTRA_ALLOWED_ROOTS` | unset | Comma-separated list of allowed filesystem roots for `orchestra_create_board` and `graph.cwd`. Empty means no root restriction. |
| `PINODES_ORCHESTRA_MCP_MODE` | `safe` | Operational mode. P0 safe mode never opens browsers directly. |
| `PINODES_ORCHESTRA_TIMEOUT_MS` | `30000` | Per-request timeout, capped at 300000 ms. |
| `PINODES_ORCHESTRA_MCP_AUDIT_LOG` | unset | Explicit JSONL audit log path. |
| `PINODES_ORCHESTRA_DATA_DIR` | `~/.pinodes-orchestra` | Base directory for `mcp-audit.jsonl` when no explicit audit path is set. |

## Tools

| Tool | REST endpoint | Notes |
|------|---------------|-------|
| `orchestra_health` | `GET /api/health` | Backend health check. |
| `orchestra_info` | `GET /api/info` | Backend runtime/API information. |
| `orchestra_list_boards` | `GET /api/v1/orchestra/boards` | Lists live and persisted boards. |
| `orchestra_create_board` | `POST /api/v1/orchestra/boards` | Validates `cwd` against `PINODES_ORCHESTRA_ALLOWED_ROOTS`. |
| `orchestra_get_graph` | `GET /api/v1/orchestra/boards/:id/graph` | Fetches a board graph. |
| `orchestra_put_graph` | `PUT /api/v1/orchestra/boards/:id/graph` | Validates `graph.cwd` when provided. |
| `orchestra_run_board` | `POST /api/v1/orchestra/boards/:id/run` | Starts a board task through the API. |
| `orchestra_get_status` | `GET /api/v1/orchestra/boards/:id/status` | Reads board/node status. |
| `orchestra_inject_node` | `POST /api/v1/orchestra/boards/:id/nodes/:nodeId/inject` | Injects a message through the safe API, not raw PTY input. |
| `orchestra_stop_board` | `POST /api/v1/orchestra/boards/:id/stop` | Stops running sessions for a board. |
| `orchestra_open_ui` | none | Returns a UI URL/deep link. It does not launch a browser in safe mode. |

## Audit Logging

Mutative tools append one JSON object per line to the audit log:

- `orchestra_create_board`
- `orchestra_put_graph`
- `orchestra_run_board`
- `orchestra_inject_node`
- `orchestra_stop_board`

Audit entries include `ts`, `actor`, `tool`, and `input`. Audit failures are swallowed so logging cannot block control-plane actions.

## Smoke Test

With the backend running on `PINODES_ORCHESTRA_URL`, verify the MCP server through Hermes:

```bash
hermes mcp test pinodes_orchestra
```

For a local protocol sanity check, starting the compiled server with closed stdin should exit without printing diagnostic output to stdout:

```bash
node /home/emanu/Scrivania/Workspace/pinodes-orchestra-mcp/mcp-server/dist/index.js
```
