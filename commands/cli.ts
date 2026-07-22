import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { Honcho } from "@honcho-ai/sdk";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { honchoConfigSchema, type HonchoConfig } from "../config.js";
import { resolveMemoryRuntimeWorkspace, WorkspaceRoutingError } from "../routing.js";
import type { PluginState } from "../state.js";
import { OWNER_ID } from "../state.js";

/* ── Upload manifest ─────────────────────────────────────────────────── */

export type ManifestEntry = {
  sha256: string;
  uploadedAt: string;
  baseUrl: string;
  workspaceId: string;
  filePath: string;
  peerId: string;
};
export type UploadManifest = Record<string, ManifestEntry>;

const MANIFEST_PATH = () => path.join(os.homedir(), ".openclaw", ".upload-manifest.json");

function loadManifest(): UploadManifest {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH(), "utf-8"));
  } catch {
    return {};
  }
}

function saveManifest(manifest: UploadManifest): void {
  const dir = path.dirname(MANIFEST_PATH());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH(), JSON.stringify(manifest, null, 2));
}

/** Remove only entries whose destination file no longer exists. */
export function pruneStaleUploadManifestEntries(manifest: UploadManifest): void {
  for (const [key, entry] of Object.entries(manifest)) {
    // v2 keys are opaque hashes and carry their canonical path in the entry.
    // Legacy manifests used the canonical file path itself as the key.
    const filePath = key.startsWith("v2:") ? entry?.filePath : key;
    if (!filePath || !fs.existsSync(filePath)) delete manifest[key];
  }
}

function contentHash(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function requiredCliId(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new WorkspaceRoutingError(`invalid-${field}`);
  }
  return normalized;
}

export type CliWorkspaceSelection = {
  workspaceId: string;
  agentId?: string;
  source: "operator" | "agent" | "legacy";
};

/**
 * CLI commands do not have trusted turn/chat metadata. They may use only an
 * explicit operator workspace (migration only), an unambiguous agent-wide
 * route, or the explicit safe legacy single-workspace fallback.
 */
export function resolveCliWorkspace(
  cfg: HonchoConfig,
  options: { agent?: string; workspace?: string; allowWorkspaceOverride?: boolean } = {},
): CliWorkspaceSelection {
  const workspaceId = requiredCliId(options.workspace, "workspace");
  const agentId = requiredCliId(options.agent, "agent")?.toLowerCase();

  if (workspaceId) {
    if (!options.allowWorkspaceOverride) throw new WorkspaceRoutingError("cli-workspace-override-not-allowed");
    return { workspaceId, agentId, source: "operator" };
  }

  if (agentId) {
    const routedWorkspace = resolveMemoryRuntimeWorkspace(cfg, agentId);
    if (!routedWorkspace) throw new WorkspaceRoutingError("cli-agent-route-unavailable");
    return { workspaceId: routedWorkspace, agentId, source: "agent" };
  }

  const legacyWorkspace = resolveMemoryRuntimeWorkspace(cfg);
  if (legacyWorkspace) return { workspaceId: legacyWorkspace, source: "legacy" };
  throw new WorkspaceRoutingError("cli-agent-required");
}

/** Stable resume key: the same file may be uploaded independently per destination. */
export function uploadManifestKey(
  baseUrl: string,
  workspaceId: string,
  filePath: string,
  peerId: string,
): string {
  const identity = JSON.stringify([baseUrl.replace(/\/$/, ""), workspaceId, path.resolve(filePath), peerId]);
  return `v2:${crypto.createHash("sha256").update(identity).digest("hex")}`;
}

function positiveInteger(value: string, field: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${field}: expected a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid ${field}: expected a positive integer`);
  return parsed;
}

function unitInterval(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid ${field}: expected a number from 0 to 1`);
  }
  return parsed;
}

