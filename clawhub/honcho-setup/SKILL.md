---
name: honcho-setup
description: >
  Install the @honcho-ai/openclaw-honcho plugin and migrate legacy file-based
  memory to Honcho. **UPLOADS WORKSPACE CONTENT TO EXTERNAL API**: Sends
  USER.md, MEMORY.md, IDENTITY.md, memory/, canvas/, SOUL.md, AGENTS.md,
  BOOTSTRAP.md, TOOLS.md contents to api.honcho.dev (managed, default) or
  your self-hosted HONCHO_BASE_URL. HEARTBEAT.md is excluded (live task queue,
  not memory). Requires user confirmation before uploading.
  No files are deleted, moved, or modified. Works with managed Honcho (requires
  API key) or self-hosted instances.
metadata:
  openclaw:
    emoji: "🧠"
    required_env: []  # Nothing is strictly required - self-hosted mode works without API key
    optional_env:
      - name: HONCHO_API_KEY
        description: "REQUIRED for managed Honcho (https://app.honcho.dev). NOT required for self-hosted instances. This skill reads this value from environment variables or ~/.openclaw/.env file."
      - name: HONCHO_BASE_URL
        description: "Base URL for a self-hosted Honcho instance (e.g. http://localhost:8000). Defaults to https://api.honcho.dev (managed)."
      - name: HONCHO_WORKSPACE_ID
        description: "Honcho workspace ID. Defaults to 'openclaw'."
      - name: WORKSPACE_ROOT
        description: "Path to the OpenClaw workspace root. Auto-detected from ~/.openclaw/openclaw.json if not set."
    required_binaries:
      - node
      - npm
    optional_binaries:
      - git
      - docker
      - docker-compose
    writes_to_disk: false
    reads_sensitive_files:
      - "~/.openclaw/.env - reads ONLY the HONCHO_API_KEY value, no other environment variables are accessed"
      - "~/.openclaw/openclaw.json - reads workspace path configuration only"
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

Install the Honcho plugin and migrate legacy workspace memory files to Honcho.

> ⚠️ **DATA UPLOAD WARNING**: This skill uploads the contents of your workspace memory files (USER.md, MEMORY.md, IDENTITY.md, memory/, canvas/, SOUL.md, AGENTS.md, BOOTSTRAP.md, TOOLS.md) to an external API. `HEARTBEAT.md` is excluded — it is a live task queue, not memory. By default, data is sent to `api.honcho.dev` (managed Honcho cloud service). For self-hosted instances, data is sent to your configured `HONCHO_BASE_URL`. You will be asked for explicit confirmation before any upload occurs, and you will see exactly which files will be uploaded and where they will be sent.

> **This skill is read-only with respect to local files.** No files are deleted, moved, or modified. Originals remain exactly in place. If the Honcho upload fails or is skipped, nothing on disk changes.

> **Sensitive file access:** This skill reads `~/.openclaw/.env` to check for `HONCHO_API_KEY` only (required for managed Honcho). No other environment variables are read from this file. It also reads `~/.openclaw/openclaw.json` to determine workspace location.
## Step 1: Install and Enable the Plugin

Install the Honcho plugin using the OpenClaw plugin system. **Use this exact command — do not install `@honcho-ai/sdk` directly or use `npm install` in the workspace.**

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
```

Then enable it:

```bash
openclaw plugins enable openclaw-honcho
```

After enabling, verify the plugin loaded without errors. If the gateway logs show `Cannot find module '@honcho-ai/sdk'`, the plugin's dependencies need to be installed manually:

```bash
cd ~/.openclaw/extensions/openclaw-honcho && npm install
```

Then restart the gateway. This is a known issue with the OpenClaw plugin installer not running dependency resolution for plugin packages.

If the plugin is already installed and enabled, skip to Step 2.

## Step 2: Verify Honcho Connection

Honcho can run as a **managed cloud service** or as a **self-hosted local instance**. Determine which the user is using.

### Option A: Managed Honcho (default)

Confirm that `HONCHO_API_KEY` is set. Check the environment variables first. If not found, read ONLY the `HONCHO_API_KEY` value from `~/.openclaw/.env` if that file exists. **Do not read or access any other environment variables from the .env file** — only extract the HONCHO_API_KEY value needed for this migration.

If the key is **not** set in either location, stop and tell the user:

> `HONCHO_API_KEY` is not set. Add it to your environment or `~/.openclaw/.env`, then re-run this skill. You can get a key at https://app.honcho.dev

### Option B: Self-hosted / local Honcho

Honcho is open source and can be run locally. If the user is running their own instance, they need to set `HONCHO_BASE_URL` to point to it (e.g., `http://localhost:8000`). The SDK `environment` should be set to `"local"`.

