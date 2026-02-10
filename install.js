import fs from "fs";
import os from "os";
import path from "path";

// ============================================================================
// Install script: Migrate legacy memory data to Honcho
// Workspace doc updates are handled by the honcho_setup skill.
// ============================================================================

async function loadEnvFile() {
  const envPath = path.join(os.homedir(), ".openclaw", ".env");
  try {
    const content = await fs.promises.readFile(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  } catch {
    // .env file doesn't exist, that's fine
  }
}

await loadEnvFile();

const explicitWorkspace = process.env.WORKSPACE_ROOT;
const workspaceRoot = await resolveWorkspaceRoot();

async function fileExists(filePath) {
  try {
    await fs.promises.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadWorkspaceFromConfig() {
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
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

  candidates.push(path.join(os.homedir(), ".openclaw", "workspace"));

  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = candidate.replace(/^~(?=$|\/)/, os.homedir());
    if (await fileExists(resolved)) {
      return resolved;
    }
  }

  return process.cwd();
}

// ============================================================================
// Migration: Move legacy memory files to Honcho and archive them
// ============================================================================

const ownerFiles = new Set(["USER.md", "IDENTITY.md", "MEMORY.md"]);
const openclawFiles = new Set([
  "SOUL.md",
  "AGENTS.md",
  "TOOLS.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
]);

const filesToMigrate = [
  "AGENTS.md",
  "IDENTITY.md",
  "MEMORY.md",
  "TOOLS.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
  "SOUL.md",
  "USER.md",
];
const dirsToMigrate = ["memory", "canvas"];

// All files get copied to archive/ as backup.
// Legacy-only files are then removed from the workspace.
// Workspace docs are left in place for the skill to update.
const filesToArchive = [
  "USER.md",
  "MEMORY.md",
  "IDENTITY.md",
  "HEARTBEAT.md",
  "AGENTS.md",
  "BOOTSTRAP.md",
  "SOUL.md",
  "TOOLS.md",
];
const dirsToArchive = ["memory", "canvas"];
const legacyOnlyFiles = new Set(["USER.md", "MEMORY.md", "IDENTITY.md", "HEARTBEAT.md"]);
const archiveDirName = "archive";

function isAboutOwner(relativePath) {
  const baseName = path.basename(relativePath);
  if (ownerFiles.has(baseName)) return true;
  if (openclawFiles.has(baseName)) return false;
  return true;
}

async function collectFromDir(dirPath, relativePath, conclusions) {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const nextRelative = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      await collectFromDir(fullPath, nextRelative, conclusions);
    } else if (entry.isFile()) {
      try {
        const content = (await fs.promises.readFile(fullPath, "utf8")).trim();
        if (content) {
          conclusions.push({
            content: `Memory file: ${nextRelative}\n\n${content}`,
            isAboutOwner: isAboutOwner(nextRelative),
          });
          console.log(`  Found: ${nextRelative}`);
        }
      } catch (e) {
        console.warn(`  Warning: Could not read ${nextRelative}`);
      }
    }
  }
}

