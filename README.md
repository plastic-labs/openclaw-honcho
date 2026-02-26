# Honcho Memory Plugin for OpenClaw

[![Honcho Banner](./assets/honcho_claw.png)](https://honcho.dev)

AI-native memory with dialectic reasoning for OpenClaw. Uses [Honcho's](https://honcho.dev) peer paradigm to build and maintain separate models of the user and the agent — enabling context-aware conversations that improve over time. No local infrastructure required.

This plugin uses OpenClaw's slot system (`kind: "memory"`) to replace the built-in memory plugins (`memory-core`, `memory-lancedb`). During setup, existing memory files can be migrated to Honcho. Workspace docs (`SOUL.md`, `AGENTS.md`, `BOOTSTRAP.md`) can be updated manually to reference Honcho's tools instead of the old file-based system.

## Install

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
openclaw honcho setup
openclaw gateway restart
```

`openclaw honcho setup` prompts for your Honcho API key, writes the config, and optionally uploads any legacy memory files to Honcho.

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

### Legacy files

**User/owner files** (content describes the user):
- `USER.md`, `MEMORY.md`
- All files in `memory/` and `canvas/` directories (treated as user content)

**Agent/self files** (content describes the agent):
- `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `TOOLS.md`, `BOOTSTRAP.md`

### Upload to Honcho

Files are uploaded via `session.uploadFile()`. User/owner files go to the owner peer; agent/self files go to the agent peer (`agent-{agentId}`, e.g. `agent-main`).

### Update workspace docs

The plugin ships template files in `node_modules/@honcho-ai/openclaw-honcho/workspace_md/`. Copy or merge these templates into your workspace for `AGENTS.md`, `SOUL.md`, and `BOOTSTRAP.md`. These templates reference the Honcho tools (`honcho_profile`, `honcho_context`, `honcho_search`, `honcho_recall`, `honcho_analyze`) instead of the old file-based memory system.

## Configuration

Run `openclaw honcho setup` to configure interactively, or set values directly in `~/.openclaw/openclaw.json` under `plugins.entries["openclaw-honcho"].config`.

| Key           | Type     | Default                    | Description                               |
| ------------- | -------- | -------------------------- | ----------------------------------------- |
| `apiKey`      | `string` | —                          | Honcho API key (required for managed; omit for self-hosted). |
| `workspaceId` | `string` | `"openclaw"`               | Honcho workspace ID for memory isolation. |
| `baseUrl`     | `string` | `"https://api.honcho.dev"` | API endpoint (for self-hosted instances). |

### Self-Hosted / Local Honcho

Run `openclaw honcho setup`, enter a blank API key, and set the Base URL to your instance (e.g., `http://localhost:8000`).

For setting up a local Honcho server, see the [Honcho local development guide](https://github.com/plastic-labs/honcho?tab=readme-ov-file#local-development).

## How it works

Once installed, the plugin works automatically:

- **Message Observation** — After every AI turn, the conversation is persisted to Honcho. Both user and agent messages are observed, allowing Honcho to build and refine its models.
- **Tool-Based Context Access** — The AI can query Honcho mid-conversation using tools like `honcho_recall`, `honcho_search`, and `honcho_analyze` to retrieve relevant context about the user.
- **Dual Peer Model** — Honcho maintains separate representations: one for the user (preferences, facts, communication style) and one for the agent (personality, learned behaviors).

Honcho handles all reasoning and synthesis in the cloud.

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

The plugin provides both **data retrieval tools** (cheap, fast, raw data) and **Q&A tools** (LLM-powered, direct answers).

### Data Retrieval Tools

| Tool             | Description                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `honcho_session` | Retrieve conversation history and summaries from the current session. Supports semantic search. |
| `honcho_profile` | Get the user's peer card — a curated list of their most important facts.                        |
| `honcho_search`  | Semantic vector search over stored observations. Returns raw memories ranked by relevance.      |
| `honcho_context` | Retrieve Honcho's full representation — a broad view of observations about the user.            |

### Q&A Tools

| Tool             | Description                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `honcho_recall`  | Ask a simple factual question (e.g., "What's their name?"). Minimal LLM reasoning.                         |
| `honcho_analyze` | Ask a complex question requiring synthesis (e.g., "Describe their communication style"). Medium reasoning. |

## CLI Commands

```bash
openclaw honcho setup                           # Configure API key and migrate legacy files
openclaw honcho status                          # Show current installation and setup state
openclaw honcho ask <question>                  # Query Honcho about the user
openclaw honcho search <query> [-k N] [-d D]    # Semantic search over memory (topK, maxDistance)
```

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

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, building from source, and contribution guidelines.

## License

[MIT License](./LICENSE)

## Community

- GitHub Issues: [Open an Issue](https://github.com/plastic-labs/honcho/issues)
- Discord: [Join the Community](https://discord.gg/honcho)
- X (Twitter): [Follow @honchodotdev](https://x.com/honchodotdev)
- Blog: [Read about Honcho and Agents](https://blog.plasticlabs.ai)
