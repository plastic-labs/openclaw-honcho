# Honcho Setup

Install the Honcho plugin and set up Honcho-aware workspace docs.

---

## Step 1: Install the Plugin

Run the following command to install the plugin and run the migration script:

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
```

This installs the npm package and runs `install.js`, which automatically:
- Detects legacy memory files (`USER.md`, `MEMORY.md`, `IDENTITY.md`, `HEARTBEAT.md`, `memory/`, `canvas/`)
- Migrates their content to Honcho (if `HONCHO_API_KEY` is set in `~/.openclaw/.env`)
- Archives all existing workspace docs and legacy files to `archive/`

If `HONCHO_API_KEY` is not set, the script will warn and skip migration. Set it with:
```bash
echo 'HONCHO_API_KEY=hc_...' >> ~/.openclaw/.env
```
Then re-run: `openclaw plugins install @honcho-ai/openclaw-honcho`

## Step 2: Update Workspace Docs

The plugin ships template files in its `workspace_md/` directory. These templates live inside the installed npm package at `node_modules/@honcho-ai/openclaw-honcho/workspace_md/`. Use them as reference to update or create the workspace docs.

For each of these files — `AGENTS.md`, `TOOLS.md`, `SOUL.md`, `BOOTSTRAP.md` (if it exists) — read the existing workspace file and update it to replace any references to the old file-based memory system with Honcho tool references:
   - Replace mentions of `USER.md`, `MEMORY.md`, `memory/` directory, or manual file reads/writes for memory with the appropriate Honcho tools.
   - The Honcho tools are: `honcho_profile`, `honcho_context`, `honcho_search`, `honcho_recall`, `honcho_analyze`.
   - Preserve any custom content the user has added — only update the memory-related sections.

Read the templates from the plugin's installed location (`node_modules/@honcho-ai/openclaw-honcho/workspace_md/`) as the source of truth for what Honcho-aware docs should look like.

## Step 3: Confirm

Tell the user:
- Which workspace docs were created or updated
- That Honcho is now their memory system — no more manual file management needed
- That legacy memory files (if any were present) have been migrated to Honcho by the install script
