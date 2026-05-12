# Spec: Honcho session-identity redesign

Status: draft
Owner: abigail
Related: #64, #76, #86, #87

## Problem

`helpers.ts:buildSessionKey()` synthesizes the Honcho session ID directly from `ctx.sessionKey + "-" + ctx.messageProvider`, sanitized to `[a-zA-Z0-9-]`. That single string is used as both the routing identifier passed to OpenClaw memory tools *and* the persistence identity inside Honcho. Four bugs fall out of that conflation:

1. **Length overflow.** Cron `sessionKey`s (`agent:main:cron:<job>:run:<run>`) exceed Honcho's 100-char session-id limit (#86, partially addressed by #76).
2. **Reset/continuity bugs.** `/new` and `/reset` reuse the same Honcho session because the routing key is unchanged across lifecycle boundaries (#64).
3. **Transport leakage.** `messageProvider` ends up in the persistence identity. A canonical OpenClaw `sessionKey` like `agent:main:telegram:user-1` already encodes transport, making the suffix redundant — and the `-unknown` fallback fragments memory whenever `ctx.messageProvider` is missing.
4. **Semantic instability.** Persistence identity currently depends on OpenClaw routing-key formatting details (`messageProvider`, normalization, canonical-key shape). Peer-level memory continuity still exists, but session-scoped continuity and retrieval semantics can silently fragment when upstream naming changes.

The root cause (per hermes review): **OpenClaw `sessionKey` is a topology/routing descriptor, not a persistence identifier.** OpenClaw itself distinguishes `sessionKey` (routing) from `sessionId` (lifecycle/transcript instance — see upstream `session-files.ts` and `session-key-utils.ts`). The Honcho plugin currently treats `sessionKey` as both, which is the underlying architectural mismatch.

## Goals

- Honcho session IDs are stable, length-bounded, and decoupled from OpenClaw's routing-key DSL.
- DM / channel / agent memory continuity is preserved across `/new`, `/reset`, reconnects, and provider-name churn.
- Cron-run isolation is preserved (already encoded in upstream sessionKey).
- Full OpenClaw routing/lifecycle context is recoverable from Honcho session metadata.

## Non-goals

- No new conversation-instance product. Honcho continues to model long-term continuity per topology, not per transcript instance. Tracking transcript instances is a metadata concern, not an identity concern.
- No change to `peers.ts`, peer resolution, or sender-id extraction.
- No change to the `qmd` memory-backend wire shape exposed to OpenClaw.
- No change to how OpenClaw constructs its own `sessionKey`s.

## Design

### New identity scheme

Session ids take the shape `<sessionClass>-[<provider>-]<agentId>-<24 hex>`. Examples:

```
chat-discord-main-9d84af2baf0d7d53488c98af        // Discord DM, default agent
chat-telegram-main-ff52d682525dc87aa87ced6b       // Telegram DM
chat-discord-research-c3eebe44beeca171b0279d27    // Same channel, different agent
cron-main-be1262df36967a5d4a20e565                // Cron run; provider segment elided
subagent-main-1f7470ea5ee5ceb03ef17a30            // Subagent; provider segment elided
thread-discord-main-aadcdb43419814a481b31734      // Thread under a Discord group
```

All variants stay well under Honcho's 100-char cap (longest case is ~46 chars).

```ts
// helpers.ts
import { createHash } from "node:crypto";

const SESSION_ID_DIGEST_LEN = 24;

export function normalizeSessionKey(raw?: string): string {
  return (raw ?? "default").trim();
}

/**
 * Provider extracted from the canonical OpenClaw sessionKey
 * (segment after `agent:<agentId>:`), NOT from `ctx.messageProvider`.
 * The latter is unstable (missing → "unknown", subject to normalization
 * drift); the former is a slice of the same data we're hashing, so it
 * cannot disagree with the hash.
 */
function extractProvider(sessionKey: string): string | null {
  const m = /^agent:[^:]+:([^:]+)/.exec(sessionKey);
  return m ? m[1] : null;
}

export function buildSessionKey(ctx?: {
  sessionKey?: string;
  agentId?: string;
}): string {
  const normalized = normalizeSessionKey(ctx?.sessionKey);
  const sessionClass = classifySession(normalized);
  const agentId = ctx?.agentId ?? "main";
  const provider = extractProvider(normalized);
  // Elide provider for cron/subagent — that slot in their sessionKey
  // holds the session class itself, so it would just duplicate the prefix.
  const includeProvider =
    provider && sessionClass !== "cron" && sessionClass !== "subagent";

  const digest = createHash("sha256")
    .update(`${agentId}\0${normalized}`)
    .digest("hex")
    .slice(0, SESSION_ID_DIGEST_LEN);

  const parts = [sessionClass];
  if (includeProvider) parts.push(provider!);
  parts.push(agentId, digest);
  return parts.join("-");
}
```

Key decisions:

- No `hc-` namespace prefix. The workspace itself is plugin-owned (`workspaceId` defaults to `"openclaw"`), so a per-id marker conveys no information once every id has it.
- Prefix segments (`sessionClass`, `agentId`, sometimes `provider`) are *cosmetic at the structural level but stable at the input level*: each is either derived from the routing key's own shape (`sessionClass`, `provider`) or from agent config (`agentId`). They cannot drift independently of the hash because they're derived from the same inputs the hash sees.
- `ctx.messageProvider` is **not** an input to the id. It's the unstable field (`unknown` fallback, normalization drift) and stays in metadata only.
- `provider` is elided for cron/subagent sessions because position-3 of their `sessionKey` is the session class, not a transport — including it would produce `cron-cron-…` / `subagent-subagent-…`.
- `sessionId` is metadata only; continuity remains the default.
- Cron keys already encode run isolation via `:run:<id>`; nothing additional needed in the hash.
- Hash component is 24 hex chars (96 bits) of SHA-256 over `agentId\0normalizedSessionKey`. Collision-safe for the scope; constant length.

### Metadata schema

Every Honcho session created by this plugin carries:

```jsonc
{
  "agentId": "main",
  "openclawSessionKey": "agent:main:discord:group:123",
  "sessionClass": "chat" | "cron" | "subagent" | "thread" | "unknown",
  "messageProvider": "discord",
  "lastSessionId": "uuid-of-most-recent-transcript",
  "participantSenderId": "...",
  "isSubagent": true,
  "parentPeerId": "...",
  "lastSavedIndex": 42
}
```

`sessionClass` is derived using upstream OpenClaw helpers (`isCronRunSessionKey`, `isSubagentSessionKey`, `parseThreadSessionSuffix`) instead of plugin-local string matching.

### Subagent policy

Subagent sessions (`:subagent:`) remain captured (consistent with current behavior + #82) but are marked `sessionClass: "subagent"` and `isSubagent: true`. A follow-up task (out of scope for this spec) may add a config flag to skip persistence or route subagent transcripts to a separate workspace. Not blocking on that decision here.

### Call-site changes

`buildSessionKey()` signature changes from `(ctx?: { sessionKey?; messageProvider? })` to `(ctx?: { sessionKey?; agentId? })`. The `messageProvider` parameter is dropped at every call site. Call sites to update:

- `runtime.ts:260` — `resolveHonchoMemoryBackendConfig`
- `hooks/capture.ts:26,165`
- `hooks/context.ts:10`
- `tools/ask.ts:46`, `tools/context.ts:38`, `tools/search.ts:53`, `tools/message-search.ts:104`, `tools/memory-passthrough.ts:101,141`, `tools/session.ts:64`

Tools/hooks that today read `ctx.messageProvider` continue to receive it from OpenClaw; they just stop forwarding it to `buildSessionKey`. Where it's still useful (e.g., capture metadata), it's written into session metadata instead.

`flushMessages()` in `hooks/capture.ts` is updated to:

1. Build the new session id via `buildSessionKey`.
2. On session creation/update, write the metadata block above.
3. Update `lastSessionId` when `ctx.sessionId` changes.

### Memory backend descriptor

`resolveHonchoMemoryBackendConfig` keeps its current shape but the returned `sessionKey` is the new `<class>-[<provider>-]<agent>-<hash>` form. OpenClaw treats it as opaque, so no upstream changes are required.

## Compatibility

The cutover is forward-only: no dual-read, no in-place rewriting of existing Honcho sessions. After upgrade, each routing scope's first message produces a new session id (in the `<class>-[<provider>-]<agent>-<hash>` shape) that starts empty. Pre-upgrade sessions remain in the workspace under their legacy ids, still readable by workspace-wide search (`crossSessionSearch: true`, the default). Peer-scoped surfaces — `honcho_ask`, `honcho_context`, conclusions — are unaffected because they key off peers, not session ids, and peers carry the user's long-term memory across the cutover. The two concrete things that reset on upgrade are `honcho_session` (the active-session transcript) and scoped search under `crossSessionSearch: false`; both repopulate as the new session accumulates messages. Note this in the changelog when the cutover ships.

## Open questions

1. Should `/new` optionally force a new Honcho session via config (`honcho.resetOnNew`)? Default remains continuity.
2. Should subagent sessions eventually get separate persistence policy/workspace routing?

## Test plan

New tests in `test/helpers.test.ts`:

- Length: a 500-char cron sessionKey produces an id well under the 100-char cap.
- Shape: chat ids match `/^chat-[a-z0-9]+-[a-z0-9_-]+-[0-9a-f]{24}$/` (class, provider, agent, hash); cron/subagent ids match `/^(cron|subagent)-[a-z0-9_-]+-[0-9a-f]{24}$/` (provider segment elided); unknown-class ids fall back to `unknown-<agent>-<hash>`.
- Stability: same `sessionKey` + `agentId` → bit-identical id across calls.
- `ctx.messageProvider` is not an input: same `sessionKey` + `agentId` with any value of `ctx.messageProvider` (including `undefined`, `"unknown"`, mismatched values) → same id.
- Provider extraction comes from `sessionKey`: a sessionKey `agent:main:telegram:user-1` produces a `chat-telegram-…` id regardless of what `ctx.messageProvider` says.
- Cron isolation: `…:cron:job:run:1` and `…:cron:job:run:2` produce different ids; both have the `cron-main-` prefix and no duplicated `cron-cron-` segment.
- Agent scoping: same `sessionKey`, two different `agentId`s → two different ids that share the same `<class>[-<provider>]` prefix and differ in both the agent segment and the hash.
- Continuity: same `sessionKey` + `agentId` with different `ctx.sessionId` values → same id (sessionId is metadata only).
- `classifySession`: cron / subagent / thread / chat / unknown cases — uses upstream OpenClaw helpers (`isCronRunSessionKey`, `isSubagentSessionKey`, `parseThreadSessionSuffix`).

New tests in `test/runtime.test.ts` / `test/capture.test.ts` (new file):

- `flushMessages` writes `openclawSessionKey`, `sessionClass`, and `lastSessionId` to metadata.
- `participantSenderId` continues to be set.

Manual / integration checks:

- `/new` in a Discord channel: subsequent turns continue to surface prior conclusions via `honcho_ask`.
- Long-running cron job: each run isolated; no length errors in logs.
- Subagent invocation: parent agent's session is untouched; subagent session marked correctly.

## Out of scope

- PR #76 (length truncation only). This spec supersedes it. If #76 is already merged when this lands, the new `buildSessionKey` replaces it cleanly; if not, close #76 in favor of this work.
- Honcho-side changes (server, schema, SDK).
- Upstream OpenClaw changes to `sessionKey` / `sessionId` semantics.

## Rollout

1. Add the new helpers (`normalizeSessionKey`, `classifySession`, `extractProvider`, and a new structured-id builder) alongside the existing `buildSessionKey`, fully unit-tested. No call-site changes. Pure addition.
2. Cut `buildSessionKey` over to the new structured-id implementation, drop `messageProvider` from its signature, and update the ten call sites in `runtime.ts`, `hooks/*`, and `tools/*`. From this release on, all new sessions use the new scheme.
3. Enrich `flushMessages` metadata writes with `openclawSessionKey`, `sessionClass`, `messageProvider`, and `lastSessionId`. Independent of identity; can land before or after step 2.
4. Remove the dead `startsWith` branch in `runtime.ts:matchesSessionScope()`. New-scheme ids share *cosmetic* prefixes (e.g. `chat-discord-main-`) but the hash suffix differs per session, so no real id is a prefix of another — the branch can't match anything the plugin writes.
5. (Optional follow-up) `honcho.resetOnNew` config knob — when true, `before_reset` rotates to a fresh id derived from `sessionKey + sessionId`. Default off.
