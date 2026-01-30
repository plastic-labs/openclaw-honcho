import fs from "fs";
import os from "os";
import path from "path";

// ============================================================================
// Install script: Sync workspace docs only
// Migration to Honcho is done separately via: openclaw honcho migrate
// ============================================================================

const explicitWorkspace = process.env.WORKSPACE_ROOT;
const workspaceRoot = await resolveWorkspaceRoot();

const docsToSync = [
  { sources: ["workspace_md/BOOTSTRAP.md"], targets: ["BOOTSTRAP.md"] },
  { sources: ["workspace_md/SOUL.md"], targets: ["SOUL.md"] },
  { sources: ["workspace_md/AGENTS.md"], targets: ["AGENTS.md"] },
];

async function fileExists(filePath) {
  try {
    await fs.promises.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadWorkspaceFromConfig() {
  const configPath = path.join(os.homedir(), ".clawdbot", "moltbot.json");
  try {
    const raw = await fs.promises.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const agentWorkspace =
      parsed?.agent?.workspace ??
      parsed?.agents?.defaults?.workspace ??
      parsed?.agents?.defaults?.workspaceDir;
    return typeof agentWorkspace === "string" ? agentWorkspace : null;
  } catch {
    return null;
  }
}

async function resolveWorkspaceRoot() {
  if (explicitWorkspace) {
    return explicitWorkspace.replace(/^~(?=$|\/)/, os.homedir());
  }

  const candidates = [];
  const configured = await loadWorkspaceFromConfig();
  if (configured) candidates.push(configured);

  const profile = process.env.CLAWDBOT_PROFILE;
  if (profile && profile !== "default") {
    candidates.push(path.join(os.homedir(), `clawd-${profile}`));
  }

  candidates.push(
    path.join(os.homedir(), "clawd"),
    path.join(os.homedir(), "moltbot"),
    path.join(os.homedir(), ".openclaw", "workspace")
  );

  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = candidate.replace(/^~(?=$|\/)/, os.homedir());
    if (await fileExists(resolved)) {
      return resolved;
    }
  }

  return process.cwd();
}

async function updateWorkspaceDocs() {
  const repoRoot = process.cwd();

  for (const doc of docsToSync) {
    const sourcePath = await resolveDocSource(repoRoot, doc.sources);
    if (!sourcePath) {
      console.warn(`Source doc missing, skipping: ${doc.sources.join(", ")}`);
      continue;
    }

    const sourceContents = await fs.promises.readFile(sourcePath, "utf8");

    for (const target of doc.targets) {
      const targetPath = path.join(workspaceRoot, target);
      if (!(await fileExists(targetPath))) {
        console.log(`Workspace doc not found, skipping: ${target}`);
        continue;
      }
      await fs.promises.writeFile(targetPath, sourceContents, "utf8");
      console.log(`Updated workspace doc: ${target}`);
    }
  }
}

async function resolveDocSource(repoRoot, sources) {
  for (const source of sources) {
    const sourcePath = path.join(repoRoot, source);
    if (await fileExists(sourcePath)) return sourcePath;
  }
  return null;
}

// ============================================================================
// Main: Sync workspace docs and print migration instructions
// ============================================================================

async function main() {
  console.log("Installing moltbot-honcho plugin...");
  console.log(`Workspace root: ${workspaceRoot}`);

  await updateWorkspaceDocs();

  console.log("");
  console.log("✓ Plugin installed successfully!");
  console.log("");
  console.log("Next steps:");
  console.log("1. Configure your Honcho API key in ~/.openclaw/openclaw.json:");
  console.log('   { "plugins": { "moltbot-honcho": { "apiKey": "hch-v2-..." } } }');
  console.log("");
  console.log("2. If you have existing memory files to migrate, run:");
  console.log("   openclaw honcho migrate");
  console.log("");
}

main().catch((error) => {
  console.error("Install failed:", error);
  process.exit(1);
});
