/**
 * Shared mutable state for the Honcho memory plugin.
 * Follows the dependency-injection pattern: createPluginState() returns a
 * PluginState object that gets passed to every module.
 */

import { Honcho, type Peer } from "@honcho-ai/sdk";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { honchoConfigSchema, type HonchoConfig } from "./config.js";

export const OWNER_ID = "owner";
export const LEGACY_PEER_ID = "openclaw";

export type PluginState = {
  honcho: Honcho;
  cfg: HonchoConfig;
  /** Cache of resolved human peers, keyed by channel peer ID (or OWNER_ID for default). */
  humanPeers: Map<string, Peer>;
  /** Persistent mapping of channel peer ID → honcho peer ID, stored in workspace metadata. */
  humanPeerMap: Record<string, string>;
  agentPeers: Map<string, Peer>;
  agentPeerMap: Record<string, string>;
  /** Message count recorded at before_prompt_build time, keyed by Honcho session key.
   * Used by the capture hook to determine where the current turn starts in the
   * accumulated message array, so first-init skips pre-installation history. */
  turnStartIndex: Map<string, number>;
  initialized: boolean;
  api: OpenClawPluginApi;
  ensureInitialized: () => Promise<void>;
  getAgentPeer: (agentId?: string) => Promise<Peer>;
  /** Resolve a human peer by channel peer ID. Returns default "owner" peer if no ID given. */
  getHumanPeer: (channelPeerId?: string) => Promise<Peer>;
  /** Resolve the human peer for a session by reading humanPeerId from session metadata.
   * Falls back to default "owner" peer if no metadata found. */
  resolveSessionHumanPeer: (sessionKey: string) => Promise<Peer>;
  /** Returns true if the given honcho peer ID belongs to a known human peer. */
  isHumanPeerId: (peerId: string) => boolean;
  resolveDefaultAgentId: () => string;
};

