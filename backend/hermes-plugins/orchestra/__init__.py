"""
Orchestra plugin for Hermes — agent-to-agent coordination.

Auto-disables when PINODES_ORCHESTRA_NODE is not in the environment, so it
never interferes with normal Hermes usage on the same machine.

Lifecycle:
  on_session_start  → POST /internal/ready        (mark node as booted)
  pre_llm_call      → GET /internal/orchestra-context  (per-turn appendix)
  post_llm_call     → POST /internal/turn-ended    (watchdog signal)

Tools:
  orchestra_handoff(recipient, message) → POST /internal/call-agent
  orchestra_card(column)               → POST /internal/card-status
"""

import os
import json
import logging
import urllib.error
import urllib.request
from typing import Any

# Every call blocks the agent's turn until it returns — cap it so a stalled
# or unreachable orchestra backend can't hang a hermes session indefinitely.
_HTTP_TIMEOUT_S = 5

log = logging.getLogger("orchestra_plugin")


def _env(name: str) -> str:
    """Read a required env var, raising a clear error if missing."""
    val = os.environ.get(name, "").strip()
    if not val:
        raise RuntimeError(f"Orchestra plugin: {name} is not set in environment")
    return val


def _post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    """POST JSON to the orchestra backend. Returns the parsed response body."""
    base = _env("PINODES_ORCHESTRA_URL").rstrip("/")
    token = os.environ.get("PINODES_ORCHESTRA_TOKEN", "").strip()
    url = f"{base}{path}"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            **(token and {"Authorization": f"Bearer {token}"} or {}),
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get(path: str) -> dict[str, Any]:
    """GET JSON from the orchestra backend."""
    base = _env("PINODES_ORCHESTRA_URL").rstrip("/")
    token = os.environ.get("PINODES_ORCHESTRA_TOKEN", "").strip()
    url = f"{base}{path}"
    req = urllib.request.Request(
        url,
        headers={
            "Content-Type": "application/json",
            **(token and {"Authorization": f"Bearer {token}"} or {}),
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ── Shared state (per-session) ────────────────────────────────────────────────

_board = ""
_node = ""
_handoff_called_this_turn = False


# ── Plugin entry point ────────────────────────────────────────────────────────


def register(ctx: Any) -> None:
    """Called by Hermes when the plugin is loaded."""
    global _board, _node

    # Gate: skip entirely when not running under Orchestra.
    if not os.environ.get("PINODES_ORCHESTRA_NODE", "").strip():
        return

    _board = os.environ.get("PINODES_ORCHESTRA_BOARD", "").strip()
    _node = os.environ.get("PINODES_ORCHESTRA_NODE", "").strip()

    # ── Hooks ──────────────────────────────────────────────────────────────

    def on_session_start(**kwargs: Any) -> None:
        """Mark the node as booted so queued tasks flush immediately."""
        try:
            _post("/internal/ready", {"boardId": _board, "nodeId": _node})
        except Exception as e:
            # Don't crash the session — the backend has a fallback timeout.
            log.warning("orchestra: /internal/ready failed: %s", e)

    def pre_llm_call(**kwargs: Any) -> dict[str, Any] | None:
        """Inject the live orchestration appendix into the current turn."""
        try:
            orchestra_ctx = _get(
                f"/internal/orchestra-context?boardId={_board}&nodeId={_node}"
            )
            appendix = orchestra_ctx.get("appendix", "")
            if appendix:
                return {"context": appendix}
        except Exception as e:
            log.warning("orchestra: /internal/orchestra-context failed: %s", e)
        return None

    def post_llm_call(**kwargs: Any) -> None:
        """Signal end-of-turn so the watchdog can nudge if needed."""
        global _handoff_called_this_turn
        try:
            _post(
                "/internal/turn-ended",
                {
                    "boardId": _board,
                    "nodeId": _node,
                    "handoffCalledThisTurn": _handoff_called_this_turn,
                },
            )
        except Exception as e:
            log.warning("orchestra: /internal/turn-ended failed: %s", e)
        finally:
            _handoff_called_this_turn = False

    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_llm_call", post_llm_call)

    # ── Tools ──────────────────────────────────────────────────────────────

    def orchestra_handoff(
        recipient: str,
        message: str,
    ) -> str:
        """Hand off work to another agent in the pipeline.

        Args:
            recipient: The handle of the target agent (e.g. 'developer-1', 'qa').
            message: Self-contained instructions for the downstream agent.
        """
        global _handoff_called_this_turn
        _handoff_called_this_turn = True

        try:
            result = _post(
                "/internal/call-agent",
                {
                    "boardId": _board,
                    "fromNodeId": _node,
                    "targetNodeId": recipient,
                    "message": message,
                },
            )
            if result.get("ok"):
                return result.get("message", "Task delivered.")
            return f"Handoff failed: {result.get('error', 'Unknown error')}"
        except Exception as e:
            return f"Handoff error: {e}"

    def orchestra_card(column: str) -> str:
        """Advance the linked Kanban card to a new column.

        Args:
            column: Target column: todo, in_progress, test, review, done.
        """
        valid = {"todo", "in_progress", "test", "review", "done"}
        col = column.lower().strip()
        if col not in valid:
            return f"Invalid column '{column}'. Valid: {', '.join(sorted(valid))}"
        try:
            _post("/internal/card-status", {"boardId": _board, "column": col})
            return f"Card moved to {col}."
        except Exception as e:
            return f"Card update error: {e}"

    ctx.register_tool(
        "orchestra_handoff",
        "orchestra",
        {
            "type": "object",
            "properties": {
                "recipient": {
                    "type": "string",
                    "description": "Handle of the target agent (e.g. developer-1, qa)",
                },
                "message": {
                    "type": "string",
                    "description": "Self-contained instructions for the downstream agent",
                },
            },
            "required": ["recipient", "message"],
        },
        orchestra_handoff,
        description="Hand off work to another agent in the pipeline",
        emoji="🤝",
    )

    ctx.register_tool(
        "orchestra_card",
        "orchestra",
        {
            "type": "object",
            "properties": {
                "column": {
                    "type": "string",
                    "description": "Target column: todo, in_progress, test, review, done",
                },
            },
            "required": ["column"],
        },
        orchestra_card,
        description="Advance the linked Kanban card to a new column",
        emoji="📋",
    )
