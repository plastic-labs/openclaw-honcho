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
 * Strip Honcho's own injected context from message content to prevent
 * feedback loops (context injected -> saved -> re-injected -> grows forever).
 * Also strips leading OpenClaw reply directive tags (e.g. [[reply_to_current]])
 * so control tokens are never persisted or re-surfaced as user-visible text.
 * Other metadata (platform headers, message IDs, etc.) is preserved as
 * useful provenance data for Honcho's memory layer.
 */
export function cleanMessageContent(content: string): string {
  let cleaned = content;
  cleaned = cleaned.replace(/<honcho-memory[^>]*>[\s\S]*?<\/honcho-memory>\s*/gi, "");
  cleaned = cleaned.replace(/<!--[^>]*honcho[^>]*-->\s*/gi, "");
  cleaned = cleaned.replace(
    /^(\s*\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\]\s*)+/gi,
    ""
  );
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
