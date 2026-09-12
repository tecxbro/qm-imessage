import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  CheckedQmChannelOperation,
  NormalizedPhotonInput,
  QmChannelOperationRequest,
} from "../plugins/chassis/src/photon-contract.ts";
import { createSourceAuth, signRequest } from "../src/auth/source-auth.ts";
import { canonicalPayload, readRawBody, sendJson, verifyOrReject } from "../src/api/http.ts";
import { PhotonAuthorizationError } from "../src/api/photon-authorization.ts";
import { createPhotonCoreClient, type PhotonCoreClient } from "../src/api/photon-core-client.ts";
import { createPhotonRoutes } from "../src/api/routes/photon.ts";
import { dispatch, type ApiCtx } from "../src/api/routes/route.ts";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "photon-source-auth-secret-for-tests-0001";
const PORTAL_SECRET = "photon-portal-identity-secret-for-tests-01";
const CAPABILITY_SECRET = "photon-capability-secret-for-tests-000001";

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

const operation: Extract<QmChannelOperationRequest, { name: "turn.start" }> = {
  operationId: "operation-1",
  name: "turn.start",
  actorId: "photon-human",
  idempotencyKey: "logical-1",
  input: {
    source: "photon",
    request: source,
    redeliveryKey:
      '{"provider":"spectrum-imessage","installationId":"installation-1","lineId":"line-1","eventId":"event-1"}',
  },
};

const checked: CheckedQmChannelOperation = {
  ...operation,
  authorization: {
    actorId: operation.actorId,
    capabilityId: operation.name,
    resourceRevision: "revision-1",
    checkedAt: "2026-09-12T08:00:00.000Z",
    decision: "allowed",
  },
};

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
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function photonServer(core: PhotonCoreClient): Promise<{ base: string; close: () => Promise<void> }> {
  const auth = createSourceAuth({ signingSecret: SECRET });
  const routes = createPhotonRoutes({ core });
  const server = createHttpServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://qm.local");
      const raw = await readRawBody(req);
      if (
        !(await verifyOrReject(
          req,
          res,
          SECRET,
          auth,
          canonicalPayload(method, `${url.pathname}${url.search}`, raw),
          method !== "GET",
        ))
      )
        return;
      const body: unknown = raw ? JSON.parse(raw) : {};
      const found = await dispatch(routes, {
        req,
        res,
        app: {} as ApiCtx["app"],
        deps: {} as ApiCtx["deps"],
        secret: SECRET,
        auth,
        allowUnsignedSourceAuth: false,
        url,
        pathname: url.pathname,
        method,
        params: {},
        body,
        capability: null,
        actor: null,
      });
      if (!found) sendJson(res, 404, { error: "not_found" });
    })().catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : "unknown" });
    });
  });
  return listen(server);
}

test("every Photon boundary route requires source authentication", () => {
  const routes = createPhotonRoutes({ core: {} as PhotonCoreClient });
  assert.ok(routes.length > 0);
  assert.ok(routes.every((route) => route.auth === "source"));
});

test("unsigned, forged, and replayed Photon mutations fail at the source boundary", async () => {
  let checks = 0;
  const core = {
    async check(_source: unknown, request: QmChannelOperationRequest) {
      checks += 1;
      return { ...request, authorization: checked.authorization } as CheckedQmChannelOperation;
    },
  } as PhotonCoreClient;
  const server = await photonServer(core);
  const path = "/v1/photon/channel/check";
  const body = JSON.stringify({ source, operation });
  try {
    assert.equal(
      (
        await fetch(`${server.base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${server.base}${path}`, {
          method: "POST",
          headers: signed("POST", path, body),
          body: body.replace("photon-human", "forged-human"),
        })
      ).status,
      401,
    );
    const headers = signed("POST", path, body);
    assert.equal((await fetch(`${server.base}${path}`, { method: "POST", headers, body })).status, 200);
    assert.equal((await fetch(`${server.base}${path}`, { method: "POST", headers, body })).status, 401);
    assert.equal(checks, 1);
  } finally {
    await server.close();
  }
});

test("valid source authentication does not confer linked-human authority", async () => {
  let turns = 0;
  const core = createPhotonCoreClient({
    authorization: {
      async check() {
        throw new PhotonAuthorizationError("human_unlinked");
      },
      async authorize() {
        throw new PhotonAuthorizationError("human_unlinked");
      },
    },
    deliveries: {
      async get() {
        return null;
      },
    },
    app: {
      async turn() {
        turns += 1;
        return { status: "silent" };
      },
    } as never,
  });
  const server = await photonServer(core);
  const path = "/v1/photon/channel/execute";
  const body = JSON.stringify({ source, operation: checked });
  try {
    const response = await fetch(`${server.base}${path}`, {
      method: "POST",
      headers: signed("POST", path, body),
      body,
    });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code?: string }).code, "human_unlinked");
    assert.equal(turns, 0);
  } finally {
    await server.close();
  }
});

test("valid source authentication does not confer portal identity", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "photon-portal-gate-")) }));
  const server = await listen(
    createServer(built.app, {
      signingSecret: SECRET,
      capabilitySecret: CAPABILITY_SECRET,
      portalIdentitySecret: PORTAL_SECRET,
      requireSignedPortalIdentity: true,
    }),
  );
  const path = "/v1/sessions?principalId=photon-human";
  try {
    assert.equal((await fetch(`${server.base}${path}`, { headers: signed("GET", path) })).status, 401);
  } finally {
    await server.close();
  }
});
