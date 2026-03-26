/**
 * Shared mutable state for the Honcho memory plugin.
 * Follows the dependency-injection pattern: createPluginState() returns a
 * PluginState object that gets passed to every module.
 *
 * ## Multi-workspace support
 *
 * When `workspaceMapping` is configured, agents whose IDs match a prefix are
 * routed to a separate Honcho workspace (and thus a separate SDK client).
 * Each workspace gets its own:
 *   - Honcho SDK client instance (lazily created, cached)
 *   - Initialization state (ownerPeer, agentPeerMap)
 *   - Per-workspace initialization lock (prevents concurrent init races)
 *
 * When `workspaceMapping` is NOT configured, behavior is identical to the
 * stock single-workspace behavior — no overhead, no breaking changes.
 */

import { Honcho, type Peer } from "@honcho-ai/sdk";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { honchoConfigSchema, type HonchoConfig } from "./config.js";

export const OWNER_ID = "owner";
export const LEGACY_PEER_ID = "openclaw";

/** Per-workspace state tracked independently for each Honcho workspace. */
type WorkspaceState = {
  honcho: Honcho;
  ownerPeer: Peer | null;
  agentPeers: Map<string, Peer>;
  agentPeerMap: Record<string, string>;
  initialized: boolean;
  /** Promise-based init lock: prevents concurrent initialization for the same workspace. */
  initLock: Promise<void> | null;
};

export type PluginState = {
  /** Default Honcho client (for the configured workspaceId). Kept for backward compat. */
  honcho: Honcho;
  cfg: HonchoConfig;
  /** Default workspace ownerPeer — null until ensureInitialized() completes. */
  ownerPeer: Peer | null;
  /** Default workspace agentPeers cache. */
  agentPeers: Map<string, Peer>;
  /** Default workspace agentPeerMap (agentId → peerId). */
  agentPeerMap: Record<string, string>;
  /** Message count recorded at before_prompt_build time, keyed by Honcho session key. */
  turnStartIndex: Map<string, number>;
  /** Whether the default workspace has been initialized. */
  initialized: boolean;
  api: OpenClawPluginApi;
  ensureInitialized: (workspaceId?: string) => Promise<void>;
  getAgentPeer: (agentId?: string) => Promise<Peer>;
  resolveDefaultAgentId: () => string;
  /**
   * Resolve the Honcho workspace ID for a given agent ID.
   * Matches the agent ID against prefixes in `workspaceMapping` (longest prefix wins).
   * Falls back to the default `workspaceId` if no prefix matches or mapping is unconfigured.
   */
  resolveWorkspace: (agentId: string) => string;
  /**
   * Get (or lazily create) a Honcho client for the given workspace ID.
   * The default workspace client is always `state.honcho`.
   */
  getHonchoClient: (workspaceId: string) => Honcho;
  /**
   * Get the ownerPeer for a given workspace ID.
   * Returns null if the workspace has not been initialized yet.
   * Call ensureInitialized(workspaceId) first.
   */
  getOwnerPeer: (workspaceId: string) => Peer | null;
};