A local instance can be started with docker-compose from the Honcho repo (requires `git`, `docker`, and `docker-compose`):

```bash
git clone https://github.com/plastic-labs/honcho
cd honcho
cp .env.template .env
cp docker-compose.yml.example docker-compose.yml
docker compose up
```

For local instances, `HONCHO_API_KEY` may not be required depending on the user's configuration. Verify connectivity before proceeding.

See https://github.com/plastic-labs/honcho?tab=readme-ov-file#local-development for full self-hosting instructions.

**Do not proceed with migration until the connection is verified.** No files will be read or uploaded without a working Honcho connection.

## Step 3: Detect Legacy Memory Files

Scan the workspace root for legacy memory files. The workspace root is determined by (in priority order):

1. The `WORKSPACE_ROOT` environment variable
2. The `agent.workspace` or `agents.defaults.workspace` field in `~/.openclaw/openclaw.json`
3. `~/.openclaw/workspace`

### Files to detect

**User/owner files** (content describes the user):
- `USER.md`
- `MEMORY.md`

**Agent/self files** (content describes the agent):
- `SOUL.md`
- `IDENTITY.md`
- `AGENTS.md`
- `TOOLS.md`
- `BOOTSTRAP.md`

> **Note:** `HEARTBEAT.md` is intentionally excluded — it is a live task queue tightly integrated with the heartbeat loop, not a memory file. Uploading it would produce a stale, misleading snapshot.

**Directories:**
- `memory/` — recursively read all files
- `canvas/` — recursively read all files

Files inside `memory/` and `canvas/` are treated as user/owner content.

Report what was found to the user before proceeding. **IMPORTANT: You MUST ask for explicit confirmation before proceeding.** 

When asking for confirmation, provide this exact information to the user:

> **Found legacy memory files ready for migration:**
> - [List each file found with its size]
>
> **What will happen next if you confirm:**
> 1. **Upload**: All file contents will be uploaded to [api.honcho.dev OR your self-hosted URL]
>
> **Data destination**: Your file contents will be sent to [show actual URL based on HONCHO_BASE_URL config]
>
> **No local files will be deleted, moved, or modified.**
>
> **Do you want to proceed with this migration?**

Do not proceed to Step 4 without explicit user confirmation.

## Step 4: Upload to Honcho

Upload each detected file to Honcho using the **messages upload** endpoint (or `honcho_analyze` if available):

- **User/owner files** → upload as messages in a session, using the **owner** peer (`peer_id` = `"owner"`).
- **Agent/self files** → upload as messages in a session, using the **agent** peer (`peer_id` = `agent-{agentId}`, e.g. `"agent-main"` or `"agent-prime"`).

Ensure the workspace and both peers exist (e.g. via SDK or API) before uploading. Get or create a session for the uploads. Report how many files were uploaded for each category (user vs. agent).

If any upload fails, stop and warn the user. Do not proceed to archiving.

### SDK setup example (messages upload with file)

Use the Honcho SDK to create messages from each file via the session upload API (the same operation as the REST `.../messages/upload` endpoint with `file` and `peer_id`). Set up the client and peers, get or create a session, add both peers to the session, then upload each detected file with the appropriate peer.

> **Note:** The `workspaceId` and session name below are defaults. Customize them via the `HONCHO_WORKSPACE_ID` env var or pass your own session name if you manage multiple migrations.

```javascript
import fs from "fs";
import path from "path";
import { Honcho } from "@honcho-ai/sdk";

const apiKey = process.env.HONCHO_API_KEY;
const workspaceRoot = process.env.WORKSPACE_ROOT || "~/.openclaw/workspace";
// Resolve the default agent ID from openclaw.json (falls back to "main")
const agentId = process.env.OPENCLAW_AGENT_ID || "main";
const agentPeerId = `agent-${agentId}`;

const honcho = new Honcho({
  apiKey,
  baseURL: process.env.HONCHO_BASE_URL || "https://api.honcho.dev",
  // Customize via HONCHO_WORKSPACE_ID or leave as default
  workspaceId: process.env.HONCHO_WORKSPACE_ID || "openclaw",
});

await honcho.setMetadata({});
const agentPeer = await honcho.peer(agentPeerId, { metadata: { agentId } });
const ownerPeer = await honcho.peer("owner", { metadata: {} });

// Session name can be customized for multiple migration runs
const session = await honcho.session("migration-upload", { metadata: {} });
await session.addPeers([ownerPeer, agentPeer]);

// For each detected file: read file and call session.uploadFile(file, peer)
// User/owner files → ownerPeer; agent/self files → agentPeer
const filesToUpload = [
  { path: path.join(workspaceRoot, "USER.md"), peer: ownerPeer },
  { path: path.join(workspaceRoot, "SOUL.md"), peer: agentPeer },
  // ... add every detected file and files under memory/ and canvas/
];

for (const { path: filePath, peer } of filesToUpload) {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) continue;
  const filename = path.basename(filePath);
  const content = await fs.promises.readFile(filePath);
  const content_type = "text/markdown"; // or "text/plain", "application/pdf", "application/json"
  const messages = await session.uploadFile(
    { filename, content, content_type },
    peer,
    {}
  );
  console.log(`Uploaded ${filePath}: ${messages.length} messages`);
}
```