async function ensureDir(dirPath) {
  try {
    await fs.promises.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

async function uniqueArchivePath(archiveDir, name) {
  let candidate = path.join(archiveDir, name);
  if (!(await fileExists(candidate))) return candidate;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  let attempt = 0;
  while (true) {
    const suffix = attempt === 0 ? timestamp : `${timestamp}-${attempt}`;
    const nextName = `${name}-${suffix}`;
    candidate = path.join(archiveDir, nextName);
    if (!(await fileExists(candidate))) return candidate;
    attempt += 1;
  }
}

async function migrateAndCleanup() {
  console.log("");
  console.log("Checking for legacy memory files to migrate...");
  console.log(`Workspace: ${workspaceRoot}`);
  console.log("");

  const conclusions = [];

  for (const file of filesToMigrate) {
    const filePath = path.join(workspaceRoot, file);
    try {
      const content = (await fs.promises.readFile(filePath, "utf8")).trim();
      if (content) {
        conclusions.push({
          content: `Memory file: ${file}\n\n${content}`,
          isAboutOwner: isAboutOwner(file),
        });
        console.log(`  Found: ${file}`);
      }
    } catch {
      // File doesn't exist, skip
    }
  }

  for (const dir of dirsToMigrate) {
    const dirPath = path.join(workspaceRoot, dir);
    try {
      await fs.promises.stat(dirPath);
      await collectFromDir(dirPath, dir, conclusions);
    } catch {
      // Directory doesn't exist, skip
    }
  }

  if (conclusions.length === 0) {
    console.log("No legacy memory files found. Nothing to migrate.");
    return;
  }

  const ownerConclusions = conclusions.filter((c) => c.isAboutOwner);
  const selfConclusions = conclusions.filter((c) => !c.isAboutOwner);

  console.log("");
  console.log(`Found ${conclusions.length} files to migrate:`);
  console.log(
    `  - ${ownerConclusions.length} about the user (USER.md, IDENTITY.md, etc.)`,
  );
  console.log(
    `  - ${selfConclusions.length} about openclaw (SOUL.md, AGENTS.md, etc.)`,
  );

  const apiKey = process.env.HONCHO_API_KEY;
  if (apiKey) {
    try {
      console.log("");
      console.log("Migrating to Honcho...");

      const { Honcho } = await import("@honcho-ai/sdk");
      const honcho = new Honcho({
        apiKey,
        baseURL: process.env.HONCHO_BASE_URL || "https://api.honcho.dev",
        workspaceId: process.env.HONCHO_WORKSPACE_ID || "openclaw",
      });

      await honcho.setMetadata({});

      const openclawPeer = await honcho.peer("openclaw", { metadata: {} });
      const ownerPeer = await honcho.peer("owner", { metadata: {} });

      if (ownerConclusions.length > 0) {
        await openclawPeer
          .conclusionsOf(ownerPeer)
          .create(ownerConclusions.map((c) => ({ content: c.content })));
        console.log(
          `  Created ${ownerConclusions.length} conclusions about user`,
        );
      }

      if (selfConclusions.length > 0) {
        await openclawPeer.conclusions.create(
          selfConclusions.map((c) => ({ content: c.content })),
        );
        console.log(
          `  Created ${selfConclusions.length} openclaw self-conclusions`,
        );
      }
    } catch (error) {
      console.error("");
      console.error(`Error: Could not migrate to Honcho: ${error.message}`);
      console.error("Legacy files will NOT be archived to prevent data loss.");
      console.error("Fix the issue above and re-run the install.");
      return;
    }
  } else {
    console.log("");
    console.warn("HONCHO_API_KEY not set — skipping Honcho migration.");
    console.warn("Legacy files will NOT be archived to prevent data loss.");
    console.warn("");
    console.warn("Set your API key first:");
    console.warn("  echo 'HONCHO_API_KEY=hc_...' >> ~/.openclaw/.env");
    console.warn("");
    console.warn("Then re-run: npm install");
    return;
  }

  // Copy all files to archive/ as backup
  console.log("");
  console.log("Backing up files to archive/...");

  const archiveDir = path.join(workspaceRoot, archiveDirName);
  await ensureDir(archiveDir);

  for (const file of filesToArchive) {
    const targetPath = path.join(workspaceRoot, file);
    if (await fileExists(targetPath)) {
      const destination = await uniqueArchivePath(archiveDir, file);
      const archivedName = path.basename(destination);
      await fs.promises.copyFile(targetPath, destination);
      console.log(
        `  Backed up: ${file} -> ${path.join(archiveDirName, archivedName)}`,
      );
      // Remove legacy-only files; workspace docs stay for the skill to update
      if (legacyOnlyFiles.has(file)) {
        await fs.promises.unlink(targetPath);
        console.log(`  Removed: ${file}`);
      }
    }
  }

  for (const dir of dirsToArchive) {
    const targetPath = path.join(workspaceRoot, dir);
    if (await fileExists(targetPath)) {
      const destination = await uniqueArchivePath(archiveDir, dir);
      const archivedName = path.basename(destination);
      await fs.promises.rename(targetPath, destination);
      console.log(
        `  Backed up: ${dir}/ -> ${path.join(archiveDirName, archivedName)}/`,
      );
    }
  }

  console.log("");
  console.log("Migration complete!");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("Installing openclaw-honcho plugin...");
  console.log(`Workspace root: ${workspaceRoot}`);

  await migrateAndCleanup();

  console.log("");
  console.log("Plugin installed successfully!");
  console.log("Run the honcho_setup skill from your OpenClaw agent to update workspace docs.");
  console.log("");
}

main().catch((error) => {
  console.error("Install failed:", error);
  process.exit(1);
});
