---
name: honcho-setup
description: >
  Install the @honcho-ai/openclaw-honcho plugin and run initial setup.
  Runs `openclaw plugins install`, `openclaw honcho setup` (which prompts
  for your API key and migrates any legacy memory files to Honcho), and
  restarts the gateway. **UPLOADS WORKSPACE CONTENT TO EXTERNAL API** via
  `openclaw honcho setup`: sends USER.md, MEMORY.md, IDENTITY.md, memory/,
  canvas/, SOUL.md, AGENTS.md, BOOTSTRAP.md, TOOLS.md to api.honcho.dev
  (managed, default) or your self-hosted HONCHO_BASE_URL. HEARTBEAT.md is
  excluded. Requires user confirmation before uploading. No workspace or
  memory files are deleted, moved, or modified. `openclaw honcho setup`
  does write plugin configuration to ~/.openclaw/openclaw.json.
metadata:
  openclaw:
    emoji: "🧠"
    required_env: []  # Nothing is strictly required - self-hosted mode works without API key
    optional_env:
      - name: HONCHO_API_KEY
        description: "Required for managed Honcho (https://app.honcho.dev). If set, openclaw honcho setup will use it automatically. If not set, the setup command will prompt for it."
      - name: HONCHO_BASE_URL
        description: "Base URL for a self-hosted Honcho instance (e.g. http://localhost:8000). Defaults to https://api.honcho.dev (managed)."
    required_binaries:
      - node
      - npm
    writes_to_disk: true  # openclaw honcho setup writes config to ~/.openclaw/openclaw.json
    reads_sensitive_files:
      - "~/.openclaw/openclaw.json - read and updated by openclaw honcho setup; API key collected via interactive prompt and written here"
    network_access:
      - "api.honcho.dev (managed mode, default)"
      - "User-configured HONCHO_BASE_URL (self-hosted mode)"
    data_handling:
      uploads_to_external: true
      requires_user_confirmation: true
      deletes_files: false
      modifies_files: false
      external_destinations:
        - "api.honcho.dev (managed Honcho, default)"
        - "User-configured HONCHO_BASE_URL (self-hosted mode)"
      uploaded_content:
        - "USER.md, MEMORY.md (user profile/memory files)"
        - "All files under memory/ directory (structured memory)"
        - "All files under canvas/ directory (working memory)"
        - "SOUL.md, IDENTITY.md, AGENTS.md, BOOTSTRAP.md, TOOLS.md (agent configuration)"
        - "HEARTBEAT.md excluded — it is a live task queue, not memory"
      data_destination_purpose: "Migrates file-based memory system to Honcho API for AI agent memory/personalization"
  homepage: "https://honcho.dev"
  source: "https://github.com/plastic-labs/honcho"
---

# Honcho Setup

Install the `@honcho-ai/openclaw-honcho` plugin. The plugin includes `openclaw honcho setup`, which handles API key configuration and migration of any legacy memory files to Honcho.

> ⚠️ **DATA UPLOAD WARNING**: `openclaw honcho setup` (run in Step 2) will offer to upload your workspace memory files (USER.md, MEMORY.md, IDENTITY.md, memory/, canvas/, SOUL.md, AGENTS.md, BOOTSTRAP.md, TOOLS.md) to an external API. `HEARTBEAT.md` is excluded. By default, data is sent to `api.honcho.dev`. For self-hosted instances, data is sent to your configured `HONCHO_BASE_URL`. The setup command will show exactly which files will be uploaded and ask for explicit confirmation before proceeding.

> **No local files are deleted, moved, or modified.** Originals remain exactly in place.

## Step 1: Install the Plugin

Install the Honcho plugin using the OpenClaw plugin system. **Use this exact command — do not install `@honcho-ai/sdk` directly or use `npm install` in the workspace.**

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
```

Then enable it:

```bash
openclaw plugins enable openclaw-honcho
```

Verify the plugin loaded without errors. If the gateway logs show `Cannot find module '@honcho-ai/sdk'`, install dependencies manually:

```bash
cd ~/.openclaw/extensions/openclaw-honcho && npm install
```

This is a known issue with the OpenClaw plugin installer not running dependency resolution for plugin packages.

## Step 2: Run Setup

Run the setup command that ships with the plugin:

```bash
openclaw honcho setup
```

This command will:
1. Prompt interactively for your Honcho API key
2. Write configuration to `~/.openclaw/openclaw.json`
3. Scan for legacy memory files and offer to migrate them to Honcho

Follow the prompts. Migration is optional — if you have no legacy files or want to skip, you can skip the upload step.

For managed Honcho, you need an API key from https://app.honcho.dev. For self-hosted instances, set `HONCHO_BASE_URL` to your instance URL and the API key is optional.

## Step 3: Restart the Gateway

```bash
openclaw gateway restart
```

## Step 4: Confirm

Verify the plugin is active by checking gateway logs or running:

```bash
openclaw honcho status
```

Honcho memory is now active. The plugin will automatically observe conversations and make memory available via `honcho_recall`, `honcho_search`, `honcho_profile`, and related tools.

---

## Security & Privacy Disclosure

This skill has been designed with transparency and safety as priorities. Below is a complete disclosure of what this skill does:

### What This Skill Does
This skill runs three commands: `openclaw plugins install`, `openclaw honcho setup`, and `openclaw gateway restart`. The data upload and file access described below is performed by `openclaw honcho setup`, not by this skill directly.

### Data Upload
- **uploaded_content**: USER.md, MEMORY.md, IDENTITY.md, all files under memory/, all files under canvas/, SOUL.md, AGENTS.md, BOOTSTRAP.md, TOOLS.md — uploaded by `openclaw honcho setup` during migration
- **not_uploaded**: HEARTBEAT.md — excluded by design, never read or uploaded
- **Where it goes**: By default to `api.honcho.dev` (managed Honcho cloud service). For self-hosted instances, to your configured `HONCHO_BASE_URL`
- **User control**: `openclaw honcho setup` requires explicit confirmation before any upload. You will see the exact list of files and the destination URL
- **Purpose**: Migrating file-based memory system to Honcho API for AI agent personalization and memory

### File Modifications
- **Config written**: `openclaw honcho setup` writes API key and config to `~/.openclaw/openclaw.json`
- **Workspace files**: Never modified — originals remain exactly in place
- **HEARTBEAT.md**: Never read or uploaded — excluded by design

### Credentials
- **HONCHO_API_KEY**: Required only for managed Honcho (api.honcho.dev). Not required for self-hosted instances. Stored in `~/.openclaw/openclaw.json` by the setup command.
- **No other credentials**: This skill does not access, read, or transmit any other credentials or secrets

### Network Access
- **Managed mode**: Connects to `api.honcho.dev` (Honcho cloud service)
- **Self-hosted mode**: Connects to your configured `HONCHO_BASE_URL` (e.g., `http://localhost:8000`)

### Open Source
- **Honcho SDK**: Open source at https://github.com/plastic-labs/honcho
- **Plugin code**: Available at `~/.openclaw/extensions/openclaw-honcho` after installation
- **This skill**: You are reading the complete skill instructions - there is no hidden behavior
