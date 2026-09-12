import assert from "node:assert/strict";
import test from "node:test";

import type {
  CheckedQmChannelOperation,
  NormalizedPhotonInput,
  QmChannelOperationRequest,
} from "../../chassis/src/photon-contract.ts";
import { canonicalPayload, signRequest } from "../../chassis/src/source-auth-sign.ts";
import { createPhotonQmClient, PhotonQmClientError } from "../src/qm-client.ts";

const SECRET = "photon-qm-client-signing-secret-0001";

const conversation = {
  provider: "spectrum-imessage" as const,
  installationId: "installation-1",
  projectId: "project-1",
  lineId: "line-1",
  conversationId: "conversation-1",
};

const source: NormalizedPhotonInput = {
  event: {
    provider: conversation.provider,
    installationId: conversation.installationId,
    eventId: "event-1",
    lineId: conversation.lineId,
    occurredAt: "2026-09-12T08:00:00.000Z",
    direction: "inbound",
  },
  kind: "message",
  conversation,
  actor: { actorId: "provider-human", kind: "human", providerAddress: "+15555550100" },
  message: { conversation, messageId: "message-1", parts: [{ messageId: "message-1", partIndex: 0 }] },
  content: [{ kind: "text", part: { messageId: "message-1", partIndex: 0 }, text: "hello" }],
};

const signal: Extract<QmChannelOperationRequest, { name: "run.signal" }> = {
  operationId: "operation-signal",
  name: "run.signal",
  actorId: "photon-human",
  sessionId: "session-1",
  idempotencyKey: "logical-signal",
  input: { runId: "run-1", signal: "steer", text: "continue" },
};

const checkedSignal: CheckedQmChannelOperation = {
  ...signal,
  authorization: {
    actorId: signal.actorId,
    capabilityId: signal.name,
    resourceRevision: "revision-1",
    checkedAt: "2026-09-12T08:00:00.000Z",
    decision: "allowed",
  },
};

function assertSigned(input: string | URL | Request, init: RequestInit | undefined): string {
  assert.equal(typeof input, "string");
  const url = new URL(input);
  const headers = new Headers(init?.headers);
  const timestamp = Number(headers.get("x-timestamp"));
  const body = typeof init?.body === "string" ? init.body : "";
  assert.equal(
    headers.get("x-signature"),
    signRequest(SECRET, timestamp, canonicalPayload(init?.method ?? "GET", `${url.pathname}${url.search}`, body)),
  );
  assert.ok(url.searchParams.get("_sourceAuthNonce"));
  return `${url.pathname}${url.search}`;
}

test("read-safe checks retry 5xx with a fresh signed source-auth nonce", async () => {
  const paths: string[] = [];
  let attempts = 0;
  const requestFetch: typeof fetch = async (input, init) => {
    paths.push(assertSigned(input, init));
    attempts += 1;
    if (attempts === 1) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
    return new Response(JSON.stringify(checkedSignal), { status: 200 });
  };
  const client = createPhotonQmClient(
    { coreUrl: "http://qm.internal/", signingSecret: SECRET, fetch: requestFetch, readAttempts: 2 },
    source,
  );
  assert.deepEqual(await client.check(signal), checkedSignal);
  assert.equal(attempts, 2);
  assert.notEqual(paths[0], paths[1]);
  assert.ok(paths.every((path) => path.startsWith("/v1/photon/channel/check?_sourceAuthNonce=")));
});

test("logically deduplicated execution retries 5xx and keeps the operation idempotency key", async () => {
  const bodies: string[] = [];
  let attempts = 0;
  const requestFetch: typeof fetch = async (input, init) => {
    assertSigned(input, init);
    bodies.push(String(init?.body));
    attempts += 1;
    if (attempts === 1) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  };
  const client = createPhotonQmClient(
    { coreUrl: "http://qm.internal", signingSecret: SECRET, fetch: requestFetch, readAttempts: 2 },
    source,
  );
  assert.deepEqual(await client.execute(checkedSignal), { accepted: true });
  assert.equal(attempts, 2);
  assert.deepEqual(
    bodies.map((body) => JSON.parse(body).operation.idempotencyKey),
    ["logical-signal", "logical-signal"],
  );
});

test("approval transport failures are unknown-outcome and are never retried blindly", async () => {
  let attempts = 0;
  const requestFetch: typeof fetch = async () => {
    attempts += 1;
    throw new Error("socket closed");
  };
  const approval: CheckedQmChannelOperation = {
    operationId: "operation-approval",
    name: "approval.resolve",
    actorId: "photon-human",
    sessionId: "session-1",
    idempotencyKey: "logical-approval",
    input: { bindingId: "binding-1", decision: "approve" },
    authorization: {
      actorId: "photon-human",
      capabilityId: "approval.resolve",
      resourceRevision: "revision-1",
      checkedAt: "2026-09-12T08:00:00.000Z",
      decision: "allowed",
    },
  };
  const client = createPhotonQmClient(
    { coreUrl: "http://qm.internal", signingSecret: SECRET, fetch: requestFetch, readAttempts: 3 },
    source,
  );
  await assert.rejects(
    () => client.execute(approval),
    (error) =>
      error instanceof PhotonQmClientError && error.code === "transport_error" && error.outcome === "unknown-outcome",
  );
  assert.equal(attempts, 1);
});

test("approval 5xx responses are unknown-outcome and are never retried blindly", async () => {
  let attempts = 0;
  const requestFetch: typeof fetch = async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
  };
  const approval: CheckedQmChannelOperation = {
    operationId: "operation-approval-5xx",
    name: "approval.resolve",
    actorId: "photon-human",
    sessionId: "session-1",
    idempotencyKey: "logical-approval-5xx",
    input: { bindingId: "binding-1", decision: "approve" },
    authorization: {
      actorId: "photon-human",
      capabilityId: "approval.resolve",
      resourceRevision: "revision-1",
      checkedAt: "2026-09-12T08:00:00.000Z",
      decision: "allowed",
    },
  };
  const client = createPhotonQmClient(
    { coreUrl: "http://qm.internal", signingSecret: SECRET, fetch: requestFetch, readAttempts: 3 },
    source,
  );
  await assert.rejects(
    () => client.execute(approval),
    (error) => error instanceof PhotonQmClientError && error.status === 503 && error.outcome === "unknown-outcome",
  );
  assert.equal(attempts, 1);
});

test("confirmed QM authorization failures preserve their status and code", async () => {
  const requestFetch: typeof fetch = async (input, init) => {
    assertSigned(input, init);
    return new Response(JSON.stringify({ error: "forbidden", code: "human_unlinked" }), { status: 403 });
  };
  const client = createPhotonQmClient(
    { coreUrl: "http://qm.internal", signingSecret: SECRET, fetch: requestFetch },
    source,
  );
  await assert.rejects(
    () => client.check(signal),
    (error) =>
      error instanceof PhotonQmClientError &&
      error.status === 403 &&
      error.code === "human_unlinked" &&
      error.outcome === "confirmed-failure",
  );
});
