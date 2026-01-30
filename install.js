import fs from "fs";
import os from "os";
import path from "path";

// ============================================================================
// Install script: Sync workspace docs, migrate data to Honcho, clean up legacy files
// ============================================================================

// Load API key from ~/.openclaw/.env if not already in environment
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
        const value = match[2].trim().replace(/^["']|["']$/g, ""); // strip quotes
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
// Migration: Move legacy memory files to Honcho and delete them
// ============================================================================

// Files that contain information ABOUT the owner (observed by openclaw)
const ownerFiles = new Set(["USER.md", "IDENTITY.md", "MEMORY.md"]);
// Files that contain information ABOUT openclaw itself (self-conclusions)
const openclawFiles = new Set(["SOUL.md", "AGENTS.md", "TOOLS.md", "BOOTSTRAP.md", "HEARTBEAT.md"]);

const filesToMigrate = [
  "AGENTS.md", "IDENTITY.md", "MEMORY.md", "TOOLS.md",
  "BOOTSTRAP.md", "HEARTBEAT.md", "SOUL.md", "USER.md",
];
const dirsToMigrate = ["memory", "canvas"];

// Files/dirs to delete after migration (legacy files that interfere with plugin)
const filesToDelete = ["USER.md", "MEMORY.md"];
const dirsToDelete = ["memory"];

function isAboutOwner(relativePath) {
  const baseName = path.basename(relativePath);
  if (ownerFiles.has(baseName)) return true;
  if (openclawFiles.has(baseName)) return false;
  return true; // Default: files in memory/canvas dirs are about the owner
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

async function migrateAndCleanup() {
  console.log("");
  console.log("Migrating legacy memory files...");
  console.log(`Workspace: ${workspaceRoot}`);
  console.log("");

  const conclusions = [];

  // Collect from individual files
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

  // Collect from directories
  for (const dir of dirsToMigrate) {
    const dirPath = path.join(workspaceRoot, dir);
    try {
      await fs.promises.stat(dirPath);
      await collectFromDir(dirPath, dir, conclusions);
    } catch {
      // Directory doesn't exist, skip
    }
  }

  const ownerConclusions = conclusions.filter((c) => c.isAboutOwner);
  const selfConclusions = conclusions.filter((c) => !c.isAboutOwner);

  if (conclusions.length > 0) {
    console.log("");
    console.log(`Found ${conclusions.length} files to migrate:`);
    console.log(`  - ${ownerConclusions.length} about the user (USER.md, IDENTITY.md, etc.)`);
    console.log(`  - ${selfConclusions.length} about openclaw (SOUL.md, AGENTS.md, etc.)`);
  }

  // Try to migrate to Honcho if API key is available
  const apiKey = process.env.HONCHO_API_KEY;
  let migrationSucceeded = false;

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

      // Get or create peers
      const openclawPeer = await honcho.peer("openclaw");
      const ownerPeer = await honcho.peer("owner");

      if (ownerConclusions.length > 0) {
        await openclawPeer.conclusionsOf(ownerPeer).create(
          ownerConclusions.map((c) => ({ content: c.content }))
        );
        console.log(`  ✓ Created ${ownerConclusions.length} conclusions about user`);
      }

      if (selfConclusions.length > 0) {
        await openclawPeer.conclusions.create(
          selfConclusions.map((c) => ({ content: c.content }))
        );
        console.log(`  ✓ Created ${selfConclusions.length} openclaw self-conclusions`);
      }

      migrationSucceeded = true;
    } catch (error) {
      console.error("");
      console.error(`Error: Could not migrate to Honcho: ${error.message}`);
      console.error("Legacy files will NOT be removed to prevent data loss.");
      console.error("Fix the issue above and re-run the install.");
      return;
    }
  } else {
    console.log("");
    console.error("Error: HONCHO_API_KEY not set.");
    console.error("Legacy files will NOT be removed to prevent data loss.");
    console.error("");
    console.error("Set your API key first:");
    console.error("  echo 'HONCHO_API_KEY=hc_...' >> ~/.openclaw/.env");
    console.error("");
    console.error("Then re-run: npm install");
    return;
  }

  // Only clean up legacy files if migration succeeded
  console.log("");
  console.log("Cleaning up legacy files...");

  for (const file of filesToDelete) {
    const targetPath = path.join(workspaceRoot, file);
    if (await fileExists(targetPath)) {
      await fs.promises.rm(targetPath, { force: true });
      console.log(`  Removed: ${file}`);
    }
  }

  for (const dir of dirsToDelete) {
    const targetPath = path.join(workspaceRoot, dir);
    if (await fileExists(targetPath)) {
      await fs.promises.rm(targetPath, { recursive: true, force: true });
      console.log(`  Removed: ${dir}/`);
    }
  }

  console.log("");
  console.log("✓ Migration complete!");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("Installing openclaw-honcho plugin...");
  console.log(`Workspace root: ${workspaceRoot}`);

  await updateWorkspaceDocs();
  await migrateAndCleanup();

  console.log("");
  console.log("✓ Plugin installed successfully!");
  console.log("");
}

main().catch((error) => {
  console.error("Install failed:", error);
  process.exit(1);
});
