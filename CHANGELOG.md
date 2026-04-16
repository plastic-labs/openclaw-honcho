# Changelog

All notable changes to `@honcho-ai/openclaw-honcho` will be documented in this file.

## [1.3.3] - 2026-04-16

### Fixed
- **Correct owner/agent peer routing for memory files during setup (#61)**: `MEMORY.md`, `memory/`, and `canvas/` were incorrectly routed to the owner peer — they are agent state (session logs, curated memory, working scratch), not user profile data. Only `USER.md` is genuinely about the owner. Moved `MEMORY.md` to the agent file list, renamed `OWNER_DIRS` to `AGENT_DIRS`, and restructured `scanWorkspace` so agent files and dirs are only collected when an `agentId` is known. In shared workspaces, the default agent's candidate list includes shared roots, so nothing is missed. Eliminates the previous double-collection bug where `memory/`/`canvas/` in shared roots were uploaded to both the owner and agent peers.

## [1.3.2] - 2026-04-09

### Added
- **Configurable HTTP timeout for self-hosted Honcho (#54)**: New `timeoutMs` config option (or `HONCHO_TIMEOUT_MS` env var) sets the HTTP timeout in milliseconds for Honcho SDK requests. Useful for self-hosted deployments backed by slower local models that exceed the SDK's default timeout. Both config and env paths validate for positive finite numbers. Contributed by @ksullivan27.

## [1.3.1] - 2026-04-09

### Fixed
- **`honcho setup` now migrates memory files for all configured agents (#53, #46)**: Previously, setup only scanned and uploaded files for the default agent. Now performs two-phase scanning — owner files from shared workspace roots, then agent-specific files (SOUL.md, AGENTS.md, etc.) from each agent's workspace path. Files are routed to the correct `agent-{id}` peer. Deduplicates by (filePath, peerId) to prevent double-uploads. Normalizes agent IDs with duplicate detection and user-facing warnings. Contributed by @jodok.

## [1.3.0] - 2026-04-09

Minor version bump: this release replaces the memory tool implementation (not just
a bug fix) and makes cross-session memory access configurable — both are behavioral
changes that affect how agents interact with the memory subsystem.

### Added
- **Honcho-native `memory_search` and `memory_get` tools (#52, #45)**: Self-contained implementations that replace the deleted `api.runtime.tools` passthrough. Tools use TypeBox schemas, return structured JSON with provider/status metadata, and degrade gracefully with structured error payloads when the backend is unavailable. Contributed by @bcdonadio; foundational runtime adapter by @slideshow-dingo.
- **Configurable `crossSessionSearch` option**: `memory_search` and `memory_get` now default to cross-session access (`crossSessionSearch: true`), matching Honcho's design for cross-session exploration and user representation. Set `crossSessionSearch: false` in plugin config to restrict tools to the active session and its children only. This replaces the previous hardcoded session scoping from #52.
- **Backward-compatible runtime registration guard (#52)**: `registerHonchoMemoryRuntime()` now checks for `api.registerMemoryRuntime` before calling it, so the plugin loads cleanly on older OpenClaw hosts that don't expose the memory runtime API.
- **Memory runtime + passthrough test suites (#52)**: 6 tests covering session-scoped search, cross-session rejection, transcript slicing, snippet range clamping, null ownerPeer handling, and tool registration.

### Fixed
- **Stale tool names in `workspace_md/AGENTS.md` (#49)**: Default agent template referenced deprecated tool names (`honcho_profile`, `honcho_search`, `honcho_recall`, `honcho_analyze`) that no longer exist since v1.2.0. Updated all references to match registered tools and added parameter hints.
- **Snippet line range could exceed transcript length (#52)**: `sliceLines` and `findSnippetLineRange` now clamp `endLine` to the actual transcript length, preventing out-of-bounds ranges in `memory_search` results.
- **ownerPeer null access in runtime (#52)**: `buildSessionTranscript` and `search` now guard against uninitialized `ownerPeer`, throwing a descriptive error instead of a `TypeError`.

## [1.2.2] - 2026-03-31

### Fixed
- **Memory passthrough no longer crashes when `memory-core` is disabled (#37, #41)**: Added a guard in `memory-passthrough.ts` that checks for the existence of `createMemorySearchTool`/`createMemoryGetTool` before calling them. When `memory-core` is disabled, accessing these methods threw a `TypeError` on every tool resolution cycle. The guard returns `null`, which OpenClaw handles gracefully.
- **ClawHub plugin API version compatibility**: `pluginApi` range updated from `>=1.0.0` to `>=2026.3.22` to match OpenClaw's unified versioning scheme. The old value worked by accident (2026 > 1 in semver comparison) but was semantically meaningless. See OpenClaw #53157 for the upstream change that eliminated the separate plugin API version constant.
- **`disableDefaultNoisePatterns` missing from plugin manifest (#38)**: The config option was documented in the README but missing from `openclaw.plugin.json`'s `configSchema` and `uiHints`, causing OpenClaw config validation to reject it.

## [1.2.1] - 2026-03-25

### Fixed
- **`honcho setup` preserves config on re-run (#30)**: Previously, re-running setup would wipe existing API key, base URL, and workspace ID if the user pressed Enter without typing. Now shows masked existing values and skips prompts unless `--reconfigure` is passed.
- **Rate limit safety during setup**: Added 1.5s cooldown after initial API calls and 250ms delay between file uploads to stay under Honcho's 5 req/sec limit.
- **Per-file upload error handling**: File uploads now show progress indicators and a summary, with individual error handling instead of failing the entire batch.

## [1.2.0] - 2026-03-24

### ⚠ Breaking Changes
- **Tool consolidation and renames**: `honcho_recall` and `honcho_analyze` merged into **`honcho_ask`** (with `depth='quick'|'thorough'`). `honcho_profile` merged into **`honcho_context`** (with `detail='card'|'full'`). `honcho_search` renamed to **`honcho_search_conclusions`**. Update any agent prompts or workspace docs that reference the old tool names.

### Added
- **`honcho_search_messages` tool**: Workspace-level message search with hybrid semantic + full-text matching. Filter by sender (`from: "user"` | `"agent"` | `"all"`), date range, and metadata. Uses `peer.search()` for sender filtering — in multi-agent setups, `from: "agent"` resolves to the calling agent's peer.
- **`honcho_ask` tool** (replaces `honcho_recall` + `honcho_analyze`): Ask Honcho a question and get a direct answer. `depth='quick'` for factual lookups, `'thorough'` for synthesis.
- **`honcho_context` tool** (replaces `honcho_profile`): User knowledge across all sessions. `detail='card'` for key facts, `'full'` for broad representation.
- **Configurable noise filtering**: New `noisePatterns` config option to add custom message filters. Patterns support exact match, prefix match, and regex (e.g. `/^HEARTBEAT/i`). Custom patterns merge with built-in defaults. Set `disableDefaultNoisePatterns: true` to use only your own patterns.
- **`ownerObserveOthers` config option**: Controls whether the owner peer observes agent messages in Honcho's social model. Defaults to `false`. Set to `true` for perspective-aware memory where the user's representation reflects the full conversational context.
- **Pre-compaction and pre-reset message flush**: Messages are now saved to Honcho before session compaction or `/new`/`/reset`, preventing data loss.
- **Timestamp stripping**: Leading OpenClaw-injected timestamps are stripped from messages before saving to Honcho.
- **Memory prompt section builder**: Tool selection guidance is now injected via `registerMemoryPromptSection` instead of bloating individual tool descriptions (~2,200 token reduction per LLM call).

### Changed
- **`honcho_session` uses runtime session key**: Previously hardcoded to `"default"`, now derives the session key from `buildSessionKey(toolCtx)` to match the capture hook. Fixes session lookup in multi-session setups.
- **Tool descriptions trimmed**: All tool descriptions reduced from 200-400 words to 1-2 sentences. `additionalProperties: false` added to all schemas. Structured `details` returned from all tools.
- **Synced with OpenClaw plugin SDK updates**: `definePluginEntry`, `appendSystemContext`, compaction/reset hooks.
- **Plugin load logging**: "Honcho memory plugin loaded" now logs once per process instead of per workspace registration, reducing log noise in multi-agent setups.

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
