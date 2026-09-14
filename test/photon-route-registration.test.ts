import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import type {
  CheckedQmChannelOperation,
  NormalizedPhotonInput,
  QmChannelOperationRequest,
} from "../plugins/chassis/src/photon-contract.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import type { App } from "../src/api/app.ts";
import { canonicalPayload } from "../src/api/http.ts";
import { PhotonAuthorizationError } from "../src/api/photon-authorization.ts";
import type { PhotonCoreClient } from "../src/api/photon-core-client.ts";
import { apiRoutes, rawRoutes } from "../src/api/routes/index.ts";
import { createServer } from "../src/api/server.ts";
import { isUnclassifiedWrite, isUserScoped } from "../src/api/user-scoped-routes.ts";

const SECRET = "photon-registration-source-secret-0001";
const CAPABILITY_SECRET = "photon-registration-capability-secret-01";
const PORTAL_SECRET = "photon-registration-portal-secret-000001";

const conversation = {
  provider: "spectrum-imessage" as const,
  installationId: "installation-1",
  projectId: "project-1",
  lineId: "line-1",
  conversationId: "conversation-1",
};

type MessagePhotonInput = Extract<NormalizedPhotonInput, { kind: "message" }>;

const source: MessagePhotonInput = {
  event: {
    provider: conversation.provider,
    installationId: conversation.installationId,
    eventId: "event-registration",
    lineId: conversation.lineId,
    occurredAt: "2026-09-14T08:00:00.000Z",
    direction: "inbound",
  },
  kind: "message",
  conversation,
  actor: { actorId: "provider-human", kind: "human", providerAddress: "+15555550100" },
  message: {
    conversation,
    messageId: "message-registration",
    parts: [{ messageId: "message-registration", partIndex: 0 }],
  },
  content: [{ kind: "text", part: { messageId: "message-registration", partIndex: 0 }, text: "registration" }],
};

function startOperation(suffix: string, actorId = "photon-human") {
  return {
    operationId: `operation-${suffix}`,
    name: "turn.start",
    actorId,
    idempotencyKey: `logical-${suffix}`,
    input: {
      source: "photon",
      request: source,
      redeliveryKey:
        '{"provider":"spectrum-imessage","installationId":"installation-1","lineId":"line-1","eventId":"event-registration"}',
    },
  } satisfies Extract<QmChannelOperationRequest, { name: "turn.start" }>;
}

function checkedOperation(suffix: string, inputSource: MessagePhotonInput = source): CheckedQmChannelOperation {
  return {
    ...startOperation(suffix),
    input: { ...startOperation(suffix).input, request: inputSource },
    authorization: {
      actorId: "photon-human",
      capabilityId: "turn.start",
      resourceRevision: "revision-1",
      checkedAt: "2026-09-14T08:00:00.000Z",
      decision: "allowed",
    },
  };
}

function runOperation(suffix: string, runId = "run-1") {
  return {
    operationId: `operation-${suffix}`,
    name: "run.signal",
    actorId: "photon-human",
    sessionId: "session-1",
    idempotencyKey: `logical-${suffix}`,
    input: { runId, signal: "abort" },
  } satisfies Extract<QmChannelOperationRequest, { name: "run.signal" }>;
}

function approvalOperation(suffix: string) {
  return {
    operationId: `operation-${suffix}`,
    name: "approval.resolve",
    actorId: "photon-human",
    sessionId: "session-1",
    idempotencyKey: `logical-${suffix}`,
    input: { bindingId: "binding-1", decision: "approve" },
  } satisfies Extract<QmChannelOperationRequest, { name: "approval.resolve" }>;
}

function envelope(operation: QmChannelOperationRequest | CheckedQmChannelOperation, inputSource = source): string {
  return JSON.stringify({ source: inputSource, operation });
}

function signed(method: string, path: string, body = ""): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(timestamp),
    "x-signature": signRequest(SECRET, timestamp, canonicalPayload(method, path, body)),
  };
}

