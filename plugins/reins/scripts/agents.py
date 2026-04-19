"""Agent configuration registry for the harness orchestrator.

Each entry in AGENT_CONFIGS defines the tools, system prompt, transport mode,
and display metadata for one agent role.  The ``get_agent_options`` factory
converts a config entry into a ``ClaudeAgentOptions`` instance ready for use
with the claude-agent-sdk.
"""

from claude_agent_sdk import ClaudeAgentOptions

# ---------------------------------------------------------------------------
# Linus persona preamble (shared by agents that need the opinionated persona)
# ---------------------------------------------------------------------------
_LINUS_PREAMBLE = (
    "You are Linus, a senior software engineer with high standards for code quality, "
    "correctness, and maintainability.  You are direct, precise, and hold yourself and "
    "others to rigorous engineering discipline."
)

# ---------------------------------------------------------------------------
# Agent configuration registry
# ---------------------------------------------------------------------------
AGENT_CONFIGS: dict[str, dict] = {
    "Executor": {
        "model": "claude-sonnet-4-5",
        "transport": "session",
        "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "LSP"],
        "system_prompt": (
            f"{_LINUS_PREAMBLE}  "
            "Your role is to implement tasks precisely as specified.  "
            "You may read, write, edit, and run shell commands.  "
            "Always follow the acceptance criteria and write clean, tested code."
        ),
        "icon": "⚙️",
    },
    "Reviewer": {
        "model": "claude-sonnet-4-5",
        "transport": "session",
        "tools": ["Read", "Glob", "Grep", "Bash"],
        "system_prompt": (
            f"{_LINUS_PREAMBLE}  "
            "Your role is to review pull requests for correctness, style, and test coverage.  "
            "You have read-only access to source code.  Use Bash exclusively for "
            "'gh pr diff' and coverage report retrieval (enforced by hook).  "
            "Check Codecov reports and flag any coverage regression."
        ),
        "icon": "🔍",
    },
    "Tester": {
        "model": "claude-sonnet-4-5",
        "transport": "session",
        "tools": ["Bash"],
        "system_prompt": (
            "You are a dedicated test runner.  "
            "You have no access to source code — your only tool is Bash so you can "
            "execute the project's test suite and report results faithfully.  "
            "Do not attempt to read or modify files."
        ),
        "icon": "🧪",
    },
    "Planner": {
        "model": "claude-sonnet-4-5",
        "transport": "session",
        "tools": ["Read", "Glob", "Grep", "WebFetch"],
        "system_prompt": (
            "You are a technical planning agent.  "
            "Analyse the codebase and external resources to produce clear, actionable "
            "implementation plans.  Output structured plans with numbered steps, "
            "acceptance criteria, and risk notes.  Do not write or modify code."
        ),
        "icon": "📋",
    },
    "Designer": {
        "model": "claude-sonnet-4-5",
        "transport": "session",
        "tools": ["Read", "Bash", "Glob", "Grep", "WebFetch"],
        "system_prompt": (
            "You are a technical design agent.  "
            "Analyse requirements and existing code to produce architecture diagrams, "
            "API contracts, and data-model designs.  You may run shell commands to "
            "inspect the repo (e.g. directory listings, git log) but must not edit files."
        ),
        "icon": "🎨",
    },
    "Router": {
        "model": "claude-sonnet-4-5",
        "transport": "oneshot",
        "tools": [],
        "system_prompt": (
            "You are a routing agent.  "
            "Given a description of work completed and the current harness phase, "
            "output a JSON decision object that specifies the next phase and rationale.  "
            "Example: {\"next_phase\": \"TESTING\", \"reason\": \"implementation complete\"}.  "
            "Output only valid JSON — no prose, no markdown fences."
        ),
        "icon": "🔀",
    },
    "Verifier": {
        "model": "claude-sonnet-4-5",
        "transport": "oneshot",
        "tools": ["Read"],
        "system_prompt": (
            "You are a verification agent.  "
            "Read the acceptance criteria and the implementation artefacts, then "
            "determine whether all acceptance criteria are satisfied.  "
            "Output a JSON report: "
            "{\"passed\": true/false, \"failures\": [\"...\"], \"notes\": \"...\"}.  "
            "Output only valid JSON."
        ),
        "icon": "✅",
    },
}


def get_agent_options(agent_type: str) -> ClaudeAgentOptions:
    """Return a ``ClaudeAgentOptions`` instance for *agent_type*.

    Args:
        agent_type: One of the keys in ``AGENT_CONFIGS``.

    Returns:
        A configured ``ClaudeAgentOptions`` ready for ``claude_agent_sdk.query``.

    Raises:
        KeyError: If *agent_type* is not in ``AGENT_CONFIGS``.
    """
    config = AGENT_CONFIGS[agent_type]
    return ClaudeAgentOptions(
        model=config["model"],
        system_prompt=config["system_prompt"],
        allowed_tools=list(config["tools"]),
    )
