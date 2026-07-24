export function canonicalConversationTarget(value: string | undefined, channel?: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const prefix = channel?.trim().toLowerCase();
  if (prefix && normalized.toLowerCase().startsWith(`${prefix}:`)) {
    const unprefixed = normalized.slice(prefix.length + 1).trim();
    return unprefixed || undefined;
  }
  return normalized;
}