export function createPluginState(api: OpenClawPluginApi): PluginState {
  const cfg = honchoConfigSchema.parse(api.pluginConfig);

  if (!cfg.apiKey) {
    api.logger.warn(
      "openclaw-honcho: No API key configured. Set HONCHO_API_KEY or configure apiKey in plugin config."
    );
  }

  // Default client for the configured workspaceId
  const defaultHoncho = new Honcho({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    workspaceId: cfg.workspaceId,
  });

  // Cache of workspace-specific clients (keyed by workspaceId)
  // The default workspace is included here for unified lookup.
  const clientCache = new Map<string, Honcho>();
  clientCache.set(cfg.workspaceId, defaultHoncho);

  // Per-workspace state cache (keyed by workspaceId)
  const workspaceStates = new Map<string, WorkspaceState>();
  workspaceStates.set(cfg.workspaceId, {
    honcho: defaultHoncho,
    ownerPeer: null,
    agentPeers: new Map(),
    agentPeerMap: {},
    initialized: false,
    initLock: null,
  });

  const state: PluginState = {
    honcho: defaultHoncho,
    cfg,
    // These proxy to the default workspace state for backward compat
    get ownerPeer() { return workspaceStates.get(cfg.workspaceId)!.ownerPeer; },
    set ownerPeer(v) { workspaceStates.get(cfg.workspaceId)!.ownerPeer = v; },
    get agentPeers() { return workspaceStates.get(cfg.workspaceId)!.agentPeers; },
    get agentPeerMap() { return workspaceStates.get(cfg.workspaceId)!.agentPeerMap; },
    set agentPeerMap(v) { workspaceStates.get(cfg.workspaceId)!.agentPeerMap = v; },
    turnStartIndex: new Map<string, number>(),
    get initialized() { return workspaceStates.get(cfg.workspaceId)!.initialized; },
    set initialized(v) { workspaceStates.get(cfg.workspaceId)!.initialized = v; },
    api,
    ensureInitialized,
    getAgentPeer,
    resolveDefaultAgentId,
    resolveWorkspace,
    getHonchoClient,
    getOwnerPeer,
  };

  function getOwnerPeer(workspaceId: string): Peer | null {
    return workspaceStates.get(workspaceId)?.ownerPeer ?? null;
  }

  function resolveDefaultAgentId(): string {
    const agents = api.config?.agents?.list;
    if (!Array.isArray(agents) || agents.length === 0) return "main";
    const defaultAgent = agents.find((a: { default?: boolean }) => a?.default) ?? agents[0];
    return (defaultAgent?.id ?? "main").toLowerCase().trim() || "main";
  }

  /**
   * Resolve the workspace ID for a given agent ID.
   * Applies longest-prefix matching against `workspaceMapping`.
   */
  function resolveWorkspace(agentId: string): string {
    const mapping = cfg.workspaceMapping;
    if (!mapping || Object.keys(mapping).length === 0) {
      return cfg.workspaceId;
    }

    let matchedPrefix = "";
    let matchedWorkspace = cfg.workspaceId;

    for (const [prefix, wsId] of Object.entries(mapping)) {
      if (agentId.startsWith(prefix) && prefix.length > matchedPrefix.length) {
        matchedPrefix = prefix;
        matchedWorkspace = wsId;
      }
    }

    return matchedWorkspace;
  }

  /**
   * Get (or lazily create) a Honcho SDK client for the given workspace ID.
   * Uses the same apiKey and baseUrl as the default client.
   */
  function getHonchoClient(workspaceId: string): Honcho {
    let client = clientCache.get(workspaceId);
    if (!client) {
      client = new Honcho({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseUrl,
        workspaceId,
      });
      clientCache.set(workspaceId, client);
    }
    return client;
  }

  /**
   * Get or create the WorkspaceState for a given workspace ID.
   */
  function getWorkspaceState(workspaceId: string): WorkspaceState {
    let ws = workspaceStates.get(workspaceId);
    if (!ws) {
      ws = {
        honcho: getHonchoClient(workspaceId),
        ownerPeer: null,
        agentPeers: new Map(),
        agentPeerMap: {},
        initialized: false,
        initLock: null,
      };
      workspaceStates.set(workspaceId, ws);
    }
    return ws;
  }

  /**
   * Ensure the given workspace is initialized.
   * Uses a promise-based lock to prevent concurrent initialization races.
   * If workspaceId is omitted, initializes the default workspace.
   */
  async function ensureInitialized(workspaceId?: string): Promise<void> {
    const wsId = workspaceId ?? cfg.workspaceId;
    const ws = getWorkspaceState(wsId);

    if (ws.initialized) return;

    // If init is already in progress for this workspace, wait for it
    if (ws.initLock) {
      await ws.initLock;
      return;
    }

    // Acquire the init lock
    let resolveLock!: () => void;
    ws.initLock = new Promise<void>((resolve) => { resolveLock = resolve; });

    try {
      const honcho = ws.honcho;
      const wsMeta = await honcho.getMetadata();
      ws.agentPeerMap = (wsMeta.agentPeerMap as Record<string, string>) ?? {};

      const defaultId = resolveDefaultAgentId();
      if (Object.keys(ws.agentPeerMap).length === 0) {
        ws.agentPeerMap[defaultId] = `agent-${defaultId}`;
        await honcho.setMetadata({ ...wsMeta, agentPeerMap: ws.agentPeerMap });
      } else if (Object.values(ws.agentPeerMap).includes(LEGACY_PEER_ID) && !ws.agentPeerMap[defaultId]) {
        ws.agentPeerMap[defaultId] = LEGACY_PEER_ID;
        await honcho.setMetadata({ ...wsMeta, agentPeerMap: ws.agentPeerMap });
      }

      ws.ownerPeer = await honcho.peer(OWNER_ID, { metadata: {} });
      ws.initialized = true;
    } finally {
      resolveLock();
      ws.initLock = null;
    }
  }

  /**
   * Get or create the Honcho Peer for a given agent ID.
   * Resolves the correct workspace based on the agent ID prefix mapping.
   */
  async function getAgentPeer(agentId?: string): Promise<Peer> {
    const id = (agentId || resolveDefaultAgentId()).toLowerCase().trim() || "main";
    const wsId = resolveWorkspace(id);
    const ws = getWorkspaceState(wsId);
    const honcho = ws.honcho;

    let peer = ws.agentPeers.get(id);
    if (peer) return peer;

    let peerId = ws.agentPeerMap[id];

    if (!peerId) {
      const allPeers = await honcho.peers();
      for await (const p of allPeers) {
        if (p.id === OWNER_ID) continue;
        const meta = await p.getMetadata();
        if (meta?.agentId === id) {
          peerId = p.id;
          api.logger.info(`[honcho] Recovered peer "${peerId}" for renamed agent "${id}" in workspace "${wsId}"`);
          break;
        }
      }
    }

    if (!peerId) {
      peerId = `agent-${id}`;
    }

    if (ws.agentPeerMap[id] !== peerId) {
      ws.agentPeerMap[id] = peerId;
      const wsMeta = await honcho.getMetadata();
      await honcho.setMetadata({ ...wsMeta, agentPeerMap: ws.agentPeerMap });
    }

    peer = await honcho.peer(peerId);
    ws.agentPeers.set(id, peer);

    const existingMeta = await peer.getMetadata();
    if (existingMeta.agentId !== id) {
      await peer.setMetadata({ ...existingMeta, agentId: id });
    }

    return peer;
  }

  return state;
}
