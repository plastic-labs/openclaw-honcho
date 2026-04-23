/**
 * Shared mutable state for the Honcho memory plugin.
 * Follows the dependency-injection pattern: createPluginState() returns a
 * PluginState object that gets passed to every module.
 *
 * Per-agent workspace routing: each configured workspace (via `agentWorkspaces`)
 * gets its own `PerWorkspaceState` — dedicated Honcho client, owner peer, and
 * agent peer cache — so memory reads/writes stay isolated per workspace.
 */

import { Honcho, type Peer } from "@honcho-ai/sdk";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { honchoConfigSchema, type HonchoConfig } from "./config.js";

export const OWNER_ID = "owner";
export const LEGACY_PEER_ID = "openclaw";

export function isLocalHonchoBaseUrl(baseUrl?: string): boolean {
  const base = String(baseUrl ?? "").trim();
  if (!base) return false;

  try {
    const { hostname, protocol } = new URL(base);
    if (protocol !== "http:" && protocol !== "https:") return false;
    const normalizedHost = hostname.replace(/^\[(.*)\]$/, "$1");
    return normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "::1";
  } catch {
    return false;
  }
}

export type PerWorkspaceState = {
  workspaceId: string;
  honcho: Honcho;
  ownerPeer: Peer | null;
  agentPeers: Map<string, Peer>;
  agentPeerMap: Record<string, string>;
  initialized: boolean;
  initPromise: Promise<void> | null;
};

export type PluginState = {
  cfg: HonchoConfig;
  /** Per-workspace state, keyed by resolved Honcho workspaceId. */
  workspaces: Map<string, PerWorkspaceState>;
  /** Message count recorded at before_prompt_build time, keyed by Honcho session key.
   * Used by the capture hook to determine where the current turn starts in the
   * accumulated message array, so first-init skips pre-installation history.
   * Session keys are globally unique across workspaces. */
  turnStartIndex: Map<string, number>;
  api: OpenClawPluginApi;
  /** Resolve the workspaceId a given agent should route to (falls back to cfg.workspaceId). */
  resolveWorkspaceIdForAgent: (agentId?: string) => string;
  /** Lazy-initialized PerWorkspaceState for the given agent. */
  getWorkspaceFor: (agentId?: string) => PerWorkspaceState;
  /** Return the Honcho client for the given agent's workspace. */
  getHonchoFor: (agentId?: string) => Honcho;
  /** Ensure the per-workspace client is initialized (owner peer created, metadata read). */
  ensureInitializedFor: (agentId?: string) => Promise<PerWorkspaceState>;
  /** Resolve the owner peer for the given agent's workspace (after init). */
  getOwnerPeerFor: (agentId?: string) => Promise<Peer>;
  /** Resolve the agent peer for the given agent in its routed workspace. */
  getAgentPeerFor: (agentId?: string) => Promise<Peer>;
  resolveDefaultAgentId: () => string;
};

