/**
 * Stream proxy: formats claude-agent-sdk messages for UI display.
 *
 * SDK message types:
 *   SDKAssistantMessage  — { type:'assistant', message: BetaMessage }
 *   SDKUserMessage       — { type:'user', message: MessageParam }
 *   SDKResultMessage     — { type:'result', subtype:'success'|'error', ... }
 *   SDKSystemMessage     — { type:'system', subtype:'init', ... }
 *   SDKRateLimitEvent    — { type:'rate_limit_event', ... }
 */

export function formatSdkMessage(msg: any, _agentName: string): string | null {
  if (msg.type === "assistant") {
    const parts: string[] = [];
    // msg.message is a BetaMessage; content blocks are in msg.message.content
    for (const block of msg.message?.content ?? []) {
      if (block.type === "thinking") {
        const text = (block.thinking ?? "").slice(0, 300);
        const suffix = (block.thinking ?? "").length > 300 ? "..." : "";
        parts.push(`\u{1F4AD} *${text}${suffix}*`);
      } else if (block.type === "text") {
        parts.push(block.text);
      } else if (block.type === "tool_use") {
        let inputStr = JSON.stringify(block.input ?? {});
        if (inputStr.length > 150) inputStr = inputStr.slice(0, 147) + "...";
        parts.push(`\u{1F527} **${block.name}**\n\`\`\`json\n${inputStr}\n\`\`\``);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  // UserMessage — tool results
  if (msg.type === "user") {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          const text = String(block.content ?? "").slice(0, 500);
          if (block.is_error) {
            return `\u274C **Error:**\n\`\`\`\n${text}\n\`\`\``;
          }
          return `\`\`\`\n${text}\n\`\`\``;
        }
      }
    }
    return null;
  }

  // ResultMessage
  if (msg.type === "result") {
    const duration = msg.duration_ms ? ` (${(msg.duration_ms / 1000).toFixed(1)}s)` : "";
    const turns = msg.num_turns ? `, ${msg.num_turns} turns` : "";
    if (msg.is_error) {
      return `\u26A0\uFE0F **Ended:** \`${msg.subtype}\`${duration}${turns}`;
    }
    return `\u2705 **Done**${duration}${turns}`;
  }

  // SystemMessage
  if (msg.type === "system") {
    if (msg.subtype === "init") return "\uD83D\uDCC2 Session started";
    return null;
  }

  // Ignore rate limits, status, hooks, etc.
  return null;
}
