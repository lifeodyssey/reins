import json
from pathlib import Path
from datetime import datetime, timezone


class EventLog:
    """Append-only JSONL event logger for agent actions."""

    def __init__(self, path: str):
        """
        Initialize the event log.

        Args:
            path: Path to the JSONL file for storing events.
        """
        self.path = Path(path)

    def append(self, agent: str, action: str, **kwargs) -> None:
        """
        Append an event to the log.

        Args:
            agent: Name or identifier of the agent.
            action: Action or event type.
            **kwargs: Additional fields to store with the event.
        """
        # Create parent directories if they don't exist
        self.path.parent.mkdir(parents=True, exist_ok=True)

        # Build the event object
        event = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "agent": agent,
            "action": action,
            **kwargs,
        }

        # Append as JSONL (one JSON object per line)
        with open(self.path, "a") as f:
            f.write(json.dumps(event) + "\n")

    def read_all(self) -> list[dict]:
        """
        Read all events from the log.

        Returns:
            List of event dictionaries, or empty list if file doesn't exist.
        """
        if not self.path.exists():
            return []

        events = []
        with open(self.path, "r") as f:
            for line in f:
                line = line.strip()
                if line:  # Skip empty lines
                    events.append(json.loads(line))

        return events
