import { describe, expect, it, vi } from "vitest";
import { dedupeAgainstRecentTail, HONCHO_MESSAGES_LIST_MAX_SIZE } from "../hooks/capture.js";
import type { MessageInput, MessageResponse, PageResponse } from "@honcho-ai/sdk";

type FakeMessage = { peerId: string; createdAt?: string; content: string };

function apiMessage(message: FakeMessage): MessageResponse {
  return {
    id: `msg-${message.createdAt ?? message.content}`,
    content: message.content,
    peer_id: message.peerId,
    session_id: "session-1",
    workspace_id: "workspace-1",
    metadata: {},
    created_at: message.createdAt ?? "2026-04-30T00:00:00Z",
    token_count: 1,
  };
}

function response(items: FakeMessage[], page: number, pages: number, size = HONCHO_MESSAGES_LIST_MAX_SIZE): PageResponse<MessageResponse> {
  return {
    items: items.map(apiMessage),
    page,
    size,
    total: items.length,
    pages,
  };
}

function fakeSession(responses: PageResponse<MessageResponse>[]) {
  const post = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra page request");
    return next;
  });

  return {
    id: "session-1",
    workspaceId: "workspace-1",
    _ensureWorkspace: vi.fn(async () => undefined),
    _http: { post },
    messages: vi.fn(async () => {
      throw new Error("Session.messages() treats pagination options as filters in @honcho-ai/sdk@2");
    }),
  };
}

describe("dedupeAgainstRecentTail", () => {
  it("dedupes within the current batch without fetching the recent tail when disabled", async () => {
    const session = {
      messages: vi.fn(),
    };
    const extracted: MessageInput[] = [
      { peerId: "owner", createdAt: "2026-04-30T00:00:00Z", content: "same" },
      { peerId: "owner", createdAt: "2026-04-30T00:00:00Z", content: "same" },
      { peerId: "owner", createdAt: "2026-04-30T00:00:01Z", content: "new" },
    ];

    const result = await dedupeAgainstRecentTail(session as never, extracted, 0);

    expect(session.messages).not.toHaveBeenCalled();
    expect(result).toEqual([
      { peerId: "owner", createdAt: "2026-04-30T00:00:00Z", content: "same" },
      { peerId: "owner", createdAt: "2026-04-30T00:00:01Z", content: "new" },
    ]);
  });

  it("passes pagination as query params instead of Honcho message filters", async () => {
    const session = fakeSession([
      response([
        { peerId: "owner", createdAt: "2026-04-30T00:00:00Z", content: "already saved" },
      ], 1, 1),
    ]);
    const extracted: MessageInput[] = [
      { peerId: "owner", createdAt: "2026-04-30T00:00:00Z", content: "already saved" },
      { peerId: "owner", createdAt: "2026-04-30T00:00:01Z", content: "new" },
    ];

    const result = await dedupeAgainstRecentTail(session as never, extracted, 200);

    expect(session.messages).not.toHaveBeenCalled();
    expect(session._http.post).toHaveBeenCalledWith(
      "/v3/workspaces/workspace-1/sessions/session-1/messages/list",
      {
        body: { filters: undefined },
        query: {
          page: undefined,
          size: HONCHO_MESSAGES_LIST_MAX_SIZE,
          reverse: true,
        },
      },
    );
    expect(result).toEqual([
      { peerId: "owner", createdAt: "2026-04-30T00:00:01Z", content: "new" },
    ]);
  });

  it("walks additional pages when the configured tail is larger than one Honcho page", async () => {
    const session = fakeSession([
      response([], 1, 2),
      response(
        [{ peerId: "owner", createdAt: "2026-04-30T00:00:42Z", content: "older duplicate" }],
        2,
        2,
      ),
    ]);
    const extracted: MessageInput[] = [
      { peerId: "owner", createdAt: "2026-04-30T00:00:42Z", content: "older duplicate" },
      { peerId: "owner", createdAt: "2026-04-30T00:00:43Z", content: "new" },
    ];

    const result = await dedupeAgainstRecentTail(session as never, extracted, 200);

    expect(session._http.post).toHaveBeenCalledTimes(2);
    expect(session._http.post).toHaveBeenLastCalledWith(
      "/v3/workspaces/workspace-1/sessions/session-1/messages/list",
      {
        body: { filters: undefined },
        query: {
          page: 2,
          size: HONCHO_MESSAGES_LIST_MAX_SIZE,
          reverse: true,
        },
      },
    );
    expect(result).toEqual([
      { peerId: "owner", createdAt: "2026-04-30T00:00:43Z", content: "new" },
    ]);
  });
});