export function createPluginState(api: OpenClawPluginApi): PluginState {
  const cfg = honchoConfigSchema.parse(api.pluginConfig);

  const selfHosted = isLocalHonchoBaseUrl(cfg.baseUrl);

  if (!cfg.apiKey && !selfHosted) {
    api.logger.warn(
      "openclaw-honcho: No API key configured. Set HONCHO_API_KEY or configure apiKey in plugin config."
    );
  }

  const workspaces = new Map<string, PerWorkspaceState>();

  function createWorkspaceState(workspaceId: string): PerWorkspaceState {
    const honcho = new Honcho({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl,
      workspaceId,
      timeout: cfg.timeoutMs,
    });
    return {
      workspaceId,
      honcho,
      ownerPeer: null,
      agentPeers: new Map<string, Peer>(),
      agentPeerMap: {},
      initialized: false,
      initPromise: null,
    };
  }

  const state: PluginState = {
    cfg,
    workspaces,
    turnStartIndex: new Map<string, number>(),
    api,
    resolveWorkspaceIdForAgent,
    getWorkspaceFor,
    getHonchoFor,
    ensureInitializedFor,
    getOwnerPeerFor,
    getAgentPeerFor,
    resolveDefaultAgentId,
  };

  function normalizeAgentId(agentId?: string): string {
    return (agentId ?? resolveDefaultAgentId()).toLowerCase().trim() || "main";
  }

  function resolveDefaultAgentId(): string {
    const agents = api.config?.agents?.list;
    if (!Array.isArray(agents) || agents.length === 0) return "main";
    const defaultAgent = agents.find((a: { default?: boolean }) => a?.default) ?? agents[0];
    return (defaultAgent?.id ?? "main").toLowerCase().trim() || "main";
  }

  function resolveWorkspaceIdForAgent(agentId?: string): string {
    const id = normalizeAgentId(agentId);
    const mapped = cfg.agentWorkspaces?.[id];
    if (typeof mapped === "string" && mapped.length > 0) return mapped;
    return cfg.workspaceId;
  }

  function getWorkspaceFor(agentId?: string): PerWorkspaceState {
    const workspaceId = resolveWorkspaceIdForAgent(agentId);
    let ws = workspaces.get(workspaceId);
    if (!ws) {
      ws = createWorkspaceState(workspaceId);
      workspaces.set(workspaceId, ws);
    }
    return ws;
  }

  function getHonchoFor(agentId?: string): Honcho {
    return getWorkspaceFor(agentId).honcho;
  }

  async function initializeWorkspace(ws: PerWorkspaceState): Promise<void> {
    const wsMeta = await ws.honcho.getMetadata();
    ws.agentPeerMap = (wsMeta.agentPeerMap as Record<string, string>) ?? {};

    const defaultId = resolveDefaultAgentId();
    if (Object.keys(ws.agentPeerMap).length === 0) {
      ws.agentPeerMap[defaultId] = `agent-${defaultId}`;
      await ws.honcho.setMetadata({ ...wsMeta, agentPeerMap: ws.agentPeerMap });
    } else if (Object.values(ws.agentPeerMap).includes(LEGACY_PEER_ID) && !ws.agentPeerMap[defaultId]) {
      ws.agentPeerMap[defaultId] = LEGACY_PEER_ID;
      await ws.honcho.setMetadata({ ...wsMeta, agentPeerMap: ws.agentPeerMap });
    }

    ws.ownerPeer = await ws.honcho.peer(OWNER_ID, { metadata: {} });
    ws.initialized = true;
  }

  async function ensureInitializedFor(agentId?: string): Promise<PerWorkspaceState> {
    const ws = getWorkspaceFor(agentId);
    if (ws.initialized) return ws;
    if (!ws.initPromise) {
      ws.initPromise = initializeWorkspace(ws).catch((err) => {
        ws.initPromise = null;
        throw err;
      });
    }
    await ws.initPromise;
    return ws;
  }

  async function getOwnerPeerFor(agentId?: string): Promise<Peer> {
    const ws = await ensureInitializedFor(agentId);
    if (!ws.ownerPeer) {
      throw new Error(`Honcho owner peer not initialized for workspace "${ws.workspaceId}"`);
    }
    return ws.ownerPeer;
  }

  async function getAgentPeerFor(agentId?: string): Promise<Peer> {
    const id = normalizeAgentId(agentId);
    const ws = await ensureInitializedFor(id);

    let peer = ws.agentPeers.get(id);
    if (peer) return peer;

    let peerId = ws.agentPeerMap[id];

    if (!peerId) {
      const allPeers = await ws.honcho.peers();
      for await (const p of allPeers) {
        if (p.id === OWNER_ID) continue;
        const meta = await p.getMetadata();
        if (meta?.agentId === id) {
          peerId = p.id;
          api.logger.info(`[honcho] Recovered peer "${peerId}" for renamed agent "${id}" in workspace "${ws.workspaceId}"`);
          break;
        }
      }
    }

    if (!peerId) {
      peerId = `agent-${id}`;
    }

    if (ws.agentPeerMap[id] !== peerId) {
      ws.agentPeerMap[id] = peerId;
      const wsMeta = await ws.honcho.getMetadata();
      await ws.honcho.setMetadata({ ...wsMeta, agentPeerMap: ws.agentPeerMap });
    }

    peer = await ws.honcho.peer(peerId);
    ws.agentPeers.set(id, peer);

    const existingMeta = await peer.getMetadata();
    if (existingMeta.agentId !== id) {
      await peer.setMetadata({ ...existingMeta, agentId: id });
    }

    return peer;
  }

  return state;
}
