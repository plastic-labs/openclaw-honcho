# Honcho Memory Plugin for OpenClaw

[![Honcho Banner](./assets/honcho_claw.png)](https://honcho.dev)

AI-native memory with dialectic reasoning for OpenClaw. Uses [Honcho's](https://honcho.dev) peer paradigm to build and maintain separate models of the user and the agent — enabling context-aware conversations that improve over time. No local infrastructure required.

This README describes plugin version **1.5.2** plus the multi-workspace routing implementation on this development branch. Do not deploy this branch over an existing installation until the rollout checks below pass in staging.

This plugin uses OpenClaw's slot system (`kind: "memory"`) to replace the built-in memory plugins (`memory-core`, `memory-lancedb`). During setup, existing memory files can be migrated to Honcho. Workspace docs (`SOUL.md`, `AGENTS.md`, `BOOTSTRAP.md`) can be updated manually to reference Honcho's tools instead of the old file-based system.

## Install

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
openclaw honcho setup
openclaw gateway restart
```

`openclaw honcho setup` prompts for your Honcho API key, writes the config, and optionally uploads legacy memory files to Honcho. In a routed installation, migrate one agent/workspace at a time with explicit `--agent` and, when needed, the operator-only `--workspace` override.

<details>
<summary>Alternative: ClawHub Skill</summary>

Use the `honcho-setup` skill to run migration interactively from within a chat session:

```bash
# 1. Install the skill
npx clawhub install honcho-setup
# 2. Restart OpenClaw to pick up the new skill
# 3. Install the plugin
openclaw plugins install @honcho-ai/openclaw-honcho
# 4. Restart the gateway
openclaw gateway restart
# 5. Open an agent session and invoke the skill
#    The skill will prompt for your Honcho API key and run setup interactively
```
</details>

## Migrating Legacy Memory

If you have existing workspace memory files (`USER.md`, `MEMORY.md`, `IDENTITY.md`, `memory/`, `canvas/`, etc.), `openclaw honcho setup` will detect them and offer to migrate them.

Migration is **non-destructive** — files are uploaded to Honcho. Originals are never deleted or moved.

For multi-workspace installs, run a separate migration for every destination:

```bash
openclaw honcho setup --agent main --workspace melia-ruslan
openclaw honcho setup --agent silva --workspace silva-work
openclaw honcho setup --agent masha --workspace masha-anya
```

`--workspace` is accepted only by `setup`; it is an explicit operator-controlled upload destination and takes precedence over the agent mapping for that one migration run. It does not change runtime routing. When more than one OpenClaw agent is configured, pair it with `--agent` so files from different agents cannot be mixed. Routing is validated before a Honcho client or upload session is created.

Upload resume entries are stored in `~/.openclaw/.upload-manifest.json` and are scoped by API endpoint, workspace, target peer, and canonical file path. A successful upload to one workspace never marks the same file complete in another workspace.

### Legacy files

**User/owner files** (content describes the user):
- `USER.md`

**Agent/self files** (content describes the agent):
- `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `TOOLS.md`, `BOOTSTRAP.md`, `MEMORY.md`
- Files in that agent workspace's `memory/` and `canvas/` directories

### Upload to Honcho

Files are uploaded via `session.uploadFile()`. User/owner files go to the owner peer; agent/self files go to the agent peer (`agent-{agentId}`, e.g. `agent-main`).

### Update workspace docs

The plugin ships template files in `node_modules/@honcho-ai/openclaw-honcho/workspace_md/`. Copy or merge these templates into your workspace for `AGENTS.md`, `SOUL.md`, and `BOOTSTRAP.md`. These templates reference the Honcho tools (`honcho_context`, `honcho_search_conclusions`, `honcho_ask`, `honcho_search_messages`, `honcho_session`) instead of the old file-based memory system.

## Configuration

Run `openclaw honcho setup` to configure interactively, or set values directly in `~/.openclaw/openclaw.json` under `plugins.entries["openclaw-honcho"].config`.

| Key                    | Type       | Default                    | Description                               |
| ---------------------- | ---------- | -------------------------- | ----------------------------------------- |
| `apiKey`               | `string`   | —                          | Honcho API key (required for managed; omit for self-hosted). |
| `workspaceId`          | `string`   | `"openclaw"`               | Honcho workspace ID for memory isolation. |
| `workspaceIdByAgent`   | `object`   | `{}`                        | Explicit agent-wide routes, keyed by normalized OpenClaw agent ID. |
| `workspaceRoutingRules` | `array`   | `[]`                        | Trusted host-metadata rules for channel/account/destination/chat/thread/session routing. |
| `strictWorkspaceRouting` | `boolean` | `false`                    | Deny an unknown route before any state or Honcho access. |
| `baseUrl`              | `string`   | `"https://api.honcho.dev"` | API endpoint (for self-hosted instances). |
| `noisePatterns`        | `string[]` | built-in defaults          | Patterns to skip messages. User-provided patterns are merged with built-in defaults (unless `disableDefaultNoisePatterns` is set). |
| `disableDefaultNoisePatterns` | `boolean` | `false`           | When `true`, built-in noise patterns are not applied — only `noisePatterns` entries are used. |
| `crossSessionSearch`   | `boolean`  | `true`                     | Default scope for `memory_search`. `true` = results span every session the participant peer has written to; `false` = scope to the active session. `memory_search` accepts an optional `crossSessionSearch` boolean parameter to override this per-call. |
| `ownerObserveOthers`   | `boolean`  | `false`                    | Whether the owner peer observes agent messages in Honcho's social model. |

### Multi-workspace routing

```json
{
  "plugins": {
    "entries": {
      "openclaw-honcho": {
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "workspaceId": "openclaw-legacy",
          "workspaceIdByAgent": {
            "main": "melia-ruslan",
            "silva": "silva-work",
            "masha": "masha-anya"
          },
          "workspaceRoutingRules": [
            {
              "agentId": "main",
              "channel": "telegram",
              "conversationTarget": "work-group-id",
              "workspaceId": "silva-work"
            }
          ],
          "strictWorkspaceRouting": true
        }
      }
    }
  }
}
```

Runtime precedence is deterministic:

1. An existing immutable `sessionKey → workspaceId` binding is authoritative. Later conflicting trusted metadata is denied; sessions are never rebound.
2. A matching `workspaceRoutingRules` entry selects the initial workspace. If matching rules name different workspaces, routing is denied as ambiguous.
3. A child session inherits its requester's immutable workspace. The child agent's ordinary agent mapping cannot displace that inherited route.
4. `workspaceIdByAgent` supplies the agent-wide route.
5. The legacy `workspaceId` fallback is allowed only for an explicit safe single-workspace configuration: no routing fields, non-strict mode; or an explicit `strictWorkspaceRouting: false` opt-in alongside routing fields. `strictWorkspaceRouting: true` always fails closed.

Rules match only trusted OpenClaw host context. Model/tool arguments cannot select a workspace. Use `conversationTarget` for a channel-local chat/conversation: the resolver canonicalizes hook `chatId` and tool `deliveryContext.to` (including a redundant `channel:` prefix) to this single identity. The older `chatId`, `channelId`, and `destination` rule keys remain accepted as compatibility aliases, but must not be combined with conflicting values. Account/thread rules are safe only when the initial trusted surface supplies those fields; an existing explicit binding is never contradicted merely because a later surface omits them, while later conflicting explicit metadata still fails closed.

OpenClaw **2026.7.1-2** requires the entry-level `plugins.entries.openclaw-honcho.hooks.allowConversationAccess=true` permission for this non-bundled plugin's primary `agent_end` capture hook. `openclaw honcho setup` establishes that narrow permission without changing other hook permissions. Manual configurations must include it exactly as shown above; otherwise the plugin can load while conversation capture remains blocked.

The registered OpenClaw memory runtime receives only `agentId`, not trusted session/chat/destination context. It is therefore available only when that agent has one unambiguous agent-wide workspace. If an agent spans workspaces through routing rules, use the session-scoped Honcho tools; the generic memory runtime remains unavailable/fail-closed.

### Self-Hosted / Local Honcho

Run `openclaw honcho setup`, enter a blank API key, and set the Base URL to your instance (e.g., `http://localhost:8000`).

For setting up a local Honcho server, see the [Honcho local development guide](https://github.com/plastic-labs/honcho?tab=readme-ov-file#local-development).

### Noise Filtering

The plugin automatically drops messages that match noise patterns before saving to Honcho. Built-in defaults filter:

- `HEARTBEAT_OK` — assistant heartbeat acknowledgments
- `A scheduled reminder has been triggered` — cron reminder boilerplate
- `Execute your Session Startup sequence now` — session startup commands
- `Queued messages from` — queued message wrapper headers

Add custom patterns via `noisePatterns` in your config:

```json
{
  "plugins": {
    "entries": {
      "openclaw-honcho": {
        "config": {
          "noisePatterns": ["my custom noise string"]
        }
      }
    }
  }
}
```

Custom patterns are merged with the built-in defaults. Each pattern matches if the message **equals** it or **starts with** it. Patterns starting with `/` are treated as anchored regex (e.g., `/^HEARTBEAT/i`).

### Owner Peer Observation

Honcho's `observeOthers` controls whether a peer forms representations of other peers based on messages it witnessed in shared sessions. The agent peer always has `observeOthers: true` — it sees and reasons about the user's messages. The owner (user) peer defaults to `observeOthers: false` — modeled only from what the user said, not what the agent replied.

Set `ownerObserveOthers: true` to let the owner peer also observe agent messages. This gives Honcho perspective-aware memory: the owner stores conclusions about the agent based only on what it witnessed, enabling the user's representation to reflect the full conversational context rather than just their own side of it.

### Peer Mappings

Map `sender_id` → Honcho peer ID in `~/.honcho/openclaw-peers.json` (override with `OPENCLAW_HONCHO_PEERS_FILE`). New senders are added automatically; edit `peers` to alias or merge identities, then **`openclaw gateway restart`** so the gateway reloads the file.

```json
{
  "version": 1,
  "defaultUnknownPolicy": "per-sender",
  "peers": {
    "U0EXAMPLE01": "user",
    "telegram-1234567890": "user"
  }
}
```

- **`defaultUnknownPolicy`** controls how unknown `sender_id`s are seeded into `peers`:
  - `per-sender` — default for fresh installs. Each new sender becomes its own peer; the seeded peer ID is the `sender_id` sanitized to `[A-Za-z0-9_-]` and truncated to Honcho's 100-char limit.
  - `owner` — default for pre-existing files missing the field (preserves legacy behavior). All unknown senders merge into the owner peer.
- **Auto-seeded, manually overridable.** The plugin only adds entries for senders not already in the map.
- **Adding a mapping after messages exist splits history.** Messages already stored under the original peer stay there; new messages land under the new peer. Remap before the peer accumulates history.
- **Workspace namespaces.** The historical `~/.honcho/openclaw-peers.json` path remains assigned to the configured default `workspaceId`. Other workspaces use deterministic endpoint/workspace-scoped peer files. API-key rotation does not change this persistence namespace. Do not copy one workspace's mapping file over another.

### Multi-Peer Participants

In group chats (Discord, Slack, etc.), the plugin extracts the sender's platform ID from each inbound message and uses it directly as the Honcho peer ID. This gives every participant — humans and any other bots in the room — their own memory and representation in Honcho, rather than attributing all non-agent messages to a single generic peer.

**How it works:**
- The plugin reads the `sender_id` field from OpenClaw's "Conversation info (untrusted metadata):" block, which OpenClaw injects on every inbound message that has a known sender — including 1-on-1 DMs on platforms like Telegram, not just group chats.
- Each distinct sender ID becomes its own Honcho peer (e.g., `U07KX7DG002` becomes the Honcho peer ID directly, sanitized to `[A-Za-z0-9_-]`). You can alias a sender to a friendlier peer ID by editing the [peers file](#peer-mappings).
- The default `owner` peer is used as a fallback when a message has no sender metadata at all (e.g., synthetic/system messages, or channel integrations that don't emit a `Conversation info` block), and — on legacy installs whose peers file uses `defaultUnknownPolicy: "owner"` — for any unknown sender. On fresh installs (`per-sender` policy) and platforms like Telegram, even DMs are attributed to the sender's own peer, not `owner`.
- Each OpenClaw agent gets its own Honcho peer (default `agent-{id}`, e.g., `agent-main`).
- All tools (`honcho_context`, `honcho_ask`, etc.) automatically resolve the correct peer for the current session.

Both message *attribution* (capture) and *context injection* (`before_prompt_build`) read `sender_id` directly from the current inbound message's metadata block, so the right participant peer is used from the very first turn — and on every turn in group chats, even when the speaker changes between turns. Sessions whose channel never emits sender metadata (no `Conversation info` block) stay attributed to `owner`.

## How it works

Once installed, the plugin works automatically:

- **Message Observation** — After every AI turn, the conversation is persisted to Honcho. Both user and agent messages are observed, allowing Honcho to build and refine its models. Message capture starts when the plugin is active for a session, and preserves original timestamps for captured messages. Messages are also flushed before session compaction and `/new`/`/reset`, so no conversation data is lost.
- **Tool-Based Context Access** — The AI can query Honcho mid-conversation using tools like `honcho_context`, `honcho_search_conclusions`, and `honcho_ask` to retrieve relevant context about the user. Context is injected during OpenClaw's `before_prompt_build` phase, ensuring accurate turn boundaries.
- **Multi-Peer Model** — Honcho maintains separate representations for each participant. Whenever an inbound message carries a `sender_id` (group chats, and DMs on platforms like Telegram), that sender gets their own peer, using their platform ID directly as the Honcho peer ID (or aliased via the [peers file](#peer-mappings) if configured). Each OpenClaw agent gets its own Honcho peer (default `agent-{id}`). The default `owner` peer is used as a fallback when a channel emits no sender metadata, and — on legacy installs whose peers file uses `defaultUnknownPolicy: "owner"` — for any unknown sender. **Migration boundary:** historical turns already attributed to `owner` (or to any prior peer ID) are not retroactively re-attributed when the plugin upgrades or when `peers` / `defaultUnknownPolicy` change. Only new inbound `sender_id`s create per-sender peers, so pre-existing sessions may show mixed attribution across the rollout. This gives every participant isolated, personalized memory going forward.
- **Clean Persistence** — Platform metadata (conversation info, sender headers, thread context, forwarded messages) is stripped before saving to Honcho, ensuring only meaningful content is persisted. Noise messages (heartbeat acks, cron boilerplate, startup commands) are dropped entirely via configurable pattern filters.

Honcho handles all reasoning and synthesis in the cloud.

## Multi-Agent Support

OpenClaw uses a multi-agent architecture where a primary agent can spawn **subagents** to handle specialized tasks. The Honcho plugin is fully aware of this hierarchy:

- **Automatic Subagent Detection** — When OpenClaw spawns a subagent, the plugin tracks the parent→child relationship via the `subagent_spawned` hook. Each subagent session records its `parentPeerId` in metadata.
- **Parent Observer Peer** — The spawning agent is added as a silent observer in the subagent's Honcho session (`observeMe: false, observeOthers: true`). This gives Honcho visibility into the full agent tree — the parent can see what its subagents are doing without its own messages being attributed to the subagent session.
- **Workspace inheritance** — The child session inherits the requester's immutable workspace binding. Missing parent routes and conflicting child bindings fail closed before session/client creation.

## Workspace Files

The plugin manages markdown files in your workspace:

| File           | Contents                                               |
| -------------- | ------------------------------------------------------ |
| `SOUL.md`      | Agent profile — OpenClaw's self-model and personality. |
| `IDENTITY.md`  | Static agent identity. Uploaded to the agent peer in Honcho during setup; the local file is not modified. |
| `AGENTS.md`    | Agent capabilities and tool descriptions.              |
| `TOOLS.md`     | Tool definitions and usage instructions for the agent. |
| `BOOTSTRAP.md` | Initial context and instructions for the agent.        |

**Migration:** Legacy files (`USER.md`, `MEMORY.md`, `memory/` directory) are uploaded to Honcho during `openclaw honcho setup`. Originals are preserved in place.

## AI Tools

The plugin provides 5 tools — 3 data retrieval (cheap, no LLM) and 2 interactive (LLM-powered).

| Tool                     | Type | Description                                                                                     |
| ------------------------ | ---- | ----------------------------------------------------------------------------------------------- |
| `honcho_context`         | Data | User knowledge across all sessions. `detail='card'` for key facts, `'full'` for broad representation. |
| `honcho_search_conclusions` | Data | Semantic vector search over stored conclusions. Returns raw memories ranked by relevance.      |
| `honcho_search_messages`  | Data | Find specific messages across all sessions. Filter by sender (user/agent/all), date, metadata.   |
| `honcho_session`         | Data | Current session history and summary. Supports semantic search within the session.               |
| `honcho_ask`             | Q&A  | Ask Honcho a question about the user. `depth='quick'` for facts, `'thorough'` for synthesis.   |

## CLI Commands

```bash
openclaw honcho setup                           # Configure API key and migrate legacy files
openclaw honcho status --agent main             # Inspect an agent's routed workspace
openclaw honcho ask <question> --agent main     # Query in that agent's workspace
openclaw honcho search <query> --agent main     # Search in that agent's workspace
```

CLI commands have no trusted chat context and never infer channel/chat rules. In routed or strict configurations, `status`, `ask`, and `search` require `--agent`, and that agent must have one unambiguous agent-wide workspace. Omitting `--agent` is retained only for the explicit safe legacy single-workspace configuration. Query commands intentionally do not accept `--workspace`.

In the routing example above, `main` spans `melia-ruslan` and `silva-work`, so read/query CLI calls for `--agent main` intentionally deny. Use the session-scoped tools for that agent, or redesign the mapping so the requested CLI identity is unambiguous.

## Migration, rollback, and production rollout

Before production rollout:

1. Back up the OpenClaw config, current plugin package, peer mappings, and upload manifest; record the current plugin version and gateway health. Verify the plugin backup (path, version, SHA-256, and rollback command) before the first production mutation.
2. Confirm `plugins.entries.openclaw-honcho.hooks.allowConversationAccess=true` is present at the entry level, then validate every intended agent/rule against a staging config with `strictWorkspaceRouting: true`. Confirm unknown routes deny before Honcho access and runtime inspection shows `agent_end` registered rather than blocked.
3. Migrate one agent/workspace at a time with explicit CLI selection. Verify workspace/session counts and exact persisted user text; do not restore a foreign database over an existing workspace.
4. Run the unit, isolation, concurrency, subagent, loader, CLI, and exact-persistence suites against the target OpenClaw version.
5. Stop the gateway, install the staged plugin build, apply config, restart, and smoke-test each route independently. Keep the production Honcho Server/Deriver unchanged.

Rollback means restoring the previous plugin package and configuration together, then restarting the gateway. New records already written to Honcho are not removed automatically; preserve them for audit and reconcile them explicitly. Do not weaken strict routing merely to make a failed route appear healthy.

## Local File Search (QMD Integration)

This plugin automatically exposes OpenClaw's `memory_search` and `memory_get` tools when a memory backend is configured. This allows you to use both Honcho's cloud-based memory AND local file search together.

### Setup

1. **Install QMD** on your server ([QMD documentation](https://github.com/tobi/qmd))

2. **Configure OpenClaw** to use QMD as the memory backend in `~/.openclaw/openclaw.json`:

```json
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "limits": {
        "timeoutMs": 120000
      }
    }
  }
}
```

3. **Set up QMD collections** for your files:

```bash
qmd collection add ~/Documents/notes --name notes
qmd update
```

4. **Restart OpenClaw**:

```bash
openclaw gateway restart
```

### Available Tools

When QMD is configured, you get both Honcho and local file tools:

| Tool            | Source | Description                                              |
| --------------- | ------ | -------------------------------------------------------- |
| `honcho_*`      | Honcho | Cross-session memory, user modeling, dialectic reasoning |
| `memory_search` | QMD    | Search local markdown files                              |
| `memory_get`    | QMD    | Retrieve file content                                    |

### Troubleshooting

#### QMD not found by OpenClaw

OpenClaw runs as a systemd service with a different PATH. Create a symlink:

```bash
sudo ln -s ~/.bun/bin/qmd /usr/local/bin/qmd
```

#### Search times out

QMD operations can take a while, especially first-time queries that download ~2GB of models. Increase the timeout in `~/.openclaw/openclaw.json`:

```json
{
  "memory": {
    "qmd": {
      "limits": {
        "timeoutMs": 120000
      }
    }
  }
}
```

The default timeout is 4000ms which depending on your hardware may be too short and cause errors. Setting it to 120000ms (2 minutes) gives QMD enough time. You can verify it's working in the logs:

```
19:09:02 tool start: memory_search
19:09:14 tool end: memory_search   # 12 seconds — within the 120s limit
```

You can also pre-warm QMD to avoid first-run delays:

```bash
qmd query "test"
```

## Known Issues

### OpenClaw 2026.4.5: Hooks silently stop firing

OpenClaw 2026.4.5 has a plugin loader bug where reentrant provider snapshot loads during initialization can cause hooks to register into a registry that is later discarded. The result is that `agent_end` (and potentially other hooks) never fire — the plugin appears loaded and no errors are logged, but no sessions are written to Honcho.

**Affected versions:** OpenClaw 2026.4.5 only.

**Symptoms:**
- Plugin logs `Honcho memory plugin loaded` at startup
- No errors in gateway logs
- `honcho_search_messages` returns nothing after the upgrade date
- Honcho queue shows 0 pending (deriver has nothing to process)
- Manual Honcho API calls still work

**Fix:** Update OpenClaw to **2026.4.6 or later**. The upstream fixes landed in the 4.6 changelog:

> Plugins/provider hooks: stop recursive provider snapshot loads from overflowing the stack during plugin initialization. (#61922, #61938, #61946, #61951)

```bash
# Update OpenClaw
npm install -g openclaw@latest
# or
brew upgrade openclaw

# Restart the gateway
openclaw gateway restart
```

**Verified working:** OpenClaw 2026.3.22 through 2026.4.4, and 2026.4.6+.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, building from source, and contribution guidelines.

## License

[MIT License](./LICENSE)

## Community

- GitHub Issues: [Open an Issue](https://github.com/plastic-labs/honcho/issues)
- Discord: [Join the Community](https://discord.gg/honcho)
- X (Twitter): [Follow @honchodotdev](https://x.com/honchodotdev)
- Blog: [Read about Honcho and Agents](https://blog.plasticlabs.ai)
