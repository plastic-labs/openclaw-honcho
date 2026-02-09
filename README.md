# Honcho Supplementary Memory Plugin for OpenClaw

> **Runtime fork** of [@honcho-ai/openclaw-honcho](https://github.com/plastic-labs/openclaw-honcho)

Adds [Honcho's](https://honcho.dev) dialectic reasoning as a **supplementary memory layer** on top of OpenClaw's built-in memory system. Your local memory stays untouched — Honcho runs alongside it, not instead of it.

## Why fork?

The upstream plugin replaces OpenClaw's memory system entirely — it takes the `kind: "memory"` slot, archives your workspace files (SOUL.md, USER.md, MEMORY.md, etc.), and becomes the sole memory backend. All your data moves to Honcho's cloud.

We wanted something different:

- **Keep local memory working** — `memory-core` handles fast vector search over workspace files and sessions. It's free, private, and instant.
- **Add Honcho on top** — Honcho's dialectic reasoning builds a deeper user model over time, synthesizing patterns across conversations that local vector search can't surface.
- **No data migration** — Your workspace files stay where they are. Nothing gets archived or replaced.

## What changed from upstream

| Area | Upstream | This fork |
|------|----------|-----------|
| **Plugin kind** | `"memory"` (replaces memory-core) | No kind (runs alongside memory-core) |
| **Install script** | Migrates files to Honcho, archives originals | No-op — nothing touched |
| **Workspace docs** | Overwrites SOUL.md, AGENTS.md, BOOTSTRAP.md | No overwriting |
| **`before_agent_start` hook** | Primary memory context source | Supplementary — appends Honcho's user model alongside local memory |
| **`agent_end` hook** | Ships conversations to Honcho | Same (unchanged) |
| **Memory file sync** | None (migrates once at install) | Periodic sync — pushes workspace .md changes to Honcho as conclusions every 30 min |
| **`memory_search`/`memory_get` tools** | Passthrough (re-exposes local search) | Removed — memory-core provides these natively |
| **Tools** | 6 Honcho tools | Same 6 tools (unchanged) |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  memory-core (built-in)          openclaw-honcho (this fork)│
│  ├─ Local vector search          ├─ Dialectic user model    │
│  ├─ Workspace file indexing      ├─ Cross-session synthesis │
│  ├─ Session memory               ├─ Peer reasoning (Q&A)   │
│  └─ Fast, free, private          └─ Cloud-based, richer     │
│                                                             │
│  ┌─────────────────┐  ┌──────────────────────────────────┐ │
│  │ Local Memory     │  │ Honcho Cloud                     │ │
│  │ (.md files,      │  │ (conversations + synced files    │ │
│  │  session JSONL)  │  │  → dialectic peer models)        │ │
│  └─────────────────┘  └──────────────────────────────────┘ │
│                                                             │
│  Data flows:                                                │
│  1. agent_end → conversations ship to Honcho (passive)      │
│  2. Periodic sync → workspace .md files push to Honcho      │
│  3. before_agent_start → Honcho context injected as         │
│     supplementary system prompt (additive, not replacing)   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Local memory** handles everyday recall — "what's in MEMORY.md?", "search my sessions for X".

**Honcho** handles the meta layer — "what does this user care about?", "how has their thinking on X evolved?", "describe their communication style". It builds this from observing conversations + ingesting your curated workspace files.

## Setup

### 1. Get a Honcho API key

Sign up at [honcho.dev](https://honcho.dev) and grab an API key.

```bash
echo "HONCHO_API_KEY=hc_your_key_here" >> ~/.openclaw/.env
```

### 2. Install the plugin

Point OpenClaw to the plugin directory via `plugins.load.paths` in your config:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/this/repo"]
    },
    "allow": ["openclaw-honcho"],
    "entries": {
      "openclaw-honcho": {
        "enabled": true
      }
    }
  }
}
```

### 3. Restart OpenClaw

```bash
openclaw gateway restart
```

Verify it loaded:

```bash
openclaw logs --follow | grep honcho
# Should see: "Honcho memory plugin loaded"
```

### Self-Hosted Honcho

Point to your own instance:

```bash
echo "HONCHO_BASE_URL=http://localhost:8000" >> ~/.openclaw/.env
```

## How it works

### Passive observation (automatic)

After every AI turn, the `agent_end` hook ships the conversation to Honcho. Both user and agent messages are observed. Honcho builds and refines its dual peer model (one for the user, one for the agent) from these observations over time.

### Memory file sync (automatic)

Every 30 minutes, the plugin checks your workspace files for changes and pushes updates to Honcho as conclusions:

- **User files** (about the owner): `USER.md`, `IDENTITY.md`, `MEMORY.md`
- **Agent files** (about the agent): `SOUL.md`, `AGENTS.md`, `TOOLS.md`, `WORKING.md`
- **Daily notes**: Everything in `memory/*.md`

Only changed files are synced (hash-based change detection). This ensures Honcho's reasoning draws from your curated knowledge, not just raw conversations.

### Context injection (automatic)

Before each agent turn, the `before_agent_start` hook fetches Honcho's user model and injects it as supplementary context in the system prompt. This runs alongside memory-core's local context — both contribute, neither replaces the other.

### Tools (on-demand)

Six tools are available for explicit queries:

#### Data retrieval (cheap, fast)

| Tool | What it does |
|------|-------------|
| `honcho_session` | Current session history + summary |
| `honcho_profile` | User's key facts (peer card) |
| `honcho_search` | Semantic search over all observations |
| `honcho_context` | Broad user representation across all sessions |

#### Q&A (Honcho's LLM reasons over your data)

| Tool | What it does | Cost |
|------|-------------|------|
| `honcho_recall` | Simple factual Q&A | ~$0.001 |
| `honcho_analyze` | Complex synthesis | ~$0.05 |

## CLI Commands

```bash
openclaw honcho status                          # Connection status
openclaw honcho ask "What does this user care about?"  # Query Honcho
openclaw honcho search "project decisions" -k 10       # Semantic search
```

## When to use which memory system

| Question | Use |
|----------|-----|
| "What's in MEMORY.md?" | Local memory (memory-core) |
| "Search my sessions for X" | Local memory (memory-core) |
| "What does Alex care about?" | Honcho (`honcho_analyze`) |
| "How has their thinking evolved?" | Honcho (`honcho_analyze`) |
| "What's their communication style?" | Honcho (`honcho_context`) |
| "Quick fact lookup" | Honcho (`honcho_recall`) |

## Development

```bash
# Install dependencies
npm install --legacy-peer-deps

# Build
npx tsc

# Type check
npx tsc --noEmit
```

## Upstream

This is a fork of [plastic-labs/openclaw-honcho](https://github.com/plastic-labs/openclaw-honcho). See upstream for the original "full replacement" approach.

## License

[MIT License](./LICENSE)
