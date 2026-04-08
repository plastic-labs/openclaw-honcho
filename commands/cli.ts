import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { Honcho } from "@honcho-ai/sdk";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { OWNER_ID } from "../state.js";

/* ── Upload manifest ─────────────────────────────────────────────────── */

type ManifestEntry = { sha256: string; uploadedAt: string; baseUrl: string; workspaceId: string };
type UploadManifest = Record<string, ManifestEntry>;

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

function contentHash(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function registerCli(api: OpenClawPluginApi, state: PluginState): void {
  api.registerCli(
    ({ program, workspaceDir }) => {
      const cmd = program.command("honcho").description("Honcho memory commands");

      cmd
        .command("setup")
        .description("Configure Honcho API key and upload memory files to Honcho")
        .option("--reconfigure", "Force re-entry of all configuration values")
        .action(async (options: { reconfigure?: boolean }) => {
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
            const defaultAgentPeerId = `agent-${defaultAgentId}`;

            const OWNER_FILES = ["USER.md", "MEMORY.md"];
            const AGENT_FILES = ["SOUL.md", "IDENTITY.md", "AGENTS.md", "TOOLS.md", "BOOTSTRAP.md"];
            const OWNER_DIRS = ["memory", "canvas"];

            type FileEntry = { filePath: string; peer: "owner" | "agent"; peerId: string; agentId?: string };
            const detected: FileEntry[] = [];

            function hasDetected(filePath: string, peerId: string): boolean {
              return detected.some((entry) => entry.filePath === filePath && entry.peerId === peerId);
            }

            function collectDir(dirPath: string, peerType: "owner" | "agent", agentId?: string): void {
              if (!fs.existsSync(dirPath)) return;
              const dirEntries = fs.readdirSync(dirPath, { withFileTypes: true });
              const peerId = peerType === "owner" ? OWNER_ID : `agent-${agentId ?? defaultAgentId}`;
              for (const e of dirEntries) {
                const full = path.join(dirPath, e.name);
                if (e.isDirectory()) collectDir(full, peerType, agentId);
                else if (!hasDetected(full, peerId)) detected.push({ filePath: full, peer: peerType, peerId, agentId });
              }
            }

            function scanWorkspace(wsDir: string, agentId?: string): void {
              for (const file of OWNER_FILES) {
                const p = path.join(wsDir, file);
                if (fs.existsSync(p) && !hasDetected(p, OWNER_ID))
                  detected.push({ filePath: p, peer: "owner", peerId: OWNER_ID });
              }
              if (agentId) {
                const peerId = `agent-${agentId}`;
                for (const file of AGENT_FILES) {
                  const p = path.join(wsDir, file);
                  if (fs.existsSync(p) && !hasDetected(p, peerId))
                    detected.push({ filePath: p, peer: "agent", peerId, agentId });
                }
              }
              for (const dir of OWNER_DIRS) {
                collectDir(path.join(wsDir, dir), "owner");
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

            const ownerCandidateWsPaths = uniqueWorkspacePaths([
              workspaceDir as string,
              defaultAgent?.workspace as string,
              defaultAgent?.workspaceDir as string,
              defaultWorkspace,
              path.join(ocHome, "workspace"),
              path.join(os.homedir(), ".clawdbot", "workspace"),
            ]);

            const agentWorkspaceCandidates = normalizedAgents.map((agent) => ({
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

            // Scan shared/default workspace roots only for owner files. Agent files
            // must come from an agent-specific workspace path so they can be
            // assigned to the correct `agent-{id}` peer.
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
                  collectDir(inputPath, peerType, peerType === "agent" ? defaultAgentId : undefined);
                  console.log(`  + ${inputPath}/ (directory) → ${peerType === "owner" ? OWNER_ID : defaultAgentPeerId}`);
                } else {
                  detected.push({
                    filePath: inputPath,
                    peer: peerType,
                    peerId: peerType === "owner" ? OWNER_ID : defaultAgentPeerId,
                    agentId: peerType === "agent" ? defaultAgentId : undefined,
                  });
                  console.log(`  + ${inputPath} → ${peerType === "owner" ? OWNER_ID : defaultAgentPeerId}`);
                }
              }
            }

            if (detected.length === 0) {
              console.log("\nNo files to upload.");
              console.log("\n✓ Setup complete. Run `openclaw gateway --force` to activate.\n");
              return;
            }

            console.log(`\nFound ${detected.length} memory file(s):`);
            console.log(`Default agent: ${defaultAgentId} (peer: ${defaultAgentPeerId})`);
            if (normalizedAgents.length > 1) {
              console.log(`Configured agents: ${normalizedAgents.map((agent) => `${agent.id} (peer: agent-${agent.id})`).join(", ")}`);
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
            for (const agent of normalizedAgents) {
              const peerId = `agent-${agent.id}`;
              const peer = await setupHoncho.peer(peerId, { metadata: { agentId: agent.id } });
              agentPeerSetupMap.set(agent.id, peer);
            }
            const migrationSession = await setupHoncho.session("migration-setup", { metadata: {} });
            await migrationSession.addPeers([ownerPeerSetup, { observeMe: true, observeOthers: false }]);
            for (const agent of normalizedAgents) {
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
                : agentPeerSetupMap.get(agentId ?? defaultAgentId);
              if (!targetPeer) {
                console.log(`  ${progress} ✗ Failed: ${filePath}`);
                failed.push({ filePath, error: `Missing Honcho peer for agent ${agentId ?? defaultAgentId}` });
                continue;
              }
              try {
                const content = await fs.promises.readFile(filePath);
                const hash = contentHash(content);

                // Skip files already uploaded with identical content to the same destination
                const prev = manifest[filePath];
                if (prev && prev.sha256 === hash && prev.baseUrl === resolvedBaseUrl && prev.workspaceId === resolvedWorkspaceId) {
                  console.log(`  ${progress} ~ Unchanged: ${filePath}`);
                  unchangedCount++;
                  continue;
                }

                await new Promise((r) => setTimeout(r, UPLOAD_DELAY_MS));
                await migrationSession.uploadFile({ filename, content, content_type }, targetPeer, {});
                console.log(`  ${progress} ✓ Uploaded: ${filePath}`);
                uploadCount++;

                // Record success
                manifest[filePath] = { sha256: hash, uploadedAt: new Date().toISOString(), baseUrl: resolvedBaseUrl, workspaceId: resolvedWorkspaceId };
                saveManifest(manifest);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.log(`  ${progress} ✗ Failed: ${filePath}`);
                failed.push({ filePath, error: msg });
              }
            }

            // Clean stale manifest entries
            for (const key of Object.keys(manifest)) {
              if (!fs.existsSync(key)) delete manifest[key];
            }
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
        .action(async () => {
          try {
            await state.ensureInitialized();
            const defaultPeer = await state.getAgentPeer(state.resolveDefaultAgentId());

            console.log("Connected to Honcho");
            console.log(`  Workspace: ${state.cfg.workspaceId}`);
            console.log(`  Default agent: ${state.resolveDefaultAgentId()} → peer "${defaultPeer.id}"`);
            console.log(`  Agent peers mapped: ${Object.keys(state.agentPeerMap).join(", ") || "(none)"}`);
          } catch (error) {
            console.error(`Failed to connect: ${error}`);
          }
        });

      cmd
        .command("ask <question>")
        .description("Ask Honcho about the user")
        .option("-a, --agent <id>", "Agent ID to query as (default: primary agent)")
        .action(async (question: string, options: { agent?: string }) => {
          try {
            await state.ensureInitialized();
            const agentPeer = await state.getAgentPeer(options.agent ?? state.resolveDefaultAgentId());
            const answer = await agentPeer.chat(question, { target: state.ownerPeer! });
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
        .action(async (query: string, options: { topK: string; maxDistance: string }) => {
          try {
            await state.ensureInitialized();
            const representation = await state.ownerPeer!.representation({
              searchQuery: query,
              searchTopK: parseInt(options.topK, 10),
              searchMaxDistance: parseFloat(options.maxDistance),
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
