import { buildSessionKey } from "./helpers.js";
import { isLocalHonchoBaseUrl, type PluginState } from "./state.js";

const DEFAULT_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESULTS = 50;

/** Convert a Honcho session id into the generic memory tool path shape. */
function normalizeSessionPath(sessionId: string): string {
  return `sessions/${sessionId}.txt`;
}

/** Parse the synthetic transcript path used by memory_get back into a session id. */
function parseSessionPath(relPath: string): string | null {
  const m = /^sessions\/(.+)\.txt$/.exec(relPath);
  return m ? m[1] : null;
}

/** Match the active Honcho session for scoped reads/searches. New-scheme ids
 * embed a per-session hash suffix, so no real id is a prefix of another and
 * scope-checking collapses to equality. */
function matchesSessionScope(sessionId: string, activeSessionKey: string): boolean {
  return sessionId === activeSessionKey;
}

/** Return only the requested line window from a synthesized Honcho transcript. */
function sliceLines(text: string, from = 1, lines?: number): string {
  const all = text.split(/\r?\n/);
  const start = Math.max(1, from) - 1;
  const end = lines == null ? all.length : Math.min(all.length, start + Math.max(0, lines));
  return all.slice(start, end).join("\n");
}

/** Reconstruct a readable session transcript from Honcho session context data. */
async function buildSessionTranscript(
  state: PluginState,
  agentId: string,
  sessionId: string
): Promise<string> {
  await state.ensureInitialized();

  const participantPeer = await state.resolveSessionParticipantPeer(sessionId);
  const agentPeer = await state.getAgentPeer(agentId);
  const session = await state.honcho.session(sessionId, { metadata: { agentId } });
  const context = await session.context({
    summary: true,
    tokens: 20000,
    peerTarget: participantPeer,
    peerPerspective: agentPeer,
  });

  const lines: string[] = [];

  if (context.summary?.content) {
    lines.push("# Summary", context.summary.content, "");
  }

  for (const msg of context.messages ?? []) {
    const speaker =
      msg.peerId === participantPeer.id
        ? "User"
        : msg.peerId === agentPeer.id
          ? `Agent(${agentId})`
          : state.isParticipantPeerId(msg.peerId)
            ? `User(${msg.peerId})`
            : `Peer(${msg.peerId})`;
    const ts = msg.createdAt ? ` ${msg.createdAt}` : "";
    lines.push(`## ${speaker}${ts}`, msg.content ?? "", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Best-effort map a matched snippet back to transcript line numbers for memory_search. */
function findSnippetLineRange(transcript: string, snippet: string): { startLine: number; endLine: number } {
  const transcriptLines = transcript.split(/\r?\n/);
  const snippetLines = snippet.split(/\r?\n/);

  if (!snippet.trim()) {
    return { startLine: 1, endLine: 1 };
  }

  for (let i = 0; i <= transcriptLines.length - snippetLines.length; i += 1) {
    let matches = true;
    for (let j = 0; j < snippetLines.length; j += 1) {
      if (transcriptLines[i + j] !== snippetLines[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return { startLine: i + 1, endLine: i + snippetLines.length };
    }
  }

  const firstNeedle = snippetLines.find((line) => line.trim().length > 0);
  if (firstNeedle) {
    const idx = transcriptLines.findIndex((line) => line.includes(firstNeedle));
    if (idx >= 0) {
      return {
        startLine: idx + 1,
        endLine: Math.min(transcriptLines.length, idx + snippetLines.length),
      };
    }
  }

  return {
    startLine: 1,
    endLine: Math.min(Math.max(1, transcriptLines.length), Math.max(1, snippetLines.length)),
  };
}

/**
 * Build a Honcho-backed memory manager that satisfies OpenClaw's active-memory contract.
 *
 * The returned manager powers both the registered memory runtime and the direct
 * memory_search / memory_get compatibility tools.
 */
export async function getHonchoMemorySearchManager(
  state: PluginState,
  params: { agentId?: string; sessionKey?: string } = {}
) {
  const { agentId = state.resolveDefaultAgentId(), sessionKey: activeSessionKey } = params;

  await state.ensureInitialized();

  return {
    manager: {
      async search(query: string, opts: { maxResults?: number; sessionKey?: string } = {}) {
        await state.ensureInitialized();
        const participantPeer = activeSessionKey
          ? await state.resolveSessionParticipantPeer(activeSessionKey)
          : await state.getParticipantPeer();
        const requested = Number.isFinite(opts.maxResults)
          ? Number(opts.maxResults)
          : DEFAULT_SEARCH_RESULTS;
        const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.trunc(requested)));
        const requestedSessionKey =
          typeof opts.sessionKey === "string" && opts.sessionKey.length > 0
            ? opts.sessionKey
            : activeSessionKey ?? null;
        const scopeEnabled = !state.cfg.crossSessionSearch;
        if (
          scopeEnabled &&
          activeSessionKey &&
          requestedSessionKey &&
          !matchesSessionScope(requestedSessionKey, activeSessionKey)
        ) {
          throw new Error(
            `Requested Honcho session is outside the active session: ${requestedSessionKey}`
          );
        }
        const transcriptCache = new Map<string, Promise<string>>();
        const seenSessionIds = new Set<string>();
        const filtered: Array<any> = [];

        const collect = (messages: Array<any>) => {
          for (const msg of messages) {
            if (filtered.length >= limit) break;
            const sessionId = typeof msg?.sessionId === "string" ? msg.sessionId : "";
            if (!sessionId || seenSessionIds.has(`${sessionId}:${String(msg?.id ?? msg?.createdAt ?? msg?.content ?? "")}`)) {
              continue;
            }
            if (scopeEnabled && requestedSessionKey && !matchesSessionScope(sessionId, requestedSessionKey)) {
              continue;
            }
            seenSessionIds.add(`${sessionId}:${String(msg?.id ?? msg?.createdAt ?? msg?.content ?? "")}`);
            filtered.push(msg);
          }
        };

        if (requestedSessionKey) {
          const exactSession = await state.honcho.session(requestedSessionKey, {
            metadata: { agentId },
          });
          collect(await exactSession.search(query, { limit }));
        } else {
          collect(await participantPeer.search(query, { limit }));
        }

        return Promise.all(
          filtered.map(async (msg: any) => {
            const snippet = typeof msg.content === "string" ? msg.content : "";
            let transcriptPromise = transcriptCache.get(msg.sessionId);
            if (!transcriptPromise) {
              transcriptPromise = buildSessionTranscript(state, agentId, msg.sessionId);
              transcriptCache.set(msg.sessionId, transcriptPromise);
            }
            const transcript = await transcriptPromise;
            const { startLine, endLine } = findSnippetLineRange(transcript, snippet);
            return {
              path: normalizeSessionPath(msg.sessionId),
              startLine,
              endLine,
              score: 1,
              snippet,
              source: "sessions",
            };
          })
        );
      },

      async readFile(params: { relPath: string; from?: number; lines?: number }) {
        const sessionId = parseSessionPath(params.relPath);
        if (!sessionId) {
          throw new Error(`Unsupported Honcho memory path: ${params.relPath}`);
        }
        if (!state.cfg.crossSessionSearch && activeSessionKey && !matchesSessionScope(sessionId, activeSessionKey)) {
          throw new Error(`Requested Honcho memory path is outside the active session: ${params.relPath}`);
        }

        const transcript = await buildSessionTranscript(state, agentId, sessionId);
        return {
          path: params.relPath,
          text: sliceLines(transcript, params.from, params.lines),
        };
      },

      status() {
        return {
          backend: "qmd",
          provider: isLocalHonchoBaseUrl(state.cfg.baseUrl) ? "honcho-selfhosted" : "honcho",
          model: "n/a",
          sources: ["sessions"],
          custom: {
            searchMode: "semantic",
            workspaceId: state.cfg.workspaceId,
            baseUrl: state.cfg.baseUrl,
          },
        };
      },

      async probeEmbeddingAvailability() {
        return { ok: true };
      },

      async probeVectorAvailability() {
        return true;
      },
    },
  };
}

/** Resolve the memory backend descriptor expected by the OpenClaw memory slot. */
export function resolveHonchoMemoryBackendConfig(
  params: { sessionKey?: string; agentId?: string } = {}
) {
  const sessionKey = buildSessionKey(params);
  return {
    backend: "qmd",
    qmd: {},
    sessionKey,
  };
}

/** Register the Honcho runtime adapter when the host exposes memory runtime registration. */
export function registerHonchoMemoryRuntime(api: any, state: PluginState): void {
  if (typeof api?.registerMemoryRuntime !== "function") {
    return;
  }

  api.registerMemoryRuntime({
    getMemorySearchManager(params: { agentId?: string; sessionKey?: string }) {
      return getHonchoMemorySearchManager(state, params);
    },

    resolveMemoryBackendConfig(params: { sessionKey?: string; agentId?: string } = {}) {
      return resolveHonchoMemoryBackendConfig(params);
    },
  });
}
