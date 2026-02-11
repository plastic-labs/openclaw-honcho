---
name: honcho-setup
description: Install the @honcho-ai/openclaw-honcho plugin and migrate legacy file-based memory (USER.md, MEMORY.md, IDENTITY.md, memory/, canvas/) to Honcho. Archives originals with user confirmation, updates SOUL.md/AGENTS.md/BOOTSTRAP.md to reference Honcho tools. Requires HONCHO_API_KEY.
metadata:
  openclaw:
    emoji: "🧠"
    requires:
      env:
        - HONCHO_API_KEY
  homepage: "https://honcho.dev"
---

# Honcho Setup

Install the Honcho plugin and migrate legacy workspace memory files to Honcho.

> **This skill modifies workspace files.** It will ask for confirmation before archiving or deleting any files. If the Honcho upload fails or is skipped, no files are moved or removed.

## Step 1: Install and Enable the Plugin

Install the Honcho plugin using the standard OpenClaw plugin system:

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
```

Then enable it:

```bash
openclaw plugins enable openclaw-honcho
```

If the plugin is already installed and enabled, skip to Step 2.

## Step 2: Verify HONCHO_API_KEY

Before migrating any files, confirm that `HONCHO_API_KEY` is set. Check the environment and `~/.openclaw/.env`.

If the key is **not** set, stop and tell the user:

> `HONCHO_API_KEY` is not set. Add it to your environment or `~/.openclaw/.env`, then re-run this skill. You can get a key at https://honcho.dev

**Do not proceed with migration until the key is verified.** No files will be read, uploaded, archived, or removed without a valid key.

## Step 3: Detect Legacy Memory Files

Scan the workspace root for legacy memory files. The workspace root is determined by (in priority order):

1. The `WORKSPACE_ROOT` environment variable
2. The `agent.workspace` or `agents.defaults.workspace` field in `~/.openclaw/openclaw.json`
3. `~/.openclaw/workspace`

### Files to detect

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
- `memory/` — recursively read all files
- `canvas/` — recursively read all files

Files inside `memory/` and `canvas/` are treated as user/owner content.

Report what was found to the user before proceeding. Ask for confirmation to continue.

## Step 4: Upload to Honcho

Upload each detected file's content to Honcho using `honcho_analyze` or the Honcho SDK:

- **User/owner content** → create conclusions about the user (the "owner" peer). Format: `Memory file: <filename>\n\n<file content>`
- **Agent/self content** → create self-conclusions (the "openclaw" peer). Same format.

Report how many conclusions were created for each category (user vs. agent).

If any upload fails, stop and warn the user. Do not proceed to archiving.

## Step 5: Archive Legacy Files

**Ask the user for confirmation before archiving.** Suggest `archive/` inside the workspace root as the default location. The user may choose a different directory.

For each detected file:

1. Create the archive directory if it does not exist.
2. Copy the file into the archive directory. If a file with the same name already exists there, append a timestamp (e.g., `USER.md-2026-02-10T22-55-12`).

Then apply these rules:

**Remove originals after archiving** (legacy-only files no longer needed in workspace):
- `USER.md`
- `MEMORY.md`
- `IDENTITY.md`
- `HEARTBEAT.md`

**Keep originals in place** (will be updated in Step 6):
- `AGENTS.md`
- `TOOLS.md`
- `SOUL.md`
- `BOOTSTRAP.md`

**Move directories** into the archive:
- `memory/`
- `canvas/`

If the upload in Step 4 failed or was skipped, **do not archive or remove any files**. Warn the user that all files are preserved to prevent data loss.

## Step 6: Update Workspace Docs

The plugin ships template files in `node_modules/@honcho-ai/openclaw-honcho/workspace_md/`. Use these templates as the source of truth for Honcho-aware workspace docs.

For each of `AGENTS.md`, `SOUL.md`, and `BOOTSTRAP.md`:

- If the file exists in the workspace: update it — replace references to the old file-based memory system (`USER.md`, `MEMORY.md`, `memory/` directory, manual file reads/writes for memory) with Honcho tool references.
- If the file does not exist: copy the template into the workspace.
- Preserve any custom content the user has added. Only update memory-related sections.

The Honcho tools are: `honcho_profile`, `honcho_context`, `honcho_search`, `honcho_recall`, `honcho_analyze`.

## Step 7: Confirm

Summarize what happened:

- Which legacy files were found
- How many conclusions were created (user and agent counts)
- Which files were archived and where
- Which workspace docs were created or updated
- That Honcho is now the memory system — no more manual file management needed

Provide a link to the Honcho docs for reference: https://docs.honcho.dev