export function registerCli(api: OpenClawPluginApi, state: PluginState): void {
  api.registerCli(
    ({ program, workspaceDir }) => {
      const cmd = program.command("honcho").description("Honcho memory commands");

      cmd
        .command("setup")
        .description("Configure Honcho API key and upload memory files to Honcho")
        .option("--reconfigure", "Force re-entry of all configuration values")
        .option("-a, --agent <id>", "Agent whose legacy files are being migrated")
        .option("--workspace <id>", "Operator-selected Honcho workspace for this migration upload")
        .action(async (options: { reconfigure?: boolean; agent?: string; workspace?: string }) => {
          const configDir = path.join(os.homedir(), ".openclaw");
          const configPath = path.join(configDir, "openclaw.json");

          // Load existing config to use as defaults
          let config: Record<string, unknown> = {};
          if (fs.existsSync(configPath)) {
            try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { /* use empty */ }
          }
          const existingPluginCfg = (
            ((config.plugins as Record<string, unknown>)
              ?.entries as Record<string, unknown>)
              ?.["openclaw-honcho"] as Record<string, unknown>
          )?.config as Record<string, unknown> | undefined;

          const savedApiKey = (existingPluginCfg?.apiKey as string) ?? "";
          const savedBaseUrl = (existingPluginCfg?.baseUrl as string) || "https://api.honcho.dev";
          const savedWorkspaceId = (existingPluginCfg?.workspaceId as string) || "openclaw";
          const hasExistingConfig = !!existingPluginCfg && !!savedApiKey;

          console.log("\nHoncho Setup\n");
          console.log("Get your API key from: https://app.honcho.dev\n");

          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

          try {
            let resolvedApiKey: string;
            let resolvedBaseUrl: string;
            let resolvedWorkspaceId: string;

            if (hasExistingConfig && !options.reconfigure) {
              const maskedKey = savedApiKey.length > 8
                ? savedApiKey.slice(0, 4) + "..." + savedApiKey.slice(-4)
                : "****";
              console.log("Existing configuration found:");
              console.log(`  API key:      ${maskedKey}`);
              console.log(`  Base URL:     ${savedBaseUrl}`);
              console.log(`  Workspace ID: ${savedWorkspaceId}`);
              console.log('\nPress Enter to keep existing values, or use --reconfigure to change.\n');

              resolvedApiKey = savedApiKey;
              resolvedBaseUrl = savedBaseUrl;
              resolvedWorkspaceId = savedWorkspaceId;
              console.log("✓ Using existing configuration\n");
            } else {
              console.log('Press Enter to use the default shown in [brackets].\n');

              const apiKeyDefault = savedApiKey ? ` [${savedApiKey.slice(0, 4)}...${savedApiKey.slice(-4)}]` : "";
              const apiKeyInput = await ask(`Honcho API key${apiKeyDefault || " (press Enter for self-hosted mode)"}: `);
              const baseUrlInput = await ask(`Base URL [${savedBaseUrl}]: `);
              const workspaceIdInput = await ask(`Workspace ID [${savedWorkspaceId}]: `);

              resolvedApiKey = apiKeyInput.trim() || savedApiKey;
              resolvedBaseUrl = baseUrlInput.trim() || savedBaseUrl;
              resolvedWorkspaceId = workspaceIdInput.trim() || savedWorkspaceId;

              // Write config
              if (!config.plugins) config.plugins = {};
              const pluginsSection = config.plugins as Record<string, unknown>;
              if (!pluginsSection.entries) pluginsSection.entries = {};
              const entriesSection = pluginsSection.entries as Record<string, unknown>;
              const existingEntry = (entriesSection["openclaw-honcho"] as Record<string, unknown>) ?? {};
              const pluginCfg: Record<string, unknown> = {
                ...(existingEntry.config as Record<string, unknown> ?? {}),
              };
              if (resolvedApiKey) pluginCfg.apiKey = resolvedApiKey;
              else delete pluginCfg.apiKey;
              pluginCfg.baseUrl = resolvedBaseUrl;
              pluginCfg.workspaceId = resolvedWorkspaceId;
              entriesSection["openclaw-honcho"] = { ...existingEntry, config: pluginCfg };

              if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
              fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
              console.log("\n✓ Configuration saved to ~/.openclaw/openclaw.json");
            }

            // Resolve configured agents and their workspaces from config
            let savedConfig: Record<string, unknown> = {};
            try { savedConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { /* use empty */ }

            const effectivePluginCfg = (
              (((savedConfig.plugins as Record<string, unknown> | undefined)
                ?.entries as Record<string, unknown> | undefined)
                ?.["openclaw-honcho"] as Record<string, unknown> | undefined)
                ?.config as Record<string, unknown> | undefined
            ) ?? {};
            const parsedRoutingConfig = honchoConfigSchema.parse({
              ...effectivePluginCfg,
              apiKey: resolvedApiKey,
              baseUrl: resolvedBaseUrl,
              workspaceId: resolvedWorkspaceId,
            });
            const uploadRoute = resolveCliWorkspace(parsedRoutingConfig, {
              agent: options.agent,
              workspace: options.workspace,
              allowWorkspaceOverride: true,
            });
            resolvedWorkspaceId = uploadRoute.workspaceId;

            const agentsList = Array.isArray((savedConfig?.agents as Record<string, unknown>)?.list)
              ? ((savedConfig.agents as Record<string, unknown>).list as Array<Record<string, unknown>>)
              : [];
            const hasExplicitDefault = agentsList.some((a) => a?.default === true);
            const normalizedAgents = (agentsList.length > 0 ? agentsList : [{ id: "main", default: true }])
              .map((agent, index) => {
                const agentId = ((agent?.id as string) ?? (index === 0 ? "main" : `a${index + 1}`)).toLowerCase().trim() || "main";
                return {
                  id: agentId,
                  workspace: agent?.workspace as string | undefined,
                  workspaceDir: agent?.workspaceDir as string | undefined,
                  isDefault: agent?.default === true || (index === 0 && !hasExplicitDefault),
                };
              })
              .filter((agent, index, all) => {
                const firstIndex = all.findIndex((candidate) => candidate.id === agent.id);
                if (firstIndex !== index) {
                  console.log(`  ! Duplicate normalized agent ID "${agent.id}" — skipping later entry during migration setup`);
                  return false;
                }
                return true;
              });
            const defaultAgent = normalizedAgents.find((a) => a.isDefault) ?? normalizedAgents[0];
            const defaultAgentId = ((defaultAgent?.id as string) ?? "main").toLowerCase().trim() || "main";
            const migrationAgents = uploadRoute.agentId
              ? normalizedAgents.filter((agent) => agent.id === uploadRoute.agentId)
              : normalizedAgents;
            if (uploadRoute.agentId && migrationAgents.length === 0) {
              throw new WorkspaceRoutingError("cli-agent-not-configured");
            }
            if (!uploadRoute.agentId && uploadRoute.source === "operator" && normalizedAgents.length > 1) {
              throw new WorkspaceRoutingError("cli-agent-required");
            }
            const migrationDefaultAgentId = uploadRoute.agentId ?? defaultAgentId;
            const migrationDefaultAgentPeerId = `agent-${migrationDefaultAgentId}`;

            const OWNER_FILES = ["USER.md"];
            const AGENT_FILES = ["SOUL.md", "IDENTITY.md", "AGENTS.md", "TOOLS.md", "BOOTSTRAP.md", "MEMORY.md"];
            const AGENT_DIRS = ["memory", "canvas"];

            type FileEntry = { filePath: string; peer: "owner" | "agent"; peerId: string; agentId?: string };
            const detected: FileEntry[] = [];

            function hasDetected(filePath: string, peerId: string): boolean {
              return detected.some((entry) => entry.filePath === filePath && entry.peerId === peerId);
            }

            function collectDir(dirPath: string, peerType: "owner" | "agent", agentId?: string): void {
              if (!fs.existsSync(dirPath)) return;
              const dirEntries = fs.readdirSync(dirPath, { withFileTypes: true });
              const peerId = peerType === "owner" ? OWNER_ID : `agent-${agentId ?? migrationDefaultAgentId}`;
              for (const e of dirEntries) {
                const full = path.join(dirPath, e.name);
                if (e.isDirectory()) collectDir(full, peerType, agentId);
                else if (!hasDetected(full, peerId)) detected.push({ filePath: full, peer: peerType, peerId, agentId });
              }
            }

            const ocHome = path.join(os.homedir(), ".openclaw");
            const defaultWorkspace = ((savedConfig?.agents as Record<string, unknown>)?.defaults as Record<string, unknown>)?.workspace as string | undefined;

            function uniqueWorkspacePaths(paths: Array<string | undefined>): string[] {
              const seen = new Set<string>();
              return paths.filter((p): p is string => typeof p === "string" && p.length > 0).filter((p) => {
                const real = fs.existsSync(p) ? fs.realpathSync(p) : p;
                if (seen.has(real)) return false;
                seen.add(real);
                return true;
              });
            }

            const selectedAgent = uploadRoute.agentId ? migrationAgents[0] : defaultAgent;
            const ownerCandidateWsPaths = uniqueWorkspacePaths([
              selectedAgent?.workspace as string,
              selectedAgent?.workspaceDir as string,
              selectedAgent?.isDefault ? workspaceDir as string : undefined,
              selectedAgent?.isDefault ? defaultWorkspace : undefined,
              selectedAgent ? path.join(ocHome, "agents", selectedAgent.id, "workspace") : undefined,
              selectedAgent?.isDefault ? path.join(ocHome, "workspace") : undefined,
              selectedAgent?.isDefault ? path.join(os.homedir(), ".clawdbot", "workspace") : undefined,
            ]);

            function scanWorkspace(wsDir: string, agentId?: string): void {
              // Owner files (USER.md) always route to the owner peer.
              for (const file of OWNER_FILES) {
                const p = path.join(wsDir, file);
                if (fs.existsSync(p) && !hasDetected(p, OWNER_ID))
                  detected.push({ filePath: p, peer: "owner", peerId: OWNER_ID });
              }
              // Agent files, MEMORY.md, and working dirs (memory/, canvas/)
              // are the agent's state — only collected when we know which
              // agent to assign them to. The owner-scan loop (no agentId)
              // skips these; the agent loop picks them up with the correct
              // peer. For the default agent, shared roots are included in
              // its candidate list, so nothing is missed.
              if (agentId) {
                const peerId = `agent-${agentId}`;
                for (const file of AGENT_FILES) {
                  const p = path.join(wsDir, file);
                  if (fs.existsSync(p) && !hasDetected(p, peerId))
                    detected.push({ filePath: p, peer: "agent", peerId, agentId });
                }
                for (const dir of AGENT_DIRS) {
                  collectDir(path.join(wsDir, dir), "agent", agentId);
                }
              }
            }

            const agentWorkspaceCandidates = migrationAgents.map((agent) => ({
              agentId: agent.id,
              peerId: `agent-${agent.id}`,
              workspacePaths: uniqueWorkspacePaths([
                agent.workspace,
                agent.workspaceDir,
                agent.isDefault ? (workspaceDir as string) : undefined,
                agent.isDefault ? defaultWorkspace : undefined,
                path.join(ocHome, "agents", agent.id, "workspace"),
                agent.isDefault ? path.join(ocHome, "workspace") : undefined,
                agent.isDefault ? path.join(os.homedir(), ".clawdbot", "workspace") : undefined,
              ]),
            }));

            // Owner loop: shared/default roots — only collects USER.md (owner peer).
            // Agent loop: each agent's candidate paths — collects agent files,
            // MEMORY.md, and working dirs (memory/, canvas/) under that agent's
            // peer. The default agent's candidates include shared roots, so
            // agent state in shared workspaces routes to the default agent.
            for (const candidate of ownerCandidateWsPaths) {
              scanWorkspace(candidate);
            }
            for (const agent of agentWorkspaceCandidates) {
              for (const candidate of agent.workspacePaths) {
                scanWorkspace(candidate, agent.agentId);
              }
            }

            // Still nothing — prompt user to enter additional paths manually
            if (detected.length === 0) {
              console.log("\nNo memory files found. Searched:");
              for (const c of ownerCandidateWsPaths) console.log(`  ${c}`);
              for (const agent of agentWorkspaceCandidates) {
                for (const c of agent.workspacePaths) console.log(`  ${c} (agent: ${agent.agentId})`);
              }
              console.log('\nEnter file or directory paths to upload (one per line, empty line to finish):');
              console.log('Format: /path/to/file-or-dir [owner|agent]  (peer defaults to "owner" if omitted)\n');
              while (true) {
                const entry = await ask("> ");
                if (!entry.trim()) break;
                const parts = entry.trim().split(/\s+/);
                const lastToken = parts[parts.length - 1];
                const peerType = (lastToken === "agent" || lastToken === "owner") && parts.length > 1
                  ? (lastToken as "owner" | "agent")
                  : "owner";
                const inputPath = (lastToken === "agent" || lastToken === "owner") && parts.length > 1
                  ? entry.trim().slice(0, entry.trim().lastIndexOf(lastToken)).trimEnd()
                  : entry.trim();
                if (!fs.existsSync(inputPath)) {
                  console.log(`  ! Not found: ${inputPath}`);
                  continue;
                }
                if (fs.statSync(inputPath).isDirectory()) {
                  collectDir(inputPath, peerType, peerType === "agent" ? migrationDefaultAgentId : undefined);
                  console.log(`  + ${inputPath}/ (directory) → ${peerType === "owner" ? OWNER_ID : migrationDefaultAgentPeerId}`);
                } else {
                  detected.push({
                    filePath: inputPath,
                    peer: peerType,
                    peerId: peerType === "owner" ? OWNER_ID : migrationDefaultAgentPeerId,
                    agentId: peerType === "agent" ? migrationDefaultAgentId : undefined,
                  });
                  console.log(`  + ${inputPath} → ${peerType === "owner" ? OWNER_ID : migrationDefaultAgentPeerId}`);
                }
              }
            }

            if (detected.length === 0) {
              console.log("\nNo files to upload.");
              console.log("\n✓ Setup complete. Run `openclaw gateway --force` to activate.\n");
              return;
            }

            console.log(`\nFound ${detected.length} memory file(s):`);
            console.log(`Migration agent: ${migrationDefaultAgentId} (peer: ${migrationDefaultAgentPeerId})`);
            if (migrationAgents.length > 1) {
              console.log(`Configured agents: ${migrationAgents.map((agent) => `${agent.id} (peer: agent-${agent.id})`).join(", ")}`);
            }
            for (const { filePath, peerId } of detected) {
              const size = fs.statSync(filePath).size;
              console.log(`  ${filePath} (${(size / 1024).toFixed(1)} KB) → ${peerId}`);
            }
            console.log(`\nData destination: ${resolvedBaseUrl}`);

            const uploadConfirm = await ask("\nUpload these files to Honcho? [y/N]: ");
            if (!["y", "yes"].includes(uploadConfirm.trim().toLowerCase())) {
              console.log("\nSkipping upload.");
              console.log("\n✓ Setup complete. Run `openclaw gateway --force` to activate.\n");
              return;
            }

            // Upload files to Honcho
            const setupHoncho = new Honcho({
              apiKey: resolvedApiKey || undefined,
              baseURL: resolvedBaseUrl,
              workspaceId: resolvedWorkspaceId,
            });

            const existingMeta = await setupHoncho.getMetadata();
            await setupHoncho.setMetadata({ ...existingMeta });
            const ownerPeerSetup = await setupHoncho.peer(OWNER_ID, { metadata: {} });
            const agentPeerSetupMap = new Map<string, Awaited<ReturnType<typeof setupHoncho.peer>>>();
            for (const agent of migrationAgents) {
              const peerId = `agent-${agent.id}`;
              const peer = await setupHoncho.peer(peerId, { metadata: { agentId: agent.id } });
              agentPeerSetupMap.set(agent.id, peer);
            }
            const migrationSession = await setupHoncho.session("migration-setup", { metadata: {} });
            await migrationSession.addPeers([ownerPeerSetup, { observeMe: true, observeOthers: false }]);
            for (const agent of migrationAgents) {
              await migrationSession.addPeers([
                agentPeerSetupMap.get(agent.id)!,
                { observeMe: true, observeOthers: true },
              ]);
            }

            // Cooldown after setup calls — the hosted platform (groudon) enforces
            // 5 req/sec per tenant; the 6 calls above consume most of that budget.
            await new Promise((r) => setTimeout(r, 1500));

            const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB safety cap
            const UPLOAD_DELAY_MS = 400; // stay under 5 req/sec platform limit

            const manifest = loadManifest();
            let uploadCount = 0;
            let unchangedCount = 0;
            const skipped: string[] = [];
            const failed: { filePath: string; error: string }[] = [];
            const total = detected.length;

            for (let i = 0; i < detected.length; i++) {
              const { filePath, peer, agentId } = detected[i];
              const progress = `[${i + 1}/${total}]`;

              const stat = await fs.promises.stat(filePath).catch(() => null);
              if (!stat?.isFile()) continue;
              if (stat.size > MAX_UPLOAD_BYTES) {
                console.log(`  ${progress} ! Skipping (larger than 5MB): ${filePath}`);
                skipped.push(filePath);
                continue;
              }
              const filename = path.basename(filePath);
              const ext = path.extname(filename).toLowerCase();
              const content_type = ext === ".json" ? "application/json" : ext === ".md" ? "text/markdown" : null;
              if (!content_type) {
                console.log(`  ${progress} ! Skipping unsupported type: ${filePath}`);
                skipped.push(filePath);
                continue;
              }

              const targetPeer = peer === "owner"
                ? ownerPeerSetup
                : agentPeerSetupMap.get(agentId ?? migrationDefaultAgentId);
              if (!targetPeer) {
                console.log(`  ${progress} ✗ Failed: ${filePath}`);
                failed.push({ filePath, error: `Missing Honcho peer for agent ${agentId ?? migrationDefaultAgentId}` });
                continue;
              }
              try {
                const content = await fs.promises.readFile(filePath);
                const hash = contentHash(content);

                // Skip files already uploaded with identical content to the same destination
                const manifestKey = uploadManifestKey(resolvedBaseUrl, resolvedWorkspaceId, filePath, targetPeer.id);
                // Old manifests were keyed only by path. Trust and upgrade
                // those entries only in the explicit safe legacy mode; routed
                // migrations must never infer a peer/workspace destination.
                const legacyPrev = uploadRoute.source === "legacy" ? manifest[filePath] : undefined;
                const prev = manifest[manifestKey] ?? legacyPrev;
                if (prev && prev.sha256 === hash && prev.baseUrl === resolvedBaseUrl && prev.workspaceId === resolvedWorkspaceId) {
                  console.log(`  ${progress} ~ Unchanged: ${filePath}`);
                  if (!manifest[manifestKey]) {
                    manifest[manifestKey] = { ...prev, filePath, peerId: targetPeer.id };
                    delete manifest[filePath];
                    saveManifest(manifest);
                  }
                  unchangedCount++;
                  continue;
                }

                await new Promise((r) => setTimeout(r, UPLOAD_DELAY_MS));
                await migrationSession.uploadFile({ filename, content, content_type }, targetPeer, {});
                console.log(`  ${progress} ✓ Uploaded: ${filePath}`);
                uploadCount++;

                // Record success
                manifest[manifestKey] = {
                  sha256: hash,
                  uploadedAt: new Date().toISOString(),
                  baseUrl: resolvedBaseUrl,
                  workspaceId: resolvedWorkspaceId,
                  filePath,
                  peerId: targetPeer.id,
                };
                saveManifest(manifest);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.log(`  ${progress} ✗ Failed: ${filePath}`);
                failed.push({ filePath, error: msg });
              }
            }

            // Clean stale manifest entries
            pruneStaleUploadManifestEntries(manifest);
            saveManifest(manifest);

            // Summary
            console.log(`\nUpload summary:`);
            console.log(`  Uploaded:  ${uploadCount}/${total}`);
            if (unchangedCount > 0) console.log(`  Unchanged: ${unchangedCount}`);
            if (skipped.length > 0) console.log(`  Skipped:   ${skipped.length}`);
            if (failed.length > 0) {
              console.log(`  Failed:    ${failed.length}`);
              for (const f of failed) {
                console.log(`    ! ${f.filePath} — ${f.error}`);
              }
              console.log(`\nRun \`openclaw honcho setup\` again to retry failed files.`);
            }

            console.log("\n✓ Setup complete. Run `openclaw gateway --force` to activate.\n");
          } finally {
            rl.close();
          }
        });

      cmd
        .command("status")
        .description("Show Honcho connection status")
        .option("-a, --agent <id>", "Agent whose workspace status to inspect")
        .action(async (options: { agent?: string }) => {
          try {
            const route = resolveCliWorkspace(state.cfg, { agent: options.agent });
            const workspace = state.getWorkspaceState(route.workspaceId);
            await workspace.ensureInitialized();
            const agentId = route.agentId ?? workspace.resolveDefaultAgentId();
            const defaultPeer = await workspace.getAgentPeer(agentId);

            console.log("Connected to Honcho");
            console.log(`  Workspace: ${route.workspaceId}`);
            console.log(`  Agent: ${agentId} → peer "${defaultPeer.id}"`);
            console.log(`  Agent peers mapped: ${Object.keys(workspace.agentPeerMap).join(", ") || "(none)"}`);
          } catch (error) {
            console.error(`Failed to connect: ${error}`);
          }
        });

      cmd
        .command("ask <question>")
        .description("Ask Honcho about the user")
        .option("-a, --agent <id>", "Agent ID to query as (default: primary agent)")
        .option("-p, --peer <id>", "Channel peer ID or Honcho peer ID to target (default: owner)")
        .action(async (question: string, options: { agent?: string; peer?: string }) => {
          try {
            const route = resolveCliWorkspace(state.cfg, { agent: options.agent });
            const workspace = state.getWorkspaceState(route.workspaceId);
            await workspace.ensureInitialized();
            const agentPeer = await workspace.getAgentPeer(route.agentId ?? workspace.resolveDefaultAgentId());
            const participantPeer = await workspace.getParticipantPeer(requiredCliId(options.peer, "peer"));
            const answer = await agentPeer.chat(question, { target: participantPeer });
            console.log(answer ?? "No information available.");
          } catch (error) {
            console.error(`Failed to query: ${error}`);
          }
        });

      cmd
        .command("search <query>")
        .description("Semantic search over Honcho memory")
        .option("-k, --top-k <number>", "Number of results to return", "10")
        .option("-d, --max-distance <number>", "Maximum semantic distance (0-1)", "0.5")
        .option("-a, --agent <id>", "Agent whose workspace to search")
        .option("-p, --peer <id>", "Channel peer ID or Honcho peer ID to target (default: owner)")
        .action(async (query: string, options: { topK: string; maxDistance: string; agent?: string; peer?: string }) => {
          try {
            const route = resolveCliWorkspace(state.cfg, { agent: options.agent });
            const topK = positiveInteger(options.topK, "top-k");
            const maxDistance = unitInterval(options.maxDistance, "max-distance");
            const workspace = state.getWorkspaceState(route.workspaceId);
            await workspace.ensureInitialized();
            const participantPeer = await workspace.getParticipantPeer(requiredCliId(options.peer, "peer"));
            const representation = await participantPeer.representation({
              searchQuery: query,
              searchTopK: topK,
              searchMaxDistance: maxDistance,
            });

            if (!representation) {
              console.log(`No relevant memories found for: "${query}"`);
              return;
            }

            console.log(representation);
          } catch (error) {
            console.error(`Search failed: ${error}`);
          }
        });
    },
    { commands: ["honcho"] }
  );
}
