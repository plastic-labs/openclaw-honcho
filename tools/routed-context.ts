import type { PluginState, PerWorkspaceState } from "../state.js";
import { buildSessionKey } from "../helpers.js";
import {
  resolveToolWorkspaceOrThrow,
  WorkspaceRoutingError,
  type WorkspaceRouteContext,
} from "../routing.js";

export type RoutedToolContext = {
  route: WorkspaceRouteContext;
  workspaceId: string;
  state: PerWorkspaceState;
  agentId: string;
  honchoSessionKey: string;
};

/** Resolve trusted tool context before any workspace state or Honcho access. */
export function resolveRoutedToolContext(
  pluginState: PluginState,
  toolContext: unknown,
): RoutedToolContext {
  const { workspaceId, context: route } = resolveToolWorkspaceOrThrow(
    pluginState.cfg,
    toolContext,
    pluginState.sessionWorkspaceBindings,
  );
  const state = pluginState.getWorkspaceState(workspaceId);
  const agentId = route.agentId ?? state.resolveDefaultAgentId();
  const honchoSessionKey = buildSessionKey({ sessionKey: route.sessionKey, agentId });
  const ownership = pluginState.honchoSessionWorkspaceBindings.bind(honchoSessionKey, workspaceId);
  if (ownership.status === "binding-conflict") {
    throw new WorkspaceRoutingError("session-ownership-conflict");
  }
  return { route, workspaceId, state, agentId, honchoSessionKey };
}