- **Required:** `session.uploadFile(file, peer, options?)` — second argument is the peer (object or id). Use the owner peer for user/owner files (`USER.md`, `MEMORY.md`, and everything under `memory/` and `canvas/`), and the agent peer for agent/self files (`SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `TOOLS.md`, `BOOTSTRAP.md`). `HEARTBEAT.md` is excluded — do not upload it.
- **Session:** Add both peers to the session with `session.addPeers([ownerPeer, openclawPeer])` before uploading.
- **File (Node):** Pass `{ filename, content: Buffer | Uint8Array, content_type }`. See [Honcho file uploads](https://docs.honcho.dev/v3/guides/file-uploads#file-uploads) for supported types (PDF, text, JSON). A runnable test script is in `scripts/test-upload-file.mjs` (requires `HONCHO_API_KEY`).

## Step 5: Confirm

Summarize what happened:

- Which legacy files were found
- How many files were uploaded (user and agent counts)
- That all original files remain exactly in place — nothing was deleted or moved

Provide a link to the Honcho docs for reference: https://docs.honcho.dev

---

## Security & Privacy Disclosure

This skill has been designed with transparency and safety as priorities. Below is a complete disclosure of what this skill does:

### Data Upload
- **uploaded_content**: USER.md, MEMORY.md, IDENTITY.md, all files under memory/, all files under canvas/, SOUL.md, AGENTS.md, BOOTSTRAP.md, TOOLS.md
- **not_uploaded**: HEARTBEAT.md — excluded by design, never read or uploaded
- **Where it goes**: By default to `api.honcho.dev` (managed Honcho cloud service). For self-hosted instances, to your configured `HONCHO_BASE_URL`
- **User control**: Explicit confirmation required before any upload. You will see the exact list of files and the destination URL
- **Purpose**: Migrating file-based memory system to Honcho API for AI agent personalization and memory

### Sensitive File Access
- **`~/.openclaw/.env`**: This skill reads ONLY the `HONCHO_API_KEY` value from this file (if present). No other environment variables are read or accessed
- **`~/.openclaw/openclaw.json`**: This skill reads workspace path configuration only (`agent.workspace` or `agents.defaults.workspace` fields)
- **Workspace files**: All legacy memory files listed above are read for upload

### File Modifications
- **No local changes**: No files are deleted, moved, or modified. Originals remain exactly in place.
- **HEARTBEAT.md**: Never read or uploaded — excluded by design.
- **Safety**: Migration is upload-only — no disk writes occur

### Credentials
- **HONCHO_API_KEY**: Required only for managed Honcho (api.honcho.dev). Not required for self-hosted instances
- **No other credentials**: This skill does not access, read, or transmit any other credentials or secrets

### Network Access
- **Managed mode**: Connects to `api.honcho.dev` (Honcho cloud service)
- **Self-hosted mode**: Connects to your configured `HONCHO_BASE_URL` (e.g., `http://localhost:8000`)
- **Protocol**: All uploads use the Honcho SDK (`@honcho-ai/sdk`) via the messages upload endpoint

### User Control
- **Step 3**: Explicit confirmation required before any file upload (shows file list and destination URL)
- **Failure handling**: If upload fails, no local changes are made

### Data Retention
- **Local files**: Untouched — originals remain exactly as they are
- **Remote storage**: Uploaded data is stored according to Honcho's data retention policy (see https://honcho.dev/privacy)
- **Self-hosted control**: If using self-hosted Honcho, you control all data retention

### Open Source
- **Honcho SDK**: Open source at https://github.com/plastic-labs/honcho
- **Plugin code**: Available at `~/.openclaw/extensions/openclaw-honcho` after installation
- **This skill**: You are reading the complete skill instructions - there is no hidden behavior