async function listen(server: Server): Promise<{ base: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function testServer(photonCore?: PhotonCoreClient): Server {
  return createServer({} as App, {
    signingSecret: SECRET,
    capabilitySecret: CAPABILITY_SECRET,
    portalIdentitySecret: PORTAL_SECRET,
    requireSignedPortalIdentity: true,
    photonCore,
  });
}

const calls: string[] = [];

const core: PhotonCoreClient = {
  async check(_inputSource, operation) {
    calls.push("check");
    if (operation.actorId === "wrong-actor") throw new PhotonAuthorizationError("human_unlinked");
    return {
      ...operation,
      authorization: {
        actorId: operation.actorId,
        capabilityId: operation.name,
        resourceRevision: "revision-1",
        checkedAt: "2026-09-14T08:00:00.000Z",
        decision: "allowed",
      },
    };
  },
  async execute(inputSource) {
    calls.push("execute");
    if (inputSource.conversation.conversationId === "wrong-conversation") {
      throw new PhotonAuthorizationError("conversation_not_bound");
    }
    return { status: "silent" };
  },
  async getRun() {
    calls.push("getRun");
    return { id: "run-1" };
  },
  async activeRun() {
    calls.push("activeRun");
    return { runId: "run-1" };
  },
  async withdrawRun() {
    calls.push("withdrawRun");
    return { withdrawn: true };
  },
  async getApproval() {
    calls.push("getApproval");
    return { requestId: "approval-1" };
  },
  async listSessionApprovals() {
    calls.push("listSessionApprovals");
    return { approvals: [] };
  },
  async pendingDeliveries(claimMs) {
    calls.push(`pendingDeliveries:${String(claimMs)}`);
    return { deliveries: [] };
  },
  async ackDelivery(id) {
    calls.push(`ackDelivery:${id}`);
    return { ok: true };
  },
  async pendingContextRequests() {
    calls.push("pendingContextRequests");
    return { requests: [] };
  },
  async fulfillContextRequest(id) {
    calls.push(`fulfillContextRequest:${id}`);
    return { fulfilled: true };
  },
};

const registeredRoutes = [
  ["POST", "/v1/photon/channel/check"],
  ["POST", "/v1/photon/channel/execute"],
  ["POST", "/v1/photon/runs/:id/read"],
  ["POST", "/v1/photon/runs/active"],
  ["POST", "/v1/photon/runs/:id/withdraw"],
  ["POST", "/v1/photon/approvals/read"],
  ["POST", "/v1/photon/sessions/:id/approvals"],
  ["GET", "/v1/photon/deliveries"],
  ["POST", "/v1/photon/deliveries/:id/ack"],
  ["GET", "/v1/photon/context-requests"],
  ["POST", "/v1/photon/context-requests/:id/result"],
] as const;

describe("Photon production route registration", () => {
  let configured: Awaited<ReturnType<typeof listen>>;
  let unavailable: Awaited<ReturnType<typeof listen>>;

  before(async () => {
    configured = await listen(testServer(core));
    unavailable = await listen(testServer());
  });

  after(async () => {
    await configured.close();
    await unavailable.close();
  });

  it("registers every Photon route only in the authenticated API table", () => {
    const actual = apiRoutes.flatMap((route) =>
      "path" in route && route.path.startsWith("/v1/photon/") ? [[route.method, route.path, route.auth]] : [],
    );
    assert.deepEqual(
      actual,
      registeredRoutes.map(([method, path]) => [method, path, "source"]),
    );
    assert.equal(
      rawRoutes.some((route) => "path" in route && route.path.startsWith("/v1/photon/")),
      false,
    );
  });

  it("classifies exactly the Photon write routes as system-to-system", () => {
    for (const [method, path] of registeredRoutes) {
      const concretePath = path.replace(":id", "resource-1");
      assert.equal(isUserScoped(method, concretePath), false, `${method} ${path} must not become user-scoped`);
      if (method === "POST") assert.equal(isUnclassifiedWrite(method, concretePath), false, `${method} ${path}`);
    }
    assert.equal(isUnclassifiedWrite("POST", "/v1/photon/unregistered"), true);
  });

  it("serves every registered route through the configured ServerDeps core", async () => {
    calls.length = 0;
    const requests = [
      ["POST", "/v1/photon/channel/check", envelope(startOperation("registered-check"))],
      ["POST", "/v1/photon/channel/execute", envelope(checkedOperation("registered-execute"))],
      ["POST", "/v1/photon/runs/run-1/read", envelope(runOperation("registered-read"))],
      ["POST", "/v1/photon/runs/active", envelope(startOperation("registered-active"))],
      ["POST", "/v1/photon/runs/run-1/withdraw", envelope(runOperation("registered-withdraw"))],
      ["POST", "/v1/photon/approvals/read", envelope(approvalOperation("registered-approval"))],
      ["POST", "/v1/photon/sessions/session-1/approvals", envelope(runOperation("registered-session"))],
      ["GET", "/v1/photon/deliveries?claimMs=2500", ""],
      ["POST", "/v1/photon/deliveries/delivery-1/ack", "{}"],
      ["GET", "/v1/photon/context-requests", ""],
      ["POST", "/v1/photon/context-requests/context-1/result", JSON.stringify({ messages: [] })],
    ] as const;
    for (const [method, path, body] of requests) {
      const response = await fetch(`${configured.base}${path}`, {
        method,
        headers: signed(method, path, body),
        ...(body ? { body } : {}),
      });
      assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: ${response.status}`);
    }
    assert.deepEqual(calls, [
      "check",
      "execute",
      "getRun",
      "activeRun",
      "withdrawRun",
      "getApproval",
      "listSessionApprovals",
      "pendingDeliveries:2500",
      "ackDelivery:delivery-1",
      "pendingContextRequests",
      "fulfillContextRequest:context-1",
    ]);
  });

  it("returns explicit unavailable responses for every route when composition is absent", async () => {
    const requests = [
      ["POST", "/v1/photon/channel/check", envelope(startOperation("unavailable-check"))],
      ["POST", "/v1/photon/channel/execute", envelope(checkedOperation("unavailable-execute"))],
      ["POST", "/v1/photon/runs/run-1/read", envelope(runOperation("unavailable-read"))],
      ["POST", "/v1/photon/runs/active", envelope(startOperation("unavailable-active"))],
      ["POST", "/v1/photon/runs/run-1/withdraw", envelope(runOperation("unavailable-withdraw"))],
      ["POST", "/v1/photon/approvals/read", envelope(approvalOperation("unavailable-approval"))],
      ["POST", "/v1/photon/sessions/session-1/approvals", envelope(runOperation("unavailable-session"))],
      ["GET", "/v1/photon/deliveries", ""],
      ["POST", "/v1/photon/deliveries/delivery-1/ack", "{}"],
      ["GET", "/v1/photon/context-requests", ""],
      ["POST", "/v1/photon/context-requests/context-1/result", "{}"],
    ] as const;
    for (const [method, path, body] of requests) {
      const response = await fetch(`${unavailable.base}${path}`, {
        method,
        headers: signed(method, path, body),
        ...(body ? { body } : {}),
      });
      assert.equal(response.status, 503, `${method} ${path}`);
      assert.deepEqual(await response.json(), { error: "unavailable", code: "photon_not_configured" });
    }
  });

  it("rejects missing, wrong, modified, and replayed source authentication", async () => {
    const path = "/v1/photon/channel/check";
    const body = envelope(startOperation("auth"));
    assert.equal(
      (
        await fetch(`${configured.base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
      ).status,
      401,
    );
    const wrong = signed("POST", path, body);
    wrong["x-signature"] = "v1=wrong";
    assert.equal((await fetch(`${configured.base}${path}`, { method: "POST", headers: wrong, body })).status, 401);
    assert.equal(
      (
        await fetch(`${configured.base}${path}`, {
          method: "POST",
          headers: signed("POST", path, body),
          body: body.replace("photon-human", "modified-human"),
        })
      ).status,
      401,
    );
    const replayHeaders = signed("POST", path, body);
    assert.equal(
      (await fetch(`${configured.base}${path}`, { method: "POST", headers: replayHeaders, body })).status,
      200,
    );
    assert.equal(
      (await fetch(`${configured.base}${path}`, { method: "POST", headers: replayHeaders, body })).status,
      401,
    );
  });

  it("source-authenticates delivery and context reads without replay-deduplicating them", async () => {
    for (const path of ["/v1/photon/deliveries", "/v1/photon/context-requests"]) {
      assert.equal((await fetch(`${configured.base}${path}`)).status, 401);
      const wrong = signed("GET", path);
      wrong["x-signature"] = "v1=wrong";
      assert.equal((await fetch(`${configured.base}${path}`, { headers: wrong })).status, 401);
      const repeatable = signed("GET", path);
      assert.equal((await fetch(`${configured.base}${path}`, { headers: repeatable })).status, 200);
      assert.equal((await fetch(`${configured.base}${path}`, { headers: repeatable })).status, 200);
    }
  });

  it("keeps envelope and path identifier validation inside the registered route", async () => {
    const malformedPath = "/v1/photon/channel/check";
    const malformed = JSON.stringify({ source: {} });
    const malformedResponse = await fetch(`${configured.base}${malformedPath}`, {
      method: "POST",
      headers: signed("POST", malformedPath, malformed),
      body: malformed,
    });
    assert.equal(malformedResponse.status, 400);

    const mismatchPath = "/v1/photon/runs/wrong-run/read";
    const mismatch = envelope(runOperation("mismatch", "run-1"));
    const mismatchResponse = await fetch(`${configured.base}${mismatchPath}`, {
      method: "POST",
      headers: signed("POST", mismatchPath, mismatch),
      body: mismatch,
    });
    assert.equal(mismatchResponse.status, 400);
  });

  it("keeps linked-human and conversation authorization failures distinct from source authentication", async () => {
    const actorPath = "/v1/photon/channel/check";
    const actorBody = envelope(startOperation("wrong-actor", "wrong-actor"));
    const actorResponse = await fetch(`${configured.base}${actorPath}`, {
      method: "POST",
      headers: signed("POST", actorPath, actorBody),
      body: actorBody,
    });
    assert.equal(actorResponse.status, 403);
    assert.equal(((await actorResponse.json()) as { code?: string }).code, "human_unlinked");

    const wrongConversation = { ...conversation, conversationId: "wrong-conversation" };
    const conversationSource: MessagePhotonInput = {
      ...source,
      conversation: wrongConversation,
      message: { ...source.message, conversation: wrongConversation },
    };
    const executePath = "/v1/photon/channel/execute";
    const executeBody = envelope(checkedOperation("wrong-conversation", conversationSource), conversationSource);
    const executeResponse = await fetch(`${configured.base}${executePath}`, {
      method: "POST",
      headers: signed("POST", executePath, executeBody),
      body: executeBody,
    });
    assert.equal(executeResponse.status, 403);
    assert.equal(((await executeResponse.json()) as { code?: string }).code, "conversation_not_bound");
  });

  it("does not let source authentication bypass an existing portal-only route", async () => {
    const path = "/v1/sessions/nope?viewer=photon-human";
    const response = await fetch(`${configured.base}${path}`, { headers: signed("GET", path) });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized", message: "portal identity required" });
  });
});
