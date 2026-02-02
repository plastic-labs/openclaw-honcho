
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

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
```

The install script automatically:

1. Migrates any existing memory to Honcho (if `HONCHO_API_KEY` is set)
2. Archives legacy memory files to `archive/` (`USER.md`, `MEMORY.md`, `AGENTS.md`, `BOOTSTRAP.md`, `SOUL.md`, `memory/` directory)
3. Syncs workspace docs (`SOUL.md`, `AGENTS.md`, `BOOTSTRAP.md`) from plugin templates

**Important:** Make sure any existing memory files are saved to version control before installing.

Restart the gateway after installing:

```bash
openclaw gateway restart
```

Start chatting and ask it questions to use its tools:

- Chat in terminal: `openclaw tui`
- Watch the logs: `openclaw logs --follow`

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

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, building from source, and contribution guidelines.
