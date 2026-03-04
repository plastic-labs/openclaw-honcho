# Changelog

All notable changes to `@honcho-ai/openclaw-honcho` will be documented in this file.

## [1.1.1] - 2026-03-03

### Added
- **Parent observer peer in subagent sessions**: The spawning agent's peer is now added as a silent observer (`observeMe: false, observeOthers: true`) in subagent Honcho sessions, giving the parent agent visibility into subagent activity.
- **Timestamp-preserving message capture**: Messages captured while the plugin is active retain their original timestamps in Honcho.

### Changed
- **Context hook moved to `before_prompt_build`**: Replaced the `before_agent_start` hook with `before_prompt_build` to accurately capture the turn-start message index before the prompt is assembled.
- **Session metadata updated for subagents**: Subagent session metadata now records `parentPeerId` (replacing the old `parentAgentKey` field).

### Fixed
- **Subagent parent peer resolution via `subagent_spawned` hook**: Parent peer is now reliably resolved for all spawn paths. `before_agent_start` builds an authoritative `sessionKey→agentId` map; `subagent_spawned` uses it to store the child→parent agent ID in a module-level `subagentParentMap`, replacing fragile session-key string parsing.
- **Absolute message watermarking for capture dedupe**: `lastSavedIndex` is now treated as an absolute index in `event.messages` (instead of a turn-local offset), preventing stale-offset drops on turn 2+ while still respecting `turnStartIndex` on first run.
- **Inbound metadata stripping aligned with OpenClaw**: `cleanMessageContent` now strips OpenClaw platform metadata blocks (Conversation info, Sender, Thread starter, Replied message, Forwarded message, Chat history, and Untrusted context headers) before saving to Honcho, matching `strip-inbound-meta.ts` behavior.
- **File upload throttling in `honcho setup`**: Added a 250 ms delay between file uploads to stay under Honcho's 5 req/sec rate limit.

## [1.1.0] - 2026-02-26

### Added
- **Multi-agent peer system**: Each OpenClaw agent now gets its own Honcho peer (`agent-{id}`) instead of sharing a single `"openclaw"` peer. Peer mappings are stored in workspace metadata with auto-scan recovery for agent renames.
- **Subagent support**: Sub-agent sessions are detected via session key format and receive user context from the owner peer via `agentPeer.context({ target: ownerPeer })`.
- **`honcho setup` CLI command**: Interactive wizard for first-time configuration — prompts for API key, base URL, and workspace ID, scans for existing memory files, and uploads them to Honcho.
- **`--agent` flag on `honcho ask`**: Query Honcho as a specific agent peer (e.g., `openclaw honcho ask --agent beta "What do you know?"`).
- **`sessionKey` parameter in `honcho_session` tool schema**: Previously the tool accepted but never declared this parameter in its TypeBox schema.

### Changed
- **Modular file structure**: Monolithic `index.ts` split into `state.ts`, `helpers.ts`, `hooks/`, `tools/`, and `commands/` modules. No circular dependencies.
- **Tool registration uses factory pattern**: `honcho_recall`, `honcho_analyze`, and `honcho_session` now receive `toolCtx` to resolve the correct per-agent peer.
- **Session metadata enriched**: Sessions now carry `agentId` (and `isSubagent`/`parentAgentKey` for sub-agent sessions) in their metadata.
- **`honcho status` output**: Now shows the default agent, its peer mapping, and all mapped agent peers.

### Fixed
- **Workspace metadata no longer erased on init**: `ensureInitialized()` previously called `setMetadata({})` unconditionally on every request, wiping any existing workspace metadata. Now reads existing metadata and preserves it.
- **`honcho setup` preserves existing workspace metadata**: Uses read-merge-write instead of overwriting with `{}` on re-runs.
- **Message content cleaning scoped to self-references only**: `cleanMessageContent` now only strips Honcho's own injected blocks (`<honcho-memory>` tags and honcho HTML comments) to prevent feedback loops. Platform headers, message IDs, and other metadata are preserved as useful provenance data.

## [1.0.3] - 2026-02-11

### Added
- **`honcho_setup` ClawHub skill**: Interactive skill for guided plugin installation and workspace migration from within an agent session.

### Changed
- **Simplified `install.js`**: Migration logic moved out of the postinstall script into the setup skill. The install script now prints guidance directing users to run setup manually.

## [1.0.2] - 2026-02-05

### Added
- **QMD (Query-Model-Document) integration**: Added QMD support for structured document querying within Honcho sessions.
- **LICENSE**: Added MIT license file.
- **Community links and documentation**: Expanded README with community resources.

## [1.0.1] - 2026-02-02

### Fixed
- Removed check for source docs that blocked installation when workspace files were missing.
- Package renamed to `@honcho-ai/openclaw-honcho` for npm compatibility.
- Package compatibility fixes for OpenClaw standard plugin format.
- Build errors resolved for clean `pnpm build`.

## [1.0.0] - 2026-01-28

### Added
- Initial release of the Honcho memory plugin for OpenClaw.
- **Core hooks**: `gateway_start` (client init), `before_agent_start` (context injection), `agent_end` (message capture).
- **Tools**: `honcho_session` (session history), `honcho_profile` (user profile), `honcho_search` (semantic search), `honcho_context` (session context), `honcho_recall` (dialectic recall), `honcho_analyze` (conversation analysis).
- **CLI commands**: `honcho status`, `honcho ask`, `honcho search`.
- **Memory passthrough**: Bridges OpenClaw's built-in memory events to Honcho sessions.
- **Install script**: Automated workspace migration with file archiving to `archive/` directory.
- Watermark-based incremental message sync to avoid duplicates.
- Owner/agent peer model with configurable observation permissions.
