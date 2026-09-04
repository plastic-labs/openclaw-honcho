import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Path of the OpenClaw config file, resolved the way OpenClaw itself does:
 * `OPENCLAW_CONFIG_PATH` is the file itself; otherwise `openclaw.json` inside
 * `OPENCLAW_STATE_DIR`, defaulting to `~/.openclaw`.
 */
export function resolveOpenClawConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return explicit;
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw");
  return join(stateDir, "openclaw.json");
}
