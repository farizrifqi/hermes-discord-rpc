"""
Discord RPC Activity Hook for Hermes Agent.

Writes real-time agent activity to ~/.hermes/hooks/discord-rpc-activity/activity.json
on each agent:start, agent:step, agent:end, session:start, session:end event.

The Discord RPC companion reads this file for instant presence updates.

Context keys available (from Hermes docs):
  agent:start  -> platform, user_id, session_id, message
  agent:step   -> platform, user_id, session_id, iteration, tool_names
  agent:end    -> platform, user_id, session_id, message, response
  session:start -> platform, user_id, session_id, session_key
  session:end  -> platform, user_id, session_key

Note: model is NOT available from hook context. The companion falls back to SQLite for model.

Installation:
  Copy this directory to ~/.hermes/hooks/discord-rpc-activity/
  Then restart the Hermes gateway.
"""

import json
import time
from pathlib import Path

# Output file path — the RPC companion reads this
ACTIVITY_FILE = Path.home() / ".hermes" / "hooks" / "discord-rpc-activity" / "activity.json"

# Ensure output directory exists
ACTIVITY_FILE.parent.mkdir(parents=True, exist_ok=True)


async def handle(event_type: str, context: dict):
    """Called by Hermes gateway on each subscribed event."""

    # Common fields available in most events
    platform = context.get("platform", "")
    session_id = context.get("session_id", "")

    if event_type == "session:start":
        data = {
            "status": "active",
            "event": event_type,
            "platform": platform,
            "session_id": session_id,
            "title": "Starting session...",
            "tool": None,
            "iteration": 0,
            "timestamp": time.time(),
        }

    elif event_type == "agent:start":
        data = {
            "status": "active",
            "event": event_type,
            "platform": platform,
            "session_id": session_id,
            "title": _shorten(context.get("message", ""), 80),
            "tool": None,
            "iteration": 0,
            "timestamp": time.time(),
        }

    elif event_type == "agent:step":
        tool_names = context.get("tool_names", [])
        data = {
            "status": "active",
            "event": event_type,
            "platform": platform,
            "session_id": session_id,
            "title": _shorten(context.get("message", ""), 80),
            "tool": tool_names[-1] if tool_names else None,
            "tool_history": tool_names[-3:] if tool_names else [],
            "iteration": context.get("iteration", 0),
            "timestamp": time.time(),
        }

    elif event_type == "agent:end":
        data = {
            "status": "idle",
            "event": event_type,
            "platform": platform,
            "session_id": session_id,
            "title": None,
            "tool": None,
            "iteration": 0,
            "timestamp": time.time(),
        }

    elif event_type == "session:end":
        data = {
            "status": "idle",
            "event": event_type,
            "platform": platform,
            "session_id": session_id,
            "title": None,
            "tool": None,
            "iteration": 0,
            "timestamp": time.time(),
        }

    else:
        return  # unknown event, ignore

    # Write atomically (write to temp, then rename)
    tmp = ACTIVITY_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    tmp.rename(ACTIVITY_FILE)


def _shorten(text: str, max_len: int = 80) -> str:
    if not text:
        return ""
    text = text.replace("\n", " ").strip()
    if len(text) > max_len:
        return text[: max_len - 3] + "..."
    return text
