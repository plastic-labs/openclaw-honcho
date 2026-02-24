# Multi-Peer Memory Gap: Subagent Sessions Missing Parent Peer

## Overview

In a multi-agent OpenClaw deployment, subagents (Forge, Scout, Ghostwriter, Sonar) are spawned
by a parent agent (Prime) to complete focused tasks. Each subagent session has a session key of
the form `agent:developer:subagent:<uuid>`, encoding the relationship to the parent.

The Honcho memory plugin is supposed to track observations across all peers — enabling the
dreaming process to consolidate cross-agent interactions into persistent conclusions that survive
across sessions.

This document describes a gap that prevented any agent-to-agent memory from forming, the root
cause, and the fix applied in this PR.

---

## Current State: What We Observed

After running in production with 6 configured peers:

| Peer ID            | Role              |
|--------------------|-------------------|
| `owner`            | Workspace owner   |
| `agent-prime`      | Primary agent     |
| `agent-developer`  | Forge (developer) |
| `agent-researcher` | Scout (research)  |
| `agent-ghostwriter`| Ghostwriter       |
| `agent-sonar`      | Sonar (search)    |

An audit of **all 500 conclusions** in the workspace revealed:

| Observer      | Observed | Count |
|---------------|----------|-------|
| `owner`       | `owner`  | 300   |
| `agent-prime` | `owner`  | 200   |
| all others    | —        | 0     |

**Every conclusion concerns the owner.** No cross-agent memory exists. Forge, Scout, Ghostwriter,
and Sonar spin up fresh every session with zero accumulated context about their working
relationship with Prime.

---

## The Gap: No Agent-to-Agent Memory

Honcho's dreaming process consolidates observations from shared sessions into conclusions. For
conclusions about the `agent-prime ↔ agent-developer` relationship to exist, both peers must be
present in at least one shared session.

In practice:

- **Main agent sessions** (e.g. `agent:prime:main`) → `addPeers([owner, agent-prime])` ✓
- **Subagent sessions** (e.g. `agent:developer:subagent:xxx`) → `addPeers([owner, agent-developer])` ✗

The parent agent (`agent-prime`) is **never added** to subagent sessions. Dreaming sees two
completely disjoint session graphs:

```
Session: agent:prime:main
  peers: owner, agent-prime
  → dreaming produces: owner↔agent-prime conclusions ✓

Session: agent:developer:subagent:xxx
  peers: owner, agent-developer
  → dreaming produces: owner↔agent-developer conclusions
  → NO agent-prime↔agent-developer conclusions (prime was never here) ✗
```

---

## Root Cause

In `index.ts`, the `agent_end` hook calls `session.addPeers()` with exactly two peers — the
workspace owner and the current agent — regardless of whether the session is a subagent session:

```typescript
// Before fix — only ever two peers
await session.addPeers([
  [OWNER_ID, { observeMe: true, observeOthers: false }],
  [agentPeer.id, { observeMe: true, observeOthers: true }],
]);
```

The function `extractParentAgentKey(sessionKey)` already exists and correctly parses the parent
agent from the session key (e.g. extracts `agent:prime` from
`agent:developer:subagent:xxx`). It is used only to store metadata — it was **never used in
`addPeers`**.

---

## Fix Applied

When `isSubagent` is `true`, resolve the parent agent peer and add it as a third peer:

```typescript
const peers: Parameters<typeof session.addPeers>[0] = [
  [OWNER_ID, { observeMe: true, observeOthers: false }],
  [agentPeer.id, { observeMe: true, observeOthers: true }],
];

if (isSubagent) {
  const parentKey = extractParentAgentKey(ctx.sessionKey);
  if (parentKey) {
    const parentAgentId = parentKey.replace(/^agent:/, '').replace(/:.*$/, '');
    const parentPeer = await getAgentPeer(parentAgentId);
    peers.push([parentPeer.id, { observeMe: true, observeOthers: true }]);
  }
}

await session.addPeers(peers);
```

Both `observeMe` and `observeOthers` are set to `true` for the parent peer so dreaming can
consolidate observations in **both directions**:

- `observer: agent-prime, observed: agent-developer` → Prime's conclusions about how Forge works
- `observer: agent-developer, observed: agent-prime` → Forge's conclusions about how Prime delegates

---

## Expected Behaviour After Fix

| Session type | Peers added | Conclusions produced |
|---|---|---|
| `agent:prime:main` | `owner`, `agent-prime` | `owner↔agent-prime` |
| `agent:developer:subagent:xxx` | `owner`, `agent-developer`, **`agent-prime`** | `owner↔agent-developer`, **`agent-prime↔agent-developer`** |

Over time, Prime will accumulate persistent memory about how each subagent performs, and each
subagent will accumulate memory about how Prime delegates — surviving across session restarts.

---

## Tests

A harness test (`__tests__/parent-peer-harness.test.ts`) instantiates the plugin with a mock
OpenClaw API context, fires the `agent_end` hook with a subagent-style session key, and then
queries Honcho directly to assert that `agent-prime` appears in the resulting session's peer list.

Before this fix: the third assertion (`agent-prime IS in session peers`) **failed** — proving the
bug. After this fix: all three assertions pass.

---

## Status: Under Observation

> ⚠️ **This patch is under observation.** The behaviour described above is the expected outcome,
> but the fix will be monitored for 24 hours in production before the PR is merged. Edge cases
> (e.g. deeply nested subagents, parent agents not yet mapped in workspace metadata) may require
> follow-up patches.

Do not merge until the observation period is complete.
