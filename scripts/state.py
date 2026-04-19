"""Harness state machine: Phase enum, AgentSession."""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class Phase(Enum):
    IDLE = "idle"
    PLANNING = "planning"
    AWAITING_SPEC_APPROVAL = "spec_approval"
    DESIGNING = "designing"
    AWAITING_CARD_APPROVAL = "card_approval"
    EXECUTING = "executing"
    VERIFYING = "verifying"
    ROUTING = "routing"
    REVIEWING = "reviewing"
    TESTING = "testing"
    MERGING = "merging"
    ESCALATED = "escalated"
    COMPLETE = "complete"

    @property
    def is_terminal(self) -> bool:
        return self in (Phase.COMPLETE, Phase.ESCALATED)


@dataclass
class AgentSession:
    name: str
    agent_type: str
    client: Any = None
    status: str = "idle"
    last_tool: str = "-"
    last_activity: str = "-"
    message_count: int = 0
    chat_history: list = field(default_factory=list)
    log: list = field(default_factory=list)
    is_streaming: bool = False

    def record(self, action: str, detail: str = ""):
        ts = datetime.now().strftime("%H:%M:%S")
        self.last_activity = f"{ts} {action}"
        self.log.append({"ts": ts, "action": action, "detail": detail[:150]})
        if len(self.log) > 100:
            self.log = self.log[-100:]
