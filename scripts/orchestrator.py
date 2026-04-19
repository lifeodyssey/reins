"""Sprint orchestration module for managing card states and sprint planning."""

from dataclasses import dataclass, field


@dataclass
class CardState:
    """Represents the state of a card in a sprint."""

    id: int
    title: str
    slug: str
    wave: int
    acceptance_criteria: list[str] = field(default_factory=list)
    status: str = "todo"
    pr_number: int | None = None
    review_score: int | None = None
    test_score: int | None = None
    review_round: int = 0

    @property
    def branch(self) -> str:
        """Return the branch name for this card."""
        return f"card-{self.id}-{self.slug}"

    @property
    def agent_name(self) -> str:
        """Return the agent name assigned to this card."""
        return f"executor-{self.slug}"

    @property
    def is_terminal(self) -> bool:
        """Return True if card is in a terminal state."""
        return self.status in {"merged", "skipped", "blocked"}


@dataclass
class SprintPlan:
    """Represents a sprint plan with multiple cards organized by waves."""

    name: str
    cards: list[CardState] = field(default_factory=list)

    def get_wave(self, wave_num: int) -> list[CardState]:
        """Return all cards in a specific wave.

        Args:
            wave_num: The wave number to retrieve cards for.

        Returns:
            List of CardState objects matching the wave number.
        """
        return [card for card in self.cards if card.wave == wave_num]

    def wave_complete(self, wave_num: int) -> bool:
        """Check if all cards in a wave have reached terminal state.

        Args:
            wave_num: The wave number to check.

        Returns:
            True if all cards in the wave are in terminal state, False otherwise.
            Returns True for empty/nonexistent waves.
        """
        wave_cards = self.get_wave(wave_num)
        if not wave_cards:
            return True
        return all(card.is_terminal for card in wave_cards)

    @property
    def all_waves(self) -> list[int]:
        """Return sorted list of unique wave numbers in this sprint."""
        waves = set(card.wave for card in self.cards)
        return sorted(waves)


def compute_waves(cards: list[CardState]) -> dict[int, list[int]]:
    """Group card IDs by wave number.

    Args:
        cards: List of CardState objects to group.

    Returns:
        Dictionary mapping wave number to list of card IDs in that wave.
    """
    waves: dict[int, list[int]] = {}
    for card in cards:
        if card.wave not in waves:
            waves[card.wave] = []
        waves[card.wave].append(card.id)
    return waves


def render_sprint_board(plan: SprintPlan) -> str:
    """Render a markdown table representation of the sprint board.

    Args:
        plan: SprintPlan object to render.

    Returns:
        Markdown table string showing card details and statuses.
        Returns "No cards in sprint." if the plan has no cards.
    """
    if not plan.cards:
        return "No cards in sprint."

    # Status icon mapping
    status_icons = {
        "todo": "⬜",
        "executing": "🟡",
        "reviewing": "🔵",
        "testing": "🟣",
        "merged": "🟢",
        "blocked": "🔴",
        "skipped": "⚪",
    }

    # Build header
    lines = [
        "| Status | Title | Wave | Branch | Status | PR # | Review | Test |",
        "|--------|-------|------|--------|--------|------|--------|------|",
    ]

    # Add rows for each card
    for card in plan.cards:
        icon = status_icons.get(card.status, "❓")
        pr_str = str(card.pr_number) if card.pr_number is not None else "-"
        review_str = str(card.review_score) if card.review_score is not None else "-"
        test_str = str(card.test_score) if card.test_score is not None else "-"

        row = f"| {icon} | {card.title} | {card.wave} | {card.branch} | {card.status} | {pr_str} | {review_str} | {test_str} |"
        lines.append(row)

    return "\n".join(lines)
