/**
 * Workspace-scoped mutable state for the Honcho memory plugin.
 *
 * PluginState keeps a backward-compatible default-workspace facade. Lifecycle
 * hooks use getWorkspaceState(); tools/runtime remain on the facade until their
 * separate routing phase.
 */

import { createHash } from "node:crypto";
import { Honcho, type Peer } from "@honcho-ai/sdk";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { honchoConfigSchema, type HonchoConfig } from "./config.js";
import { SessionWorkspaceBindingStore } from "./routing.js";
import {
  PeersPersister,
  loadPeersFileSync,
  resolvePeersFilePath,
  resolveParticipantPeerId,
  resolveWorkspacePeersFilePath,
} from "./peers.js";

export const OWNER_ID = "owner";
export const LEGACY_PEER_ID = "openclaw";

export const HONCHO_CLOUD_HOSTNAME = "api.honcho.dev";

/**
 * True when the base URL points at the managed Honcho cloud
 * (api.honcho.dev). The cloud is the only deployment that requires an API
 * key; any other base URL is treated as self-hosted.
 */
export function isManagedHonchoCloud(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === HONCHO_CLOUD_HOSTNAME;
  } catch {
    return false;
  }
}

/**
 * Opaque registry identity. Credential material is represented only by a
 * one-way digest and must never be logged or exposed in diagnostics.
 */
function normalizeBaseUrl(baseUrl: string): string {
  baseUrl = baseUrl.trim();
  try {
    const parsed = new URL(baseUrl);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return baseUrl.replace(/\/$/, "");
  }
}

export function buildWorkspaceKey(cfg: Pick<HonchoConfig, "baseUrl" | "apiKey">, workspaceId: string): string {
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  const credentialIdentity = cfg.apiKey
    ? createHash("sha256").update(`api-key\0${cfg.apiKey}`).digest("hex")
    : "none";
  return `${baseUrl}\0${workspaceId}\0${credentialIdentity}`;
}

/** Stable persistence identity: credential rotation must not move peer mappings. */
export function buildWorkspacePersistenceKey(
  cfg: Pick<HonchoConfig, "baseUrl">,
  workspaceId: string,
): string {
  return `${normalizeBaseUrl(cfg.baseUrl)}\0${workspaceId}`;
}

export type PerWorkspaceState = {
  cfg: HonchoConfig;
  workspaceId: string;
  workspaceKey: string;
  honcho: Honcho;
  /** Participant cache is local to this Honcho workspace. */
  participantPeers: Map<string, Peer>;
  /** Agent cache and persisted mapping are local to this Honcho workspace. */
  agentPeers: Map<string, Peer>;
  agentPeerMap: Record<string, string>;
  /** Capture cursor/turn boundary state, local to this workspace. */
  turnStartIndex: Map<string, number>;
  initialized: boolean;
  peersPersister: PeersPersister;
  ensureInitialized: () => Promise<void>;
  getAgentPeer: (agentId?: string) => Promise<Peer>;
  getParticipantPeer: (channelPeerId?: string) => Promise<Peer>;
  resolveSessionParticipantPeer: (sessionKey: string) => Promise<Peer>;
  isParticipantPeerId: (peerId: string) => boolean;
  resolveDefaultAgentId: () => string;
  /** Serialize workspace metadata and peer-map mutations. */
  withWorkspaceLock: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Serialize capture/cursor work for one session inside this workspace. */
  withSessionLock: <T>(sessionKey: string, operation: () => Promise<T>) => Promise<T>;
};

export type PluginState = PerWorkspaceState & {
  cfg: HonchoConfig;
  api: OpenClawPluginApi;
  /** Registry keyed by base URL + workspace id + credential identity. */
  workspaces: Map<string, PerWorkspaceState>;
  /** Lazily create or return the memoized state/client for a workspace. */
  getWorkspaceState: (workspaceId: string) => PerWorkspaceState;
  /** Shared immutable route relation for all lifecycle hooks. */
  sessionWorkspaceBindings: SessionWorkspaceBindingStore;
  /** Subagent identity metadata; routing itself lives in sessionWorkspaceBindings. */
  subagentRelations: Map<string, { parentSessionKey: string; parentAgentId?: string }>;
};

function requiredWorkspaceId(workspaceId: string): string {
  if (typeof workspaceId !== "string" || !workspaceId.trim()) {
    throw new Error("Invalid workspaceId: expected a non-empty string");
  }
  return workspaceId.trim();
}

