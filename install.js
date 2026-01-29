import fs from "fs";
import os from "os";
import path from "path";
import { Honcho } from "@honcho-ai/sdk";

const OWNER_ID = "owner";
const MOLTBOT_ID = "moltbot";

const filesToBackup = [
  "AGENTS.md",
  "IDENTITY.md",
  "MEMORY.md",
  "TOOLS.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
  "SOUL.md",
  "USER.md",
];

const dirsToBackup = ["memory", "canvas"];

// Files that contain information ABOUT the owner (observed by moltbot)
const ownerFiles = new Set(["USER.md", "IDENTITY.md", "MEMORY.md"]);
// Files that contain information ABOUT moltbot itself (self-conclusions)
const moltbotFiles = new Set(["SOUL.md", "AGENTS.md", "TOOLS.md", "BOOTSTRAP.md", "HEARTBEAT.md"]);

const explicitWorkspace = process.env.WORKSPACE_ROOT;
const workspaceRoot = await resolveWorkspaceRoot();

const docsToSync = [
  { sources: ["workspace_md/BOOTSTRAP.md"], targets: ["BOOTSTRAP.md"] },
  { sources: ["workspace_md/SOUL.md"], targets: ["SOUL.md"] },
  {
    sources: ["workspace_md/AGENTS.md"],
    targets: ["AGENTS.md"],
  },
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

  candidates.push(path.join(os.homedir(), "clawd"), path.join(os.homedir(), "moltbot"));

  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = candidate.replace(/^~(?=$|\/)/, os.homedir());
    if (await fileExists(resolved)) {
      return resolved;
    }
  }

  return process.cwd();
}

async function hasAnyMemoryFiles(root) {
  for (const file of filesToBackup) {
    if (await fileExists(path.join(root, file))) return true;
  }

  for (const dir of dirsToBackup) {
    if (await fileExists(path.join(root, dir))) return true;
  }

  return false;
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

function formatConclusion(relativePath, content) {
  const trimmed = content.trim();
  if (!trimmed) return "";
  return `Memory file: ${relativePath}\n\n${trimmed}`;
}

function isAboutOwner(relativePath) {
  const baseName = path.basename(relativePath);
  if (ownerFiles.has(baseName)) return true;
  if (moltbotFiles.has(baseName)) return false;
  // Default: files in memory/canvas dirs are about the owner
  return true;
}

async function addFileConclusion(filePath, relativePath, conclusions) {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    const formatted = formatConclusion(relativePath, content);
    if (!formatted) return;
    conclusions.push({
      content: formatted,
      isAboutOwner: isAboutOwner(relativePath),
    });
    console.log(`Queued: ${relativePath}`);
  } catch (error) {
    console.error(`Error reading ${relativePath}:`, error);
  }
}

async function backupDirectory(dirPath, relativePath, conclusions) {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const nextRelative = path.join(relativePath, entry.name);

    if (entry.isDirectory()) {
      await backupDirectory(fullPath, nextRelative, conclusions);
    } else if (entry.isFile()) {
      await addFileConclusion(fullPath, nextRelative, conclusions);
    }
  }
}

async function backupToHoncho() {
  console.log("Starting one-time backup of memory files to Honcho using conclusions...");
  console.log(`Workspace root: ${workspaceRoot}`);

  const apiKey = process.env.HONCHO_API_KEY;
  const baseURL = process.env.HONCHO_BASE_URL ?? "https://api.honcho.dev";
  const workspaceId = process.env.HONCHO_WORKSPACE_ID ?? "moltbot";

  if (!apiKey) {
    console.warn("HONCHO_API_KEY is not set. Skipping one-time backup.");
    return;
  }

  const honcho = new Honcho({ apiKey, baseURL, workspaceId });
  const moltbotPeer = await honcho.peer(MOLTBOT_ID);
  const ownerPeer = await honcho.peer(OWNER_ID);

  const conclusions = [];

  // Collect conclusions from individual files
  for (const file of filesToBackup) {
    const filePath = path.join(workspaceRoot, file);
    if (await fileExists(filePath)) {
      await addFileConclusion(filePath, file, conclusions);
    }
  }

  // Collect conclusions from directories
  for (const dir of dirsToBackup) {
    const dirPath = path.join(workspaceRoot, dir);
    if (await fileExists(dirPath)) {
      await backupDirectory(dirPath, dir, conclusions);
    }
  }

  if (!conclusions.length) {
    console.log("No memory files found to back up.");
    return;
  }

  // Separate conclusions by type
  const ownerConclusions = conclusions
    .filter((c) => c.isAboutOwner)
    .map((c) => ({ content: c.content }));

  const selfConclusions = conclusions
    .filter((c) => !c.isAboutOwner)
    .map((c) => ({ content: c.content }));

  // Create conclusions in batch
  if (ownerConclusions.length > 0) {
    // Moltbot's conclusions about the owner
    await moltbotPeer.conclusionsOf(ownerPeer).create(ownerConclusions);
    console.log(`Created ${ownerConclusions.length} conclusions about owner`);
  }

  if (selfConclusions.length > 0) {
    // Moltbot's self-conclusions
    await moltbotPeer.conclusions.create(selfConclusions);
    console.log(`Created ${selfConclusions.length} moltbot self-conclusions`);
  }

  await updateWorkspaceDocs();

  console.log(`One-time backup completed (${conclusions.length} total conclusions created).`);
}

backupToHoncho().catch((error) => {
  console.error("Backup failed:", error);
  process.exit(1);
});
