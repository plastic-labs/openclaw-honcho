/**
 * Pure helper functions — no mutable state dependencies.
 */

import type { Peer, MessageInput } from "@honcho-ai/sdk";

/**
 * Build a Honcho session key from OpenClaw context.
 * Combines sessionKey + messageProvider to create unique sessions per platform.
 * Uses hyphens as separators (Honcho requires hyphens, not underscores).
 */
export function buildSessionKey(ctx?: { sessionKey?: string; messageProvider?: string }): string {
  const baseKey = ctx?.sessionKey ?? "default";
  const provider = ctx?.messageProvider ?? "unknown";
  const combined = `${baseKey}-${provider}`;
  return combined.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function isSubagentSession(ctx?: { sessionKey?: string }): boolean {
  return (ctx?.sessionKey ?? "").includes(":subagent:");
}

export function extractParentAgentKey(sessionKey?: string): string | undefined {
  const match = sessionKey?.match(/^(agent:[^:]+):subagent:/);
  return match?.[1] ?? undefined;
}

/**
 * Strip OpenClaw's metadata tags and injected context from message content.
 * Removes:
 * - Platform headers: [Telegram Name id:123456 timestamp]
 * - Message IDs: [message_id: xxx]
 * - Honcho memory blocks: <honcho-memory>...</honcho-memory>
 */
export function cleanMessageContent(content: string): string {
  let cleaned = content;
  cleaned = cleaned.replace(/<honcho-memory[^>]*>[\s\S]*?<\/honcho-memory>\s*/gi, "");
  cleaned = cleaned.replace(/<!--[^>]*honcho[^>]*-->\s*/gi, "");
  cleaned = cleaned.replace(/^\[\w+\s+.+?\s+id:\d+\s+[^\]]+\]\s*/, "");
  cleaned = cleaned.replace(/\s*\[message_id:\s*[^\]]+\]\s*$/, "");
  cleaned = cleaned.replace(/\[\[[^\]]*\]\]\s*/g, "");
  return cleaned.trim();
}

export function extractMessages(
  rawMessages: unknown[],
  ownerPeer: Peer,
  agentPeer: Peer
): MessageInput[] {
  const result: MessageInput[] = [];

  for (const msg of rawMessages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const role = m.role as string | undefined;

    if (role !== "user" && role !== "assistant") continue;

    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content
        .filter(
          (block: unknown) =>
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>).type === "text"
        )
        .map((block: unknown) => (block as Record<string, unknown>).text)
        .filter((t): t is string => typeof t === "string")
        .join("\n");
    }

    content = cleanMessageContent(content);
    content = content.trim();

    if (content) {
      const peer = role === "user" ? ownerPeer : agentPeer;
      result.push(peer.message(content));
    }
  }

  return result;
}