function createPerWorkspaceState(
  api: OpenClawPluginApi,
  cfg: HonchoConfig,
  workspaceId: string,
  workspaceKey: string,
  persistenceKey: string,
  preserveLegacyPeersPath: boolean,
): PerWorkspaceState {
  const honcho = new Honcho({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    workspaceId,
    timeout: cfg.timeoutMs,
  });

  const basePeersFilePath = resolvePeersFilePath();
  const peersFilePath = resolveWorkspacePeersFilePath(
    basePeersFilePath,
    persistenceKey,
    preserveLegacyPeersPath,
  );
  const peersPersister = new PeersPersister(peersFilePath, loadPeersFileSync(peersFilePath));

  let initPromise: Promise<void> | null = null;
  let workspaceQueue: Promise<void> = Promise.resolve();
  const sessionQueues = new Map<string, Promise<void>>();

  const state: PerWorkspaceState = {
    cfg,
    workspaceId,
    workspaceKey,
    honcho,
    participantPeers: new Map<string, Peer>(),
    agentPeers: new Map<string, Peer>(),
    agentPeerMap: {},
    turnStartIndex: new Map<string, number>(),
    initialized: false,
    peersPersister,
    ensureInitialized,
    getAgentPeer,
    getParticipantPeer,
    resolveSessionParticipantPeer,
    isParticipantPeerId,
    resolveDefaultAgentId,
    withWorkspaceLock,
    withSessionLock,
  };

  function resolveDefaultAgentId(): string {
    const agents = api.config?.agents?.list;
    if (!Array.isArray(agents) || agents.length === 0) return "main";
    const defaultAgent = agents.find((a: { default?: boolean }) => a?.default) ?? agents[0];
    return (defaultAgent?.id ?? "main").toLowerCase().trim() || "main";
  }

  function withWorkspaceLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = workspaceQueue.then(operation, operation);
    workspaceQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function withSessionLock<T>(sessionKey: string, operation: () => Promise<T>): Promise<T> {
    const key = sessionKey.trim();
    if (!key) throw new Error("Invalid sessionKey: expected a non-empty string");
    const previous = sessionQueues.get(key) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.then(() => undefined, () => undefined);
    sessionQueues.set(key, tail);
    try {
      return await run;
    } finally {
      if (sessionQueues.get(key) === tail) sessionQueues.delete(key);
    }
  }

  async function ensureInitialized(): Promise<void> {
    if (state.initialized) return;
    if (initPromise) return initPromise;
    initPromise = withWorkspaceLock(doInit);
    try {
      await initPromise;
    } catch (err) {
      initPromise = null;
      throw err;
    }
  }

  async function doInit(): Promise<void> {
    if (state.initialized) return;
    const wsMeta = await honcho.getMetadata();
    state.agentPeerMap = { ...((wsMeta.agentPeerMap as Record<string, string>) ?? {}) };

    const defaultId = resolveDefaultAgentId();
    if (Object.keys(state.agentPeerMap).length === 0) {
      state.agentPeerMap[defaultId] = `agent-${defaultId}`;
      await honcho.setMetadata({ ...wsMeta, agentPeerMap: { ...state.agentPeerMap } });
    } else if (
      Object.values(state.agentPeerMap).includes(LEGACY_PEER_ID) &&
      !state.agentPeerMap[defaultId]
    ) {
      state.agentPeerMap[defaultId] = LEGACY_PEER_ID;
      await honcho.setMetadata({ ...wsMeta, agentPeerMap: { ...state.agentPeerMap } });
    }

    const defaultPeer = await honcho.peer(OWNER_ID, { metadata: {} });
    state.participantPeers.set(OWNER_ID, defaultPeer);
    state.initialized = true;
  }

  async function ensureOwnerPeer(): Promise<Peer> {
    let peer = state.participantPeers.get(OWNER_ID);
    if (peer) return peer;
    peer = await honcho.peer(OWNER_ID, { metadata: {} });
    state.participantPeers.set(OWNER_ID, peer);
    return peer;
  }

  async function getParticipantPeer(channelPeerId?: string): Promise<Peer> {
    if (!channelPeerId) return ensureOwnerPeer();
    let peer = state.participantPeers.get(channelPeerId);
    if (peer) return peer;

    const wasInFile = channelPeerId in peersPersister.peers;
    const resolvedPeerId = resolveParticipantPeerId(channelPeerId, peersPersister, OWNER_ID);
    const autoSeeded = !wasInFile && resolvedPeerId !== OWNER_ID;

    if (resolvedPeerId === OWNER_ID) {
      peer = await ensureOwnerPeer();
    } else {
      const metadata: Record<string, unknown> = { channelPeerId };
      if (autoSeeded) metadata.autoSeeded = true;
      peer = await honcho.peer(resolvedPeerId, { metadata });
    }
    state.participantPeers.set(channelPeerId, peer);
    return peer;
  }

  async function resolveSessionParticipantPeer(sessionKey: string): Promise<Peer> {
    const session = await honcho.session(sessionKey);
    const meta = await session.getMetadata();
    if (meta && typeof meta === "object") {
      const senderId = (meta as Record<string, unknown>).participantSenderId;
      if (typeof senderId === "string" && senderId.length > 0) {
        return getParticipantPeer(senderId);
      }
    }
    return getParticipantPeer();
  }

  function isParticipantPeerId(peerId: string): boolean {
    if (peerId === OWNER_ID) return true;
    for (const peer of state.participantPeers.values()) {
      if (peer.id === peerId) return true;
    }
    return false;
  }

  async function getAgentPeer(agentId?: string): Promise<Peer> {
    const id = (agentId || resolveDefaultAgentId()).toLowerCase().trim() || "main";
    const cached = state.agentPeers.get(id);
    if (cached) return cached;

    return withWorkspaceLock(async () => {
      const afterWait = state.agentPeers.get(id);
      if (afterWait) return afterWait;

      let peerId = state.agentPeerMap[id];
      if (!peerId) {
        const allPeers = await honcho.peers();
        for await (const peer of allPeers) {
          if (peer.id === OWNER_ID) continue;
          const meta = await peer.getMetadata();
          if (meta?.agentId === id) {
            peerId = peer.id;
            api.logger.info(`[honcho] Recovered peer "${peerId}" for renamed agent "${id}"`);
            break;
          }
        }
      }

      if (!peerId) peerId = `agent-${id}`;

      if (state.agentPeerMap[id] !== peerId) {
        state.agentPeerMap[id] = peerId;
        const wsMeta = await honcho.getMetadata();
        await honcho.setMetadata({ ...wsMeta, agentPeerMap: { ...state.agentPeerMap } });
      }

      const peer = await honcho.peer(peerId);
      state.agentPeers.set(id, peer);

      const existingMeta = await peer.getMetadata();
      if (existingMeta.agentId !== id) {
        await peer.setMetadata({ ...existingMeta, agentId: id });
      }
      return peer;
    });
  }

  return state;
}

