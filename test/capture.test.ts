import { describe, expect, it, vi } from "vitest";
import { dedupeAgainstRecentTail, HONCHO_MESSAGES_LIST_MAX_SIZE } from "../hooks/capture.js";
import type { MessageInput } from "@honcho-ai/sdk";

type FakeMessage = { peerId: string; createdAt?: string; content: string };

function page(items: FakeMessage[], pageNo: number, pages: number) {
  return {
    items,
    hasNextPage: pageNo < pages,
    getNextPage: vi.fn(async () => null),
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

  it("never requests more than Honcho's messages/list max page size", async () => {
    const recent = page([
      { peerId: "owner", createdAt: "2026-04-30T00:00:00Z", content: "already saved" },
    ], 1, 1);
    const session = {
      messages: vi.fn(async () => recent),
    };
    const extracted: MessageInput[] = [
      { peerId: "owner", createdAt: "2026-04-30T00:00:00Z", content: "already saved" },
      { peerId: "owner", createdAt: "2026-04-30T00:00:01Z", content: "new" },
    ];

    const result = await dedupeAgainstRecentTail(session as never, extracted, 200);

    expect(session.messages).toHaveBeenCalledWith({
      size: HONCHO_MESSAGES_LIST_MAX_SIZE,
      reverse: true,
    });
    expect(result).toEqual([
      { peerId: "owner", createdAt: "2026-04-30T00:00:01Z", content: "new" },
    ]);
  });

  it("walks additional pages when the configured tail is larger than one Honcho page", async () => {
    const second = page(
      [{ peerId: "owner", createdAt: "2026-04-30T00:00:42Z", content: "older duplicate" }],
      2,
      2,
    );
    const first = page([], 1, 2);
    first.getNextPage = vi.fn(async () => second);
    const session = {
      messages: vi.fn(async () => first),
    };
    const extracted: MessageInput[] = [
      { peerId: "owner", createdAt: "2026-04-30T00:00:42Z", content: "older duplicate" },
      { peerId: "owner", createdAt: "2026-04-30T00:00:43Z", content: "new" },
    ];

    const result = await dedupeAgainstRecentTail(session as never, extracted, 200);

    expect(first.getNextPage).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { peerId: "owner", createdAt: "2026-04-30T00:00:43Z", content: "new" },
    ]);
  });
});
