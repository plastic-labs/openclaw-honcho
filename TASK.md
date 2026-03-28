# TASK: Fix Honcho Tool Registration Scope Bug

## Context

The `@honcho-ai/openclaw-honcho` plugin (v1.2.1) has a bug where tools (`honcho_search_conclusions`, `honcho_search_messages`, `honcho_ask`, `honcho_context`, `honcho_session`) don't become available in sub-agent sessions until a gateway restart.

**Repo:** plastic-labs/openclaw-honcho (forked to GodsBoy/openclaw-honcho)
**Remote:** `godsboy` for push, `origin` for upstream

## Observed Behaviour

Gateway logs show the issue clearly:

```
# First session (Sammy main) — tools register fine:
05:26:22 info gateway — Honcho memory plugin loaded
05:26:25 info gateway — Honcho memory ready

# Sub-agent session (Nehemiah) starts 4 minutes later — tools NOT found:
05:30:27 warn tools — tools.profile (coding) allowlist contains unknown entries
  (honcho_search_conclusions, honcho_search_messages, honcho_ask, honcho_context, honcho_session)
05:30:27 warn tools — tools.allow allowlist contains unknown entries
  (honcho_search_conclusions, honcho_search_messages, honcho_ask, honcho_context, honcho_session)

# Plugin re-loads for the new session:
05:30:50 info plugins — Honcho memory plugin loaded
```

After a manual gateway restart, all tools become available to all agent sessions.

## Root Cause Hypothesis

The plugin's `register()` function calls `api.registerTool()` during plugin init. But OpenClaw's plugin system re-loads plugins per session context. The tool resolver for a new session checks tool availability **before** the plugin has finished re-registering tools for that session's scope.

Key observation: The plugin loads multiple times (once per session that starts), and each time `registerTool()` is called. But the tool resolver's allowlist check happens before the registration completes for that session.

## Investigation Steps

1. Read all tool registration code in `tools/` directory
2. Read the OpenClaw plugin SDK's `registerTool` API (check `/root/.nvm/versions/node/v22.22.0/lib/node_modules/openclaw/` for SDK source)
3. Understand the plugin lifecycle: when does `register()` run vs when does tool resolution happen?
4. Check if there's a `scope` or `global` option on `registerTool()` that ensures tools persist across sessions
5. Check if the issue is in the Honcho plugin or in OpenClaw core (if core, we file an issue upstream instead)

## What to Fix

If the bug is in the Honcho plugin:
- Fix the tool registration to work correctly across session boundaries
- Ensure tools registered during initial gateway_start are visible to all subsequent sessions
- Add any necessary tests

If the bug is in OpenClaw core:
- Document the finding
- Create a GitHub issue on openclaw/openclaw
- If there's a workaround in the plugin, implement it

## Deliverables

1. **GitHub Issue** on plastic-labs/openclaw-honcho documenting the bug (with log evidence)
2. **Draft PR** with the fix (if fix is in this repo) — push to `godsboy` remote, PR against `plastic-labs/openclaw-honcho`
3. If fix is in OpenClaw core, create issue on openclaw/openclaw instead

## Git Config

```bash
git config user.email "dhuysamen@gmail.com"
git config user.name "GodsBoy"
```

## CE Workflow

Run Compound Engineering workflow:
1. `echo "docs/solutions/" >> .git/info/exclude` FIRST
2. `/ce:ideate` — surface root causes
3. `/ce:brainstorm` — narrow to fix
4. `/ce:plan` — implementation strategy
5. `/ce:work` — code changes + tests
6. `/ce:review` — self-review
7. `/ce:compound` — learnings

## Investigation Results

### Root Cause: OpenClaw Core Lifecycle Bug

The bug is **NOT** in the Honcho plugin. It is in OpenClaw core.

**Timeline for sub-agent sessions:**
1. Sub-agent session starts
2. `createOpenClawTools()` runs → calls `resolvePluginTools()` → queries fresh/empty plugin registry → tools NOT found (05:30:27)
3. `loadOpenClawPlugins()` runs → calls plugin `register()` → tools registered in registry (05:30:50, **23 seconds too late**)

**Why it works after gateway restart:**
After restart, `loadOpenClawPlugins()` completes for the gateway context BEFORE any session starts. The first session's tool resolver finds all tools. But subsequent sub-agent sessions create fresh execution contexts where tool resolution happens before plugin loading.

### Plugin SDK Limitations (No Workaround Available)

- `openclaw.plugin.json` manifest has NO `tools`, `toolNames`, or `provides` field
- `definePluginEntry()` only supports `register()` for tool registration
- `registerTool()` options: `{ name?, names?, optional? }` — no `scope` or `global` flag
- The `optional` flag doesn't help because tools aren't in the registry at all during resolution
- No static tool declaration mechanism exists in the SDK

### Key SDK Code Paths

- **Tool resolution:** `pi-embedded-BaSvmUpW.js` line ~115963 → `applyToolPolicyPipeline()` → `buildPluginToolGroups()` → `stripPluginOnlyAllowlist()`
- **Plugin loading:** `pi-embedded-BaSvmUpW.js` line ~147194 → `loadOpenClawPlugins()` → `createApi()` → `register()`
- **Registration mode:** `registerTool` is a no-op unless `registrationMode === "full"`

### Plugin Code Verified Correct

The Honcho plugin's `register()` function:
- Is fully synchronous (no async gaps)
- Registers all 5 tools + 2 passthrough tools via `api.registerTool()`
- Registers all hooks synchronously
- No errors or early returns that could skip tool registration

### Deliverables

- **Upstream issue:** openclaw/openclaw#56208
- **Tracking issue:** plastic-labs/openclaw-honcho#33
- **No code fix in this repo** — the bug is in OpenClaw core's sub-agent initialization ordering

## Important

- Draft PR only — do NOT mark ready for review
- All commits as GodsBoy <dhuysamen@gmail.com>
- No AI/Claude/Anthropic mentions in commits or PR body
- Watch CI after push: `gh run watch --exit-status`
- The OpenClaw plugin SDK source is at: `/root/.nvm/versions/node/v22.22.0/lib/node_modules/openclaw/`
- The installed (compiled) plugin is at: `/root/.openclaw/extensions/openclaw-honcho/`
