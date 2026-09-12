import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "../src/api/server.ts";
import { CAPABILITY_TTL_MS, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { createPhotonDestination } from "../src/surfaces/photon-destinations.ts";
import type { Destination, ScopeId } from "../src/types.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "photon-context-secret".repeat(3);
const conversation = {
  provider: "spectrum-imessage" as const,
  installationId: "installation-1",
  projectId: "project-1",
  lineId: "line-1",
  conversationId: "any;-;+15555550101",
};
const foreignConversation = { ...conversation, conversationId: "any;-;+15555550999" };

describe("Photon surface context authorization", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;
  let pollSeq = 0;

  const post = (path: string, body: unknown, token: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": token },
      body: JSON.stringify(body),
    });

  const signedGet = (path: string) =>
    fetch(`${base}${path}`, { headers: signedRequestHeaders(SECRET, "GET", path, "") });

  const signedPost = (path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signedRequestHeaders(SECRET, "POST", path, raw) },
      body: raw,
    });
  };

  const pending = async (source: string) => {
    const path = `/v1/surface-context/pending?source=${source}&t=${pollSeq++}`;
    return (await (await signedGet(path)).json()) as { requests: Array<{ id: string; query: any }> };
  };

  const fulfillNext = async (source: string, answer: (query: any) => unknown) => {
    for (let index = 0; index < 100; index += 1) {
      const found = await pending(source);
      if (found.requests.length) {
        const request = found.requests[0]!;
        assert.equal((await signedPost(`/v1/surface-context/${request.id}/result`, answer(request.query))).status, 200);
        return request.query;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("no pending context request appeared");
  };

  const capability = (destination: Destination) =>
    mintCapabilityToken(
      {
        actorId: "alice",
        scopeId: "personal:alice" as ScopeId,
        destination,
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      SECRET,
    );

  before(async () => {
    built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "photon-context-")), signingSecret: SECRET }));
    server = createServer(built.app, { signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    await built.app.upsertDirectory([{ principalId: "alice", displayName: "Alice", type: "internal" }]);
    await built.app.upsertChannels([{ channelId: "C-general", name: "general" }], []);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("keeps an ordinary Slack current-conversation history request unchanged", async () => {
    const token = await capability({ type: "slack", target: "C-general:1.0", audienceScopeId: "channel:C-general" });
    const asking = post("/v1/surface-context", { count: 2 }, token);
    const query = await fulfillNext("slack", () => ({ messages: [] }));
    assert.equal(query.conversationTarget, "C-general:1.0");
    assert.equal(query.conversation, undefined);
    assert.equal((await asking).status, 200);
  });

  it("passes only the capability-bound structured Photon conversation to history", async () => {
    const destination = createPhotonDestination({
      conversation,
      kind: "dm",
      principalIds: ["alice"],
      audienceScopeId: "personal:alice",
      recipientPrincipalId: "alice",
    });
    const token = await capability(destination);
    const asking = post("/v1/surface-context", { count: 3, conversation }, token);
    const query = await fulfillNext("photon", () => ({ messages: [{ text: "hello" }] }));
    assert.equal(query.conversationTarget, conversation.conversationId);
    assert.deepEqual(query.conversation, conversation);
    assert.equal((await asking).status, 200);
  });

  it("denies foreign Photon history before a request can be parked", async () => {
    const destination = createPhotonDestination({
      conversation,
      kind: "dm",
      principalIds: ["alice"],
      audienceScopeId: "personal:alice",
      recipientPrincipalId: "alice",
    });
    const response = await post(
      "/v1/surface-context",
      { conversation: foreignConversation },
      await capability(destination),
    );
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as any).error, "foreign_conversation");
    assert.deepEqual((await pending("photon")).requests, []);
  });

  it("scopes Photon file requests to the current conversation and denies a foreign message reference", async () => {
    const destination = createPhotonDestination({
      conversation,
      kind: "dm",
      principalIds: ["alice"],
      audienceScopeId: "personal:alice",
      recipientPrincipalId: "alice",
    });
    const token = await capability(destination);
    const message = { ...conversation, messageId: "message-1" };
    const asking = post("/v1/surface-file", { message }, token);
    const query = await fulfillNext("photon", () => ({ file: { blobId: "blob-1", name: "photo.jpg", sizeBytes: 4 } }));
    assert.deepEqual(query.file, { ts: "message-1", providerMessage: message });
    assert.equal((await asking).status, 200);

    const denied = await post(
      "/v1/surface-file",
      { message: { ...foreignConversation, messageId: "message-2" } },
      token,
    );
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as any).error, "foreign_conversation");
    assert.deepEqual((await pending("photon")).requests, []);
  });
});
