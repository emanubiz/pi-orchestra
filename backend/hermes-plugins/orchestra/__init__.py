"""
Orchestra plugin for Hermes — agent-to-agent coordination.

Auto-disables when PINODES_ORCHESTRA_NODE is not in the environment, so it
never interferes with normal Hermes usage on the same machine.

Handoffs use the SAME text-sentinel protocol as the pi runtime — `@@HANDOFF`,
`@@CARD`, `@@DONE` — so there is ONE orchestration standard across runtimes, not
a pi/hermes split. Hermes has no bespoke `orchestra_*` tool: the model just
writes the sentinel blocks, and this plugin parses them out of the turn's output
(`transform_llm_output`) exactly like the pi extension parses pi's output. That
also means handoffs no longer depend on Hermes' tool-calling API/dispatch
convention — a purely textual protocol can't break on a tool-schema mismatch.

Lifecycle:
  on_session_start    → POST /internal/ready              (mark node as booted)
  pre_llm_call        → GET  /internal/orchestra-context  (per-turn appendix)
  transform_llm_output→ parse @@HANDOFF/@@CARD, deliver, strip sentinels
  post_llm_call       → POST /internal/turn-ended         (watchdog signal)
"""

import os
import re
import json
import logging
import urllib.error
import urllib.request
from typing import Any

# Every call blocks the agent's turn until it returns — cap it so a stalled
# or unreachable orchestra backend can't hang a hermes session indefinitely.
_HTTP_TIMEOUT_S = 5

log = logging.getLogger("orchestra_plugin")

# Sentinel protocol — kept byte-for-byte in sync with the pi extension
# (backend/pi-extensions/call-agent.ts). A recipient handle followed by a
# self-contained instruction block terminated by @@END; a @@CARD:<column> line;
# and a lone @@DONE line as the terminal "chain finished here" signal.
_HANDOFF_RE = re.compile(r"@@HANDOFF:\s*([^\s\n]+)\s*\n(.*?)@@END", re.DOTALL)
_CARD_RE = re.compile(r"@@CARD:\s*([^\s\n]+)")
_DONE_LINE_RE = re.compile(r"(?m)^\s*@@DONE\s*$")


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
# Whether a @@HANDOFF was delivered since the last turn-ended signal. A Hermes
# session is a single node processing turns sequentially, so a plain flag is
# enough and can't drift between hooks.
_handoff_called_this_turn = False


# ── Sentinel parsing / delivery ───────────────────────────────────────────────


def _deliver_cards(text: str) -> None:
    """POST every distinct @@CARD:<column> found in the turn's output."""
    seen: set[str] = set()
    for m in _CARD_RE.finditer(text):
        column = m.group(1).strip().strip("\"'")
        if not column or column in seen:
            continue
        seen.add(column)
        try:
            _post("/internal/card-status", {"boardId": _board, "column": column})
        except Exception as e:
            log.warning("orchestra: /internal/card-status failed: %s", e)


def _deliver_handoffs(text: str) -> int:
    """Deliver every @@HANDOFF block; return how many the backend accepted.

    Mirrors the pi extension: dedup identical blocks within one turn, POST each
    to /internal/call-agent, and only count a delivery when the backend both
    accepts (HTTP ok) and resolves the recipient (body.ok).
    """
    seen: set[str] = set()
    delivered = 0
    for m in _HANDOFF_RE.finditer(text):
        recipient = m.group(1).strip().strip("\"'")
        message = m.group(2).strip()
        if not recipient or not message:
            continue
        sig = f"{recipient}::{message}"
        if sig in seen:
            continue
        seen.add(sig)
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
                delivered += 1
        except Exception as e:
            log.warning("orchestra: /internal/call-agent failed: %s", e)
    return delivered


def _strip_sentinels(text: str) -> str:
    """Remove @@HANDOFF/@@CARD/@@DONE machinery from the user-visible output."""
    cleaned = _HANDOFF_RE.sub("", text)
    cleaned = _CARD_RE.sub("", cleaned)
    cleaned = _DONE_LINE_RE.sub("", cleaned)
    return cleaned.strip()


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

    def transform_llm_output(**kwargs: Any) -> str | None:
        """Parse the turn's output for sentinels, deliver them, and strip them.

        Fires once per turn BEFORE post_llm_call (see agent/turn_finalizer.py),
        and its return value replaces the response text — so the flag we set here
        is visible to the watchdog, and the raw @@HANDOFF/@@CARD/@@DONE machinery
        never reaches the user's terminal or the stored history. Returning None
        (or an empty string) leaves the text unchanged.
        """
        global _handoff_called_this_turn
        text = kwargs.get("response_text") or ""
        if not text:
            return None

        has_handoff = _HANDOFF_RE.search(text) is not None
        has_card = _CARD_RE.search(text) is not None
        has_done = _DONE_LINE_RE.search(text) is not None
        if not (has_handoff or has_card or has_done):
            return None  # no orchestration sentinels — leave the output as-is

        if has_card:
            _deliver_cards(text)
        if has_handoff:
            if _deliver_handoffs(text) >= 1:
                _handoff_called_this_turn = True

        cleaned = _strip_sentinels(text)
        # If the message was ONLY sentinels, leave a short human-visible trace
        # rather than returning "" (which the host treats as "no change").
        return cleaned or "🤝 …"

    def post_llm_call(**kwargs: Any) -> None:
        """Signal end-of-turn so the watchdog can nudge if needed."""
        global _handoff_called_this_turn
        handoff_called = _handoff_called_this_turn
        _handoff_called_this_turn = False
        try:
            _post(
                "/internal/turn-ended",
                {
                    "boardId": _board,
                    "nodeId": _node,
                    "handoffCalledThisTurn": handoff_called,
                },
            )
        except Exception as e:
            log.warning("orchestra: /internal/turn-ended failed: %s", e)

    ctx.register_hook("on_session_start", on_session_start)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("transform_llm_output", transform_llm_output)
    ctx.register_hook("post_llm_call", post_llm_call)
