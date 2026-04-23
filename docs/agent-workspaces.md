# Per-agent workspaces

`openclaw-honcho` supports routing each OpenClaw agent to its own Honcho
workspace via an optional `agentWorkspaces` config field. This is useful
for multi-agent setups where you want memory isolation between clusters
of agents (for example, a personal-assistant cluster and an
operations-assistant cluster) while still sharing the same plugin
installation.

## Configuration

Add `agentWorkspaces` to the plugin config as an `agentId → workspaceId`
map. Agents listed there read/write memory in the named workspace;
agents not listed fall back to the top-level `workspaceId`.

```json
{
  "plugins": {
    "entries": {
      "openclaw-honcho": {
        "config": {
          "workspaceId": "openclaw",
          "agentWorkspaces": {
            "personal": "personal_workspace",
            "manager": "ops_workspace",
            "developer": "personal_workspace"
          }
        }
      }
    }
  }
}
```

Agent IDs are normalized to lowercase, so `Personal` and `personal`
resolve to the same entry. Workspace IDs are passed through to the
Honcho SDK unchanged.

## How routing works

- The plugin maintains one `Honcho` client, one owner peer, and one
  agent-peer cache **per resolved workspace**. Clients are created on
  first use and reused thereafter.
- Every hook, tool, and CLI call resolves the workspace via the caller's
  `agentId`, so two agents pointed at different workspaces never share
  state.
- Two agents pointed at the same workspace (for example `personal` and
  `developer` both mapped to `personal_workspace` above) share the same
  Honcho client, owner peer, and session space — so cross-agent memory
  in a single workspace keeps working the way it does today.

## Session-key resolution

The plugin builds Honcho session keys from both `ctx.messageProvider`
(hook context) and `ctx.messageChannel` (tool context). This means that
`honcho_session`, `memory_search`, and `memory_get` read the same
session slot the capture hook writes to, regardless of which context
shape the host runtime exposes.

## Backward compatibility

When `agentWorkspaces` is absent (or an empty object), every agent
resolves to the top-level `workspaceId` — exactly the same behaviour as
earlier releases. No migration is required to adopt this feature, and
existing single-workspace deployments are unaffected.
