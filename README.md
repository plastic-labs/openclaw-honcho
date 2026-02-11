# Honcho Memory Plugin for OpenClaw

[![Honcho Banner](./assets/honcho_claw.png)](https://honcho.dev)

AI-native memory with dialectic reasoning for OpenClaw. Uses [Honcho's](https://honcho.dev) peer paradigm to build and maintain separate models of the user and the agent — enabling context-aware conversations that improve over time. No local infrastructure required.

This plugin uses OpenClaw's slot system (`kind: "memory"`) to replace the built-in memory plugins (`memory-core`, `memory-lancedb`). During installation, existing memory files are migrated to Honcho as conclusions, and workspace docs (`SOUL.md`, `AGENTS.md`, `BOOTSTRAP.md`) are synced from plugin templates.

## Configuration

The only required value is your Honcho API key. Get one at [honcho.dev](https://honcho.dev).

Add it to OpenClaw's global env file:

```bash
echo "HONCHO_API_KEY=your_honcho_api_key_here" >> ~/.openclaw/.env
```

## Install

### Option A: ClawHub Skill (Recommended)

The `honcho-setup` skill on [ClawHub](https://clawhub.com) handles installation, migration, and workspace setup interactively:

```bash
clawhub install honcho-setup
```

Then run the skill from a chat session. It will walk you through everything below.

### Option B: Manual Install

Install the plugin using the OpenClaw plugin system. **Do not install `@honcho-ai/sdk` directly or use `npm install` in the workspace.**

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
```

Then enable it:

```bash
openclaw plugins enable openclaw-honcho
```

If the gateway logs show `Cannot find module '@honcho-ai/sdk'`, install the plugin's dependencies manually:

```bash
cd ~/.openclaw/extensions/openclaw-honcho && npm install
```

Restart the gateway:

```bash
openclaw gateway restart
```

Verify the plugin loaded:

```bash
openclaw logs --follow
```

Start chatting and ask it questions to use its tools:

- Chat in terminal: `openclaw tui`
- Watch the logs: `openclaw logs --follow`

## Migrating Legacy Memory

If you have existing workspace memory files, the install script migrates them automatically when `HONCHO_API_KEY` is set. If automatic migration didn't run (e.g., API key wasn't set at install time), you can migrate manually.

**Important:** Commit any existing memory files to version control before migrating.

### Legacy files

**User/owner files** (content describes the user):
- `USER.md`
- `IDENTITY.md`
- `MEMORY.md`

**Agent/self files** (content describes the agent):
- `SOUL.md`
- `AGENTS.md`
- `TOOLS.md`
- `BOOTSTRAP.md`
- `HEARTBEAT.md`

**Directories:**
- `memory/` — all files recursively (treated as user content)
- `canvas/` — all files recursively (treated as user content)

### Upload to Honcho

Upload each file's content to Honcho using the `honcho_analyze` tool in a chat session:

- **User/owner content** — create conclusions about the user. Format: `Memory file: <filename>\n\n<file content>`
- **Agent/self content** — create conclusions about the agent. Same format.

### Archive originals

After uploading, archive the originals to prevent duplication:

1. Copy all detected files to an `archive/` directory in the workspace root.
2. **Remove originals** for legacy-only files: `USER.md`, `MEMORY.md`, `IDENTITY.md`, `HEARTBEAT.md`
3. **Keep originals** for active workspace docs: `AGENTS.md`, `TOOLS.md`, `SOUL.md`, `BOOTSTRAP.md`
4. **Move directories** (`memory/`, `canvas/`) into the archive.

### Update workspace docs

The plugin ships template files in `node_modules/@honcho-ai/openclaw-honcho/workspace_md/`. Copy or merge these templates into your workspace for `AGENTS.md`, `SOUL.md`, and `BOOTSTRAP.md`. These templates reference the Honcho tools (`honcho_profile`, `honcho_context`, `honcho_search`, `honcho_recall`, `honcho_analyze`) instead of the old file-based memory system.

### Workspace Path

The plugin needs to know where your OpenClaw workspace files are stored. By default, this is `~/.openclaw/workspace`, but you can customize it.

**Resolution order (first match wins):**

1. `WORKSPACE_ROOT` environment variable
2. `~/.openclaw/openclaw.json` config file (checks `agent.workspace`, `agents.defaults.workspace`, or `agents.defaults.workspaceDir`)
3. `~/.openclaw/workspace` (if it exists)
4. Current working directory (fallback)

**Option 1: Environment variable**

```bash
echo "WORKSPACE_ROOT=/path/to/custom/workspace" >> ~/.openclaw/.env
```

**Option 2: Config file**

Add to `~/.openclaw/openclaw.json`:

```json
{
  "agent": {
    "workspace": "/path/to/custom/workspace"
  }
}
```

### Honcho Options

| Key           | Type     | Default                    | Description                               |
| ------------- | -------- | -------------------------- | ----------------------------------------- |
| `workspaceId` | `string` | `"openclaw"`               | Honcho workspace ID for memory isolation. |
| `baseUrl`     | `string` | `"https://api.honcho.dev"` | API endpoint (for self-hosted instances). |

### Self-Hosted / Local Honcho

If you're running your own Honcho server locally or self-hosted, just point the plugin to your instance by setting the base URL:

```bash
echo "HONCHO_BASE_URL=http://localhost:8000" >> ~/.openclaw/.env
```

No other client-side changes are needed. The plugin will connect to your local server instead of the hosted API.

For setting up a local Honcho server, see the [Honcho code](https://github.com/plastic-labs/honcho?tab=readme-ov-file#local-development).

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
| `AGENTS.md`    | Agent capabilities and tool descriptions.              |
| `BOOTSTRAP.md` | Initial context and instructions for the agent.        |
| `IDENTITY.md`  | Static agent identity (unchanged by Honcho).           |

**Important:** Legacy files (`USER.md`, `MEMORY.md`, `memory/` directory) are migrated to Honcho and archived to `archive/` during installation. Commit them to version control before installing.

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
openclaw honcho status                          # Show connection status and representation sizes
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
