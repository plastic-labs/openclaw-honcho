# Honcho Setup

Install the Honcho plugin and migrate legacy workspace files to Honcho memory.

---

## Step 1: Install the Plugin

If not already installed, run:

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
```

## Step 2: Detect and Migrate Legacy Memory Files to Honcho

Check the workspace root for legacy memory files and directories. The workspace root is determined by (in order of priority):
1. The `WORKSPACE_ROOT` environment variable
2. The `agent.workspace` or `agents.defaults.workspace` field in `~/.openclaw/openclaw.json`
3. `~/.openclaw/workspace`

### Files to look for

**User/owner files** (content is *about the user*):
- `USER.md`
- `IDENTITY.md`
- `MEMORY.md`

**OpenClaw self files** (content is *about the agent*):
- `SOUL.md`
- `AGENTS.md`
- `TOOLS.md`
- `BOOTSTRAP.md`
- `HEARTBEAT.md`

**Directories to check:**
- `memory/` — recursively read all files inside
- `canvas/` — recursively read all files inside

Files found inside `memory/` and `canvas/` are treated as user/owner content.

### Upload to Honcho

Check that `HONCHO_API_KEY` is set (it may be in `~/.openclaw/.env`). If it's not set, warn the user:

> HONCHO_API_KEY is not set. Set it with:
> ```
> echo 'HONCHO_API_KEY=hc_...' >> ~/.openclaw/.env
> ```
> Then re-run this skill.

If the key is available, upload each file's content to Honcho using `honcho_analyze` or the Honcho SDK:

- **User/owner content** → create conclusions *about the user* (the "owner" peer). For each file, the conclusion content should be: `Memory file: <filename>\n\n<file content>`
- **Agent/self content** → create self-conclusions (the "openclaw" peer). Same format.

Report how many conclusions were created for each category.

### Archive old files

After successful upload to Honcho, back up all legacy files to an `archive/` directory inside the workspace root. Suggest `archive/` as the default location — the user can choose a different directory if they prefer.

For each file and directory listed above that exists in the workspace:

1. Create the `archive/` directory if it doesn't exist.
2. Copy the file to `archive/`. If a file with the same name already exists in `archive/`, append a timestamp (e.g., `USER.md-2026-02-10T22-55-12`).
3. **Legacy-only files** — remove the original after archiving:
   - `USER.md`
   - `MEMORY.md`
   - `IDENTITY.md`
   - `HEARTBEAT.md`
4. **Workspace docs** — keep the original in place (they'll be updated in Step 3):
   - `AGENTS.md`
   - `TOOLS.md`
   - `SOUL.md`
   - `BOOTSTRAP.md`
5. **Directories** (`memory/`, `canvas/`) — move the entire directory into `archive/`.

If the Honcho upload failed or was skipped, do NOT archive or remove any files. Warn the user that files are preserved to prevent data loss.

## Step 3: Update Workspace Docs

The plugin ships template files in `node_modules/@honcho-ai/openclaw-honcho/workspace_md/`. Read these templates as the source of truth for Honcho-aware workspace docs.

For each of `AGENTS.md`, `SOUL.md`, and `BOOTSTRAP.md`:
- If the file already exists in the workspace, update it — replace references to the old file-based memory system (`USER.md`, `MEMORY.md`, `memory/` directory, manual file reads/writes for memory) with Honcho tool references.
- If the file does not exist, copy the template into the workspace.
- Preserve any custom content the user has added — only update memory-related sections.

The Honcho tools are: `honcho_profile`, `honcho_context`, `honcho_search`, `honcho_recall`, `honcho_analyze`.

## Step 4: Confirm

Tell the user:
- Which legacy files were found and migrated to Honcho (with counts)
- Which files were archived and where
- Which workspace docs were created or updated
- That Honcho is now their memory system — no more manual file management needed
