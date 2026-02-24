# Multi-Peer Memory Gap: Subagent Sessions Missing Parent Peer

## Overview

In a multi-agent OpenClaw deployment, worker agents (subagents) are spawned by a parent
orchestrator agent to complete focused tasks. Each subagent session has a session key of the form
`agent:developer:subagent:<uuid>`, encoding the relationship to the parent.

The Honcho memory plugin is supposed to track observations across all peers — enabling the
dreaming process to consolidate cross-agent interactions into persistent conclusions that survive
across sessions.

This document describes a gap that prevented any agent-to-agent memory from forming, the root
cause, and the fix applied in this PR.

---

## Current State: What We Observed

After running in production with multiple configured agent peers (an orchestrator and several
worker agents), an audit of all conclusions in the workspace revealed:

| Observer           | Observed | Count |
|--------------------|----------|-------|
| `owner`            | `owner`  | 300   |
| orchestrator agent | `owner`  | 200   |
| worker agents      | —        | 0     |

**Every conclusion concerns the owner.** No cross-agent memory exists. Worker agents (subagents)
spin up fresh every session with zero accumulated context about their working relationship with
the orchestrator.

---

## The Gap: No Agent-to-Agent Memory

Honcho's dreaming process consolidates observations from shared sessions into conclusions. For
conclusions about the `orchestrator ↔ worker` relationship to exist, both peers must be present
in at least one shared session.

In practice:

- **Orchestrator sessions** (e.g. `agent:prime:main`) → `addPeers([owner, orchestrator])` ✓
- **Subagent sessions** (e.g. `agent:developer:subagent:xxx`) → `addPeers([owner, worker])` ✗

The parent agent is **never added** to subagent sessions. Dreaming sees two completely disjoint
session graphs:

```
Session: agent:prime:main
  peers: owner, orchestrator
  → dreaming produces: owner↔orchestrator conclusions ✓

Session: agent:developer:subagent:xxx
  peers: owner, worker
  → dreaming produces: owner↔worker conclusions
  → NO orchestrator↔worker conclusions (orchestrator was never here) ✗
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
agent from the session key. It is used only to store metadata — it was **never used in
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

- `observer: orchestrator, observed: worker` → orchestrator's conclusions about how the subagent performs
- `observer: worker, observed: orchestrator` → subagent's conclusions about how the orchestrator delegates

---

## Expected Behaviour After Fix

| Session type | Peers added | Conclusions produced |
|---|---|---|
| Orchestrator main session | `owner`, `orchestrator` | `owner↔orchestrator` |
| Subagent session | `owner`, `worker`, **`orchestrator`** | `owner↔worker`, **`orchestrator↔worker`** |

Over time, the orchestrator will accumulate persistent memory about how each subagent performs,
and each subagent will accumulate memory about how the orchestrator delegates — surviving across
session restarts.

---

## Tests

A harness test (`__tests__/parent-peer-harness.test.ts`) instantiates the plugin with a mock
OpenClaw API context, fires the message hook with a subagent-style session key, and then queries
Honcho directly to assert that the parent agent appears in the resulting session's peer list.

Before this fix: the assertion that the parent peer is present **failed** — proving the bug.
After this fix: all assertions pass.

---

## Status: Under Observation

> ⚠️ **This patch is under observation.** The behaviour described above is the expected outcome,
> but the fix will be monitored for 24 hours in production before the PR is merged. Edge cases
> (e.g. deeply nested subagents, parent agents not yet mapped in workspace metadata) may require
> follow-up patches.

Do not merge until the observation period is complete.
