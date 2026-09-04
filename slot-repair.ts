import { readFileSync, writeFileSync } from "node:fs";

export const PLUGIN_ID = "openclaw-honcho";

/**
 * Remove a `plugins.slots.contextEngine` pin that points at this plugin.
 *
 * The plugin declares `kind: ["memory", "context-engine"]` only so that OpenClaw
 * >= 2026.8 keeps it loaded when `memory-core` owns the memory slot. It registers
 * no context engine. OpenClaw's `plugins install` / `plugins enable` pin every
 * slot a plugin's kind implies, so they also write
 * `plugins.slots.contextEngine = "openclaw-honcho"`, and the gateway then logs a
 * "degraded to legacy" warning on every turn. Dropping the pin restores the
 * implicit default ("legacy"), which is what OpenClaw would have used anyway.
 *
 * Pure: returns a new object and whether anything changed. Never touches
 * `plugins.slots.memory`.
 */
export function stripContextEngineSlot(config: Record<string, any>): {
  config: Record<string, any>;
  changed: boolean;
} {
  const slots = config?.plugins?.slots;
  if (!slots || typeof slots !== "object" || slots.contextEngine !== PLUGIN_ID) {
    return { config, changed: false };
  }
  const { contextEngine: _dropped, ...remainingSlots } = slots;
  const plugins = { ...config.plugins };
  if (Object.keys(remainingSlots).length > 0) {
    plugins.slots = remainingSlots;
  } else {
    delete plugins.slots;
  }
  return { config: { ...config, plugins }, changed: true };
}

export type SlotRepairLogger = { warn: (msg: string) => void };

/**
 * Apply {@link stripContextEngineSlot} to the OpenClaw config file in place.
 * Best-effort: an unreadable or unwritable file is left alone and reported as
 * unchanged. Returns true when the file was rewritten.
 */
export function repairContextEngineSlotFile(configPath: string, logger?: SlotRepairLogger): boolean {
  let config: Record<string, any>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return false;
  }
  const result = stripContextEngineSlot(config);
  if (!result.changed) return false;
  try {
    writeFileSync(configPath, JSON.stringify(result.config, null, 2));
  } catch {
    return false;
  }
  logger?.warn(
    `[honcho] Removed plugins.slots.contextEngine="${PLUGIN_ID}" from ${configPath}. ` +
      `OpenClaw pins that slot because the plugin declares the "context-engine" kind, ` +
      `but the plugin provides no context engine, so the pin only produced a ` +
      `"degraded to legacy" warning on every turn. The default engine is now used explicitly.`,
  );
  return true;
}
