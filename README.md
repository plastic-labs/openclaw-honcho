# Honcho Memory Plugin for Moltbot

AI-native memory with dialectic reasoning for Moltbot. Uses [Honcho's](https://honcho.dev) peer paradigm to build and maintain separate models of the user and the agent — enabling context-aware conversations that improve over time. No local infrastructure required.

This plugin uses Moltbot's slot system (`kind: "memory"`) to replace the built-in memory plugins (`memory-core`, `memory-lancedb`). During installation, existing memory files are migrated to Honcho as conclusions, and workspace docs (`SOUL.md`, `AGENTS.md`, `BOOTSTRAP.md`) are synced from plugin templates.

## Install

```bash
moltbot plugins install @plastic-labs/moltbot-honcho
```

Reminder: installing this plugin deletes your clawdbot/moltbot memory files. Make sure they are saved to version control first.

Restart Moltbot after installing.

## Configuration

The only required value is your Honcho API key. Get one at [honcho.dev](https://honcho.dev).

Set it as an environment variable:

```bash
export HONCHO_API_KEY="hc_..."
```

Or configure it directly in `moltbot.json`:

```json5
{
  "plugins": {
    "entries": {
      "moltbot-honcho": {
        "enabled": true,
        "config": {
          "apiKey": "${HONCHO_API_KEY}"
        }
      }
    }
  }
}
```

### Advanced options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `workspaceId` | `string` | `"moltbot"` | Honcho workspace ID for memory isolation. |
| `baseUrl` | `string` | `"https://api.honcho.dev"` | API endpoint (for self-hosted instances). |

## How it works

Once installed, the plugin works automatically:

- **Message Observation** — After every AI turn, the conversation is persisted to Honcho. Both user and agent messages are observed, allowing Honcho to build and refine its models.
- **Tool-Based Context Access** — The AI can query Honcho mid-conversation using tools like `honcho_recall`, `honcho_search`, and `honcho_analyze` to retrieve relevant context about the user.
- **Dual Peer Model** — Honcho maintains separate representations: one for the user (preferences, facts, communication style) and one for the agent (personality, learned behaviors).

Honcho handles all reasoning and synthesis in the cloud.

## Workspace Files

The plugin manages markdown files in your workspace:

| File | Contents |
|------|----------|
| `SOUL.md` | Agent profile — Moltbot's self-model and personality. |
| `AGENTS.md` | Agent capabilities and tool descriptions. |
| `BOOTSTRAP.md` | Initial context and instructions for the agent. |
| `IDENTITY.md` | Static agent identity (unchanged by Honcho). |

Reminder: legacy files (`USER.md`, `MEMORY.md`, `memory/` directory) are migrated to Honcho during installation and removed from the workspace. Commit them to version control before installing.

## AI Tools

The plugin provides both **data retrieval tools** (cheap, fast, raw data) and **Q&A tools** (LLM-powered, direct answers).

### Data Retrieval Tools

| Tool | Description |
|------|-------------|
| `honcho_session` | Retrieve conversation history and summaries from the current session. Supports semantic search. |
| `honcho_profile` | Get the user's peer card — a curated list of their most important facts. |
| `honcho_search` | Semantic vector search over stored observations. Returns raw memories ranked by relevance. |
| `honcho_context` | Retrieve Honcho's full representation — a broad view of observations about the user. |

### Q&A Tools

| Tool | Description |
|------|-------------|
| `honcho_recall` | Ask a simple factual question (e.g., "What's their name?"). Minimal LLM reasoning. |
| `honcho_analyze` | Ask a complex question requiring synthesis (e.g., "Describe their communication style"). Medium reasoning. |

## CLI Commands

```bash
moltbot honcho status                          # Show connection status and representation sizes
moltbot honcho ask <question>                  # Query Honcho about the user
moltbot honcho search <query> [-k N] [-d D]    # Semantic search over memory (topK, maxDistance)
```
