import { buildSessionKey } from "./helpers.js";
import { isLocalHonchoBaseUrl, type PluginState } from "./state.js";

const DEFAULT_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESULTS = 50;

function normalizeSessionPath(sessionId: string): string {
  return `sessions/${sessionId}.txt`;
}

function parseSessionPath(relPath: string): string | null {
  const m = /^sessions\/(.+)\.txt$/.exec(relPath);
  return m ? m[1] : null;
}

function countLines(text: string): number {
  return text.length === 0 ? 1 : text.split(/\r?\n/).length;
}

function sliceLines(text: string, from = 1, lines?: number): string {
  const all = text.split(/\r?\n/);
  const start = Math.max(1, from) - 1;
  const end = lines == null ? all.length : Math.max(start, start + Math.max(0, lines));
  return all.slice(start, end).join("\n");
}

async function buildSessionTranscript(
  state: PluginState,
  agentId: string,
  sessionId: string
): Promise<string> {
  await state.ensureInitialized();

  const agentPeer = await state.getAgentPeer(agentId);
  const session = await state.honcho.session(sessionId, { metadata: { agentId } });
  const context = await session.context({
    summary: true,
    tokens: 20000,
    peerTarget: state.ownerPeer,
    peerPerspective: agentPeer,
  });

  const lines: string[] = [];

  if (context.summary?.content) {
    lines.push("# Summary", context.summary.content, "");
  }

  for (const msg of context.messages ?? []) {
    const speaker =
      msg.peerId === state.ownerPeer.id
        ? "User"
        : msg.peerId === agentPeer.id
          ? `Agent(${agentId})`
          : `Peer(${msg.peerId})`;
    const ts = msg.createdAt ? ` ${msg.createdAt}` : "";
    lines.push(`## ${speaker}${ts}`, msg.content ?? "", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

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
      return { startLine: idx + 1, endLine: idx + snippetLines.length };
    }
  }

  return { startLine: 1, endLine: Math.max(1, snippetLines.length) };
}

export function registerHonchoMemoryRuntime(api: any, state: PluginState): void {
  api.registerMemoryRuntime({
    async getMemorySearchManager(params: { agentId?: string }) {
      const { agentId = state.resolveDefaultAgentId() } = params ?? {};

      await state.ensureInitialized();

      return {
        manager: {
          async search(query: string, opts: { maxResults?: number; sessionKey?: string } = {}) {
            await state.ensureInitialized();
            const requested = Number.isFinite(opts.maxResults)
              ? Number(opts.maxResults)
              : DEFAULT_SEARCH_RESULTS;
            const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.trunc(requested)));
            const requestedSessionKey =
              typeof opts.sessionKey === "string" && opts.sessionKey.length > 0 ? opts.sessionKey : null;

            const raw = await state.ownerPeer.search(query, {
              limit: requestedSessionKey ? MAX_SEARCH_RESULTS : limit,
            });

            const filtered = raw
              .filter((msg: any) => {
                if (!requestedSessionKey) return true;
                return msg.sessionId === requestedSessionKey || msg.sessionId.startsWith(`${requestedSessionKey}-`);
              })
              .slice(0, limit);

            const transcriptCache = new Map<string, Promise<string>>();

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
    },

    resolveMemoryBackendConfig(params: { sessionKey?: string; messageProvider?: string } = {}) {
      const sessionKey = buildSessionKey(params);
      return {
        backend: "qmd",
        qmd: {},
        sessionKey,
      };
    },
  });
}