export function createPluginState(api: OpenClawPluginApi): PluginState {
  const cfg = honchoConfigSchema.parse(api.pluginConfig);
  const selfHosted = !isManagedHonchoCloud(cfg.baseUrl);
  if (!cfg.apiKey && !selfHosted) {
    api.logger.warn(
      "openclaw-honcho: No API key configured. Set HONCHO_API_KEY or configure apiKey in plugin config.",
    );
  }

  const workspaces = new Map<string, PerWorkspaceState>();
  const sessionWorkspaceBindings = new SessionWorkspaceBindingStore();
  const subagentRelations = new Map<string, { parentSessionKey: string; parentAgentId?: string }>();

  function getWorkspaceState(rawWorkspaceId: string): PerWorkspaceState {
    const workspaceId = requiredWorkspaceId(rawWorkspaceId);
    const workspaceKey = buildWorkspaceKey(cfg, workspaceId);
    const existing = workspaces.get(workspaceKey);
    if (existing) return existing;

    const created = createPerWorkspaceState(
      api,
      cfg,
      workspaceId,
      workspaceKey,
      buildWorkspacePersistenceKey(cfg, workspaceId),
      workspaceId === cfg.workspaceId,
    );
    workspaces.set(workspaceKey, created);
    return created;
  }

  const defaultState = getWorkspaceState(cfg.workspaceId);

  // Backward-compatible facade. Existing integration remains pinned to the
  // configured default workspace until the routed lifecycle phase.
  const pluginState = {
    cfg,
    api,
    workspaces,
    getWorkspaceState,
    sessionWorkspaceBindings,
    subagentRelations,
    get workspaceId() { return defaultState.workspaceId; },
    get workspaceKey() { return defaultState.workspaceKey; },
    get honcho() { return defaultState.honcho; },
    get participantPeers() { return defaultState.participantPeers; },
    get agentPeers() { return defaultState.agentPeers; },
    get agentPeerMap() { return defaultState.agentPeerMap; },
    get turnStartIndex() { return defaultState.turnStartIndex; },
    get initialized() { return defaultState.initialized; },
    get peersPersister() { return defaultState.peersPersister; },
    ensureInitialized: defaultState.ensureInitialized,
    getAgentPeer: defaultState.getAgentPeer,
    getParticipantPeer: defaultState.getParticipantPeer,
    resolveSessionParticipantPeer: defaultState.resolveSessionParticipantPeer,
    isParticipantPeerId: defaultState.isParticipantPeerId,
    resolveDefaultAgentId: defaultState.resolveDefaultAgentId,
    withWorkspaceLock: defaultState.withWorkspaceLock,
    withSessionLock: defaultState.withSessionLock,
  } as PluginState;

  return pluginState;
}
