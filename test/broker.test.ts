import { EventEmitter, once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHonchoAuthBrokerHandler,
  HONCHO_AUTH_BROKER_BASE_PATH,
  HONCHO_MAX_EMBEDDING_INPUT_CHARS,
  HONCHO_MAX_EMBEDDING_INPUTS,
  registerHonchoAuthBroker,
  type HonchoAuthBrokerDependencies,
} from "../broker.js";
import type { HonchoAuthBrokerConfig } from "../config.js";

const BROKER_TOKEN = "broker-test-token-that-is-at-least-32-characters";
const OAUTH_TOKEN = "oauth-access-token-never-returned-to-the-client";

const config: HonchoAuthBrokerConfig = {
  enabled: true,
  bearerToken: BROKER_TOKEN,
  authAgentId: "main",
  responseModels: ["gpt-5.4-mini", "gpt-5.4"],
  maxRequestBytes: 4096,
  timeoutMs: 5000,
};

const servers = new Set<Server>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        }),
    ),
  );
  servers.clear();
});

async function withBroker(
  dependencies: HonchoAuthBrokerDependencies,
  run: (baseUrl: string) => Promise<void>,
  brokerConfig = config,
): Promise<void> {
  const handler = createHonchoAuthBrokerHandler(brokerConfig, dependencies);
  const server = createServer(async (req, res) => {
    const handled = await handler(req, res);
    if (!handled && !res.writableEnded) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");
  await run(`http://127.0.0.1:${address.port}`);
}

function defaultDependencies(fetchImpl: typeof fetch): HonchoAuthBrokerDependencies {
  return {
    fetch: fetchImpl,
    resolveBearerToken: vi.fn(async () => BROKER_TOKEN),
    resolveCredential: vi.fn(async () => ({
      accessToken: OAUTH_TOKEN,
      accountId: "account-123",
      profileId: "openai:codex",
    })),
  };
}

async function invokeBrokerDirectly(
  body: string,
  dependencies: HonchoAuthBrokerDependencies,
  brokerConfig: HonchoAuthBrokerConfig,
): Promise<{ body: string; statusCode: number }> {
  const request = Readable.from([body]) as IncomingMessage;
  request.method = "POST";
  request.url = `${HONCHO_AUTH_BROKER_BASE_PATH}/embeddings`;
  request.headers = {
    authorization: `Bearer ${BROKER_TOKEN}`,
    "content-type": "application/json",
  };

  const responseEvents = new EventEmitter();
  let responseBody = "";
  const response = Object.assign(responseEvents, {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader: vi.fn(),
    end(chunk?: string | Buffer) {
      responseBody += chunk?.toString() ?? "";
      this.headersSent = true;
      this.writableEnded = true;
      responseEvents.emit("close");
      return this;
    },
  }) as unknown as ServerResponse;

  await createHonchoAuthBrokerHandler(brokerConfig, dependencies)(request, response);
  return { body: responseBody, statusCode: response.statusCode };
}

describe("Honcho auth broker", () => {
  it("rejects unauthenticated requests before resolving OAuth or reading upstream", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const resolveBearerToken = vi.fn(async () => BROKER_TOKEN);
    const resolveCredential = vi.fn(async () => ({
      accessToken: OAUTH_TOKEN,
      accountId: "account-123",
      profileId: "openai:codex",
    }));

    await withBroker(
      {
        fetch: fetchMock,
        resolveBearerToken,
        resolveCredential,
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}${HONCHO_AUTH_BROKER_BASE_PATH}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "text-embedding-3-small", input: "hello" }),
        });
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain("Bearer");
        expect(await response.text()).not.toContain(BROKER_TOKEN);
      },
    );

    expect(resolveBearerToken).not.toHaveBeenCalled();
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when its configured bearer token cannot be resolved", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const resolveCredential = vi.fn(async () => ({
      accessToken: OAUTH_TOKEN,
      accountId: "account-123",
      profileId: "openai:codex",
    }));

    await withBroker(
      {
        fetch: fetchMock,
        resolveBearerToken: vi.fn(async () => {
          throw new Error("secret provider unavailable");
        }),
        resolveCredential,
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}${HONCHO_AUTH_BROKER_BASE_PATH}/embeddings`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${BROKER_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "text-embedding-3-small", input: "hello" }),
        });
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain("secret provider unavailable");
      },
    );

    expect(resolveCredential).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards bounded embeddings with canonical Codex OAuth to the fixed endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            object: "list",
            model: "text-embedding-3-small",
            data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const dependencies = defaultDependencies(fetchMock);

    await withBroker(dependencies, async (baseUrl) => {
      const response = await fetch(`${baseUrl}${HONCHO_AUTH_BROKER_BASE_PATH}/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${BROKER_TOKEN}`,
          "content-type": "application/json",
          "x-untrusted-header": "must-not-forward",
        },
        body: JSON.stringify({ model: "text-embedding-3-small", input: "hello" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        object: "list",
        model: "text-embedding-3-small",
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
      });
    });

    expect(dependencies.resolveCredential).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(headers.get("chatgpt-account-id")).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "text-embedding-3-small",
      input: ["hello"],
    });
  });

  it.each([
    {
      name: "an unsupported model",
      body: { model: "text-embedding-3-large", input: "hello" },
    },
    {
      name: "a caller-controlled URL",
      body: {
        model: "text-embedding-3-small",
        input: "hello",
        url: "https://attacker.invalid/v1/embeddings",
      },
    },
    {
      name: "too many inputs",
      body: {
        model: "text-embedding-3-small",
        input: Array.from({ length: HONCHO_MAX_EMBEDDING_INPUTS + 1 }, () => "x"),
      },
    },
    {
      name: "an oversized input",
      body: {
        model: "text-embedding-3-small",
        input: "x".repeat(HONCHO_MAX_EMBEDDING_INPUT_CHARS + 1),
      },
    },
  ])("rejects embeddings with $name before credential resolution", async ({ body }) => {
    const fetchMock = vi.fn<typeof fetch>();
    const dependencies = defaultDependencies(fetchMock);

    await withBroker(
      dependencies,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}${HONCHO_AUTH_BROKER_BASE_PATH}/embeddings`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${BROKER_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
      },
      { ...config, maxRequestBytes: 128 * 1024 },
    );

    expect(dependencies.resolveCredential).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a model outside the allowlist",
      body: { model: "gpt-4.1", input: "hello" },
    },
    {
      name: "a caller-controlled URL",
      body: {
        model: "gpt-5.4-mini",
        input: "hello",
        url: "https://attacker.invalid/v1/responses",
      },
    },
  ])("rejects Responses with $name before OAuth resolution", async ({ body }) => {
    const fetchMock = vi.fn<typeof fetch>();
    const dependencies = defaultDependencies(fetchMock);

    await withBroker(dependencies, async (baseUrl) => {
      const response = await fetch(`${baseUrl}${HONCHO_AUTH_BROKER_BASE_PATH}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${BROKER_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    });

    expect(dependencies.resolveCredential).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards Codex Responses with account routing, streaming headers, and store disabled", async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"resp-1"}}',
      'data: {"type":"response.completed","response":{"id":"resp-1","status":"completed"}}',
      "",
    ].join("\n\n");
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    await withBroker(defaultDependencies(fetchMock), async (baseUrl) => {
      const response = await fetch(`${baseUrl}${HONCHO_AUTH_BROKER_BASE_PATH}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${BROKER_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.4-mini", input: "hello", stream: true, store: true }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("chatgpt-account-id")).toBeNull();
      expect(await response.text()).toContain("response.completed");
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${OAUTH_TOKEN}`);
    expect(headers.get("chatgpt-account-id")).toBe("account-123");
    expect(headers.get("originator")).toBe("openclaw");
    expect(headers.get("openai-beta")).toBe("responses=experimental");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("session_id")).toMatch(/^honcho-/);
    expect(headers.get("x-client-request-id")).toBe(headers.get("session_id"));
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-5.4-mini",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
      stream: true,
      store: false,
    });
  });

  it("fails closed without exposing rejected OAuth material", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: { message: `bad ${OAUTH_TOKEN}` } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );

    await withBroker(defaultDependencies(fetchMock), async (baseUrl) => {
      const response = await fetch(`${baseUrl}${HONCHO_AUTH_BROKER_BASE_PATH}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${BROKER_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.4-mini", input: "hello" }),
      });
      const text = await response.text();
      expect(response.status).toBe(503);
      expect(text).not.toContain(OAUTH_TOKEN);
      expect(text).not.toContain(BROKER_TOKEN);
    });
  });

  it("force-refreshes the same OAuth profile once after a 401", async () => {
    const refreshedToken = "refreshed-oauth-access-token-never-returned-to-the-client";
    const resolveCredential = vi.fn(async (options?: { forceRefresh?: boolean }) => ({
      accessToken: options?.forceRefresh ? refreshedToken : OAUTH_TOKEN,
      accountId: "account-123",
      profileId: "openai:codex",
    }));
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const token = new Headers(init?.headers).get("authorization");
      return token === `Bearer ${refreshedToken}`
        ? new Response(JSON.stringify({ id: "resp-1", status: "completed" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("unauthorized", { status: 401 });
    });
    const dependencies = defaultDependencies(fetchMock);
    dependencies.resolveCredential = resolveCredential;

    await withBroker(dependencies, async (baseUrl) => {
      const response = await fetch(`${baseUrl}${HONCHO_AUTH_BROKER_BASE_PATH}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${BROKER_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.4-mini", input: "hello" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "completed" });
    });

    expect(resolveCredential).toHaveBeenNthCalledWith(1);
    expect(resolveCredential).toHaveBeenNthCalledWith(2, {
      forceRefresh: true,
      profileId: "openai:codex",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never refreshes or retries an OAuth credential after a 403", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("forbidden", { status: 403 }));
    const dependencies = defaultDependencies(fetchMock);

    await withBroker(dependencies, async (baseUrl) => {
      const response = await fetch(`${baseUrl}${HONCHO_AUTH_BROKER_BASE_PATH}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${BROKER_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.4-mini", input: "hello" }),
      });
      expect(response.status).toBe(503);
    });

    expect(dependencies.resolveCredential).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds request bodies before resolving OpenAI OAuth", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const resolveCredential = vi.fn(async () => ({
      accessToken: OAUTH_TOKEN,
      accountId: "account-123",
      profileId: "openai:codex",
    }));
    const response = await invokeBrokerDirectly(
      JSON.stringify({ input: "x".repeat(2000) }),
      {
        fetch: fetchMock,
        resolveBearerToken: vi.fn(async () => BROKER_TOKEN),
        resolveCredential,
      },
      { ...config, maxRequestBytes: 128 },
    );
    expect(response.statusCode).toBe(413);
    expect(response.body).toBe("Payload too large");
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registers one plugin-authenticated prefix only when enabled", () => {
    const registerHttpRoute = vi.fn();
    const api = { registerHttpRoute } as never;

    registerHonchoAuthBroker(api, { ...config, enabled: false });
    expect(registerHttpRoute).not.toHaveBeenCalled();

    registerHonchoAuthBroker(api, config);
    expect(registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: HONCHO_AUTH_BROKER_BASE_PATH,
        auth: "plugin",
        match: "prefix",
        handler: expect.any(Function),
      }),
    );
  });

  it("does not claim paths outside the two exact broker endpoints", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await withBroker(defaultDependencies(fetchMock), async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}${HONCHO_AUTH_BROKER_BASE_PATH}/responses/unexpected`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${BROKER_TOKEN}`,
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      expect(response.status).toBe(404);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