export function createPluginState(api: OpenClawPluginApi): PluginState {
  const cfg = honchoConfigSchema.parse(api.pluginConfig);

  if (!cfg.apiKey) {
    api.logger.warn(
      "openclaw-honcho: No API key configured. Set HONCHO_API_KEY or configure apiKey in plugin config."
    );
  }

  const honcho = new Honcho({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    workspaceId: cfg.workspaceId,
  });

  const state: PluginState = {
    honcho,
    cfg,
    humanPeers: new Map<string, Peer>(),
    humanPeerMap: {},
    agentPeers: new Map<string, Peer>(),
    agentPeerMap: {},
    turnStartIndex: new Map<string, number>(),
    initialized: false,
    api,
    ensureInitialized,
    getAgentPeer,
    getHumanPeer,
    resolveSessionHumanPeer,
    isHumanPeerId,
    resolveDefaultAgentId,
  };

  function resolveDefaultAgentId(): string {
    const agents = api.config?.agents?.list;
    if (!Array.isArray(agents) || agents.length === 0) return "main";
    const defaultAgent = agents.find((a: { default?: boolean }) => a?.default) ?? agents[0];
    return (defaultAgent?.id ?? "main").toLowerCase().trim() || "main";
  }

  async function ensureInitialized(): Promise<void> {
    if (state.initialized) return;

    const wsMeta = await honcho.getMetadata();
    state.agentPeerMap = (wsMeta.agentPeerMap as Record<string, string>) ?? {};
    state.humanPeerMap = (wsMeta.humanPeerMap as Record<string, string>) ?? {};

    // Config mappings take precedence over workspace metadata
    for (const [channelId, honchoId] of Object.entries(cfg.peerMappings)) {
      state.humanPeerMap[channelId] = honchoId;
    }
    for (const [agentId, honchoId] of Object.entries(cfg.agentPeerMappings)) {
      state.agentPeerMap[agentId] = honchoId;
    }

    const defaultId = resolveDefaultAgentId();
    if (Object.keys(state.agentPeerMap).length === 0) {
      state.agentPeerMap[defaultId] = `agent-${defaultId}`;
      await honcho.setMetadata({ ...wsMeta, agentPeerMap: state.agentPeerMap, humanPeerMap: state.humanPeerMap });
    } else if (Object.values(state.agentPeerMap).includes(LEGACY_PEER_ID) && !state.agentPeerMap[defaultId]) {
      state.agentPeerMap[defaultId] = LEGACY_PEER_ID;
      await honcho.setMetadata({ ...wsMeta, agentPeerMap: state.agentPeerMap, humanPeerMap: state.humanPeerMap });
    }

    // Create default "owner" peer
    const defaultPeer = await honcho.peer(OWNER_ID, { metadata: {} });
    state.humanPeers.set(OWNER_ID, defaultPeer);

    state.initialized = true;
  }

  async function getHumanPeer(channelPeerId?: string): Promise<Peer> {
    if (!channelPeerId) {
      // Return default owner peer
      let peer = state.humanPeers.get(OWNER_ID);
      if (!peer) {
        peer = await honcho.peer(OWNER_ID, { metadata: {} });
        state.humanPeers.set(OWNER_ID, peer);
      }
      return peer;
    }

    // Check cache
    let peer = state.humanPeers.get(channelPeerId);
    if (peer) return peer;

    // Resolve honcho peer ID from mapping or use channel peer ID directly
    let honchoId = state.humanPeerMap[channelPeerId];
    if (!honchoId) {
      honchoId = channelPeerId;
      // Persist auto-created mapping
      state.humanPeerMap[channelPeerId] = honchoId;
      const wsMeta = await honcho.getMetadata();
      await honcho.setMetadata({ ...wsMeta, humanPeerMap: state.humanPeerMap });
      api.logger.info(`[honcho] Auto-created human peer mapping: "${channelPeerId}" → "${honchoId}"`);
    }

    peer = await honcho.peer(honchoId, { metadata: { channelPeerId } });
    state.humanPeers.set(channelPeerId, peer);
    return peer;
  }

  async function resolveSessionHumanPeer(sessionKey: string): Promise<Peer> {
    try {
      const session = await honcho.session(sessionKey);
      const meta = await session.getMetadata();
      if (meta && typeof meta === "object") {
        const humanPeerId = (meta as Record<string, unknown>).humanPeerId;
        if (typeof humanPeerId === "string" && humanPeerId.length > 0) {
          return await getHumanPeer(humanPeerId);
        }
      }
    } catch {
      // Fall through to default
    }
    return await getHumanPeer();
  }

  function isHumanPeerId(peerId: string): boolean {
    if (peerId === OWNER_ID) return true;
    // Check if this peer ID is a known human peer (either as a channel ID key or honcho ID value)
    for (const [, peer] of state.humanPeers) {
      if (peer.id === peerId) return true;
    }
    // Also check the mapping values
    return Object.values(state.humanPeerMap).includes(peerId);
  }

  async function getAgentPeer(agentId?: string): Promise<Peer> {
    const id = (agentId || resolveDefaultAgentId()).toLowerCase().trim() || "main";

    let peer = state.agentPeers.get(id);
    if (peer) return peer;

    let peerId = state.agentPeerMap[id];

    if (!peerId) {
      const allPeers = await honcho.peers();
      for await (const p of allPeers) {
        if (p.id === OWNER_ID) continue;
        const meta = await p.getMetadata();
        if (meta?.agentId === id) {
          peerId = p.id;
          api.logger.info(`[honcho] Recovered peer "${peerId}" for renamed agent "${id}"`);
          break;
        }
      }
    }

    if (!peerId) {
      peerId = `agent-${id}`;
    }

    if (state.agentPeerMap[id] !== peerId) {
      state.agentPeerMap[id] = peerId;
      const wsMeta = await honcho.getMetadata();
      await honcho.setMetadata({ ...wsMeta, agentPeerMap: state.agentPeerMap });
    }

    peer = await honcho.peer(peerId);
    state.agentPeers.set(id, peer);

    const existingMeta = await peer.getMetadata();
    if (existingMeta.agentId !== id) {
      await peer.setMetadata({ ...existingMeta, agentId: id });
    }

    return peer;
  }

  return state;
}
