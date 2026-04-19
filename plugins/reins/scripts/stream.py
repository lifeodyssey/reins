"""Stream proxy: formats ClaudeSDKClient messages for Gradio display."""

import json
from claude_agent_sdk import (
    AssistantMessage, ResultMessage, SystemMessage,
    UserMessage, TextBlock, ToolUseBlock, ToolResultBlock,
    ThinkingBlock, RateLimitEvent,
)


def format_sdk_message(msg, agent_name: str) -> str | None:
    """Format a single SDK stream message for Gradio chat display.
    Returns formatted string or None (skip this message).
    """
    if isinstance(msg, AssistantMessage):
        parts = []
        for block in msg.content:
            if isinstance(block, ThinkingBlock):
                text = block.thinking[:300]
                suffix = "..." if len(block.thinking) > 300 else ""
                parts.append(f"💭 *{text}{suffix}*")
            elif isinstance(block, TextBlock):
                parts.append(block.text)
            elif isinstance(block, ToolUseBlock):
                input_str = json.dumps(block.input, ensure_ascii=False)
                if len(input_str) > 150:
                    input_str = input_str[:147] + "..."
                parts.append(f"🔧 **{block.name}**\n```json\n{input_str}\n```")
        return "\n\n".join(parts) if parts else None

    if isinstance(msg, UserMessage):
        for block in msg.content:
            if isinstance(block, ToolResultBlock):
                content = str(block.content)[:500]
                if block.is_error:
                    return f"❌ **Error:**\n```\n{content}\n```"
                return f"```\n{content}\n```"
        return None

    if isinstance(msg, ResultMessage):
        duration = f" ({msg.duration_ms / 1000:.1f}s)" if msg.duration_ms else ""
        turns = f", {msg.num_turns} turns" if msg.num_turns else ""
        if msg.is_error:
            return f"⚠️ **Ended:** `{msg.subtype}`{duration}{turns}"
        return f"✅ **Done**{duration}{turns}"

    if isinstance(msg, SystemMessage):
        if msg.subtype == "init":
            return "📂 Session started"
        return None

    if isinstance(msg, RateLimitEvent):
        return None

    return None
