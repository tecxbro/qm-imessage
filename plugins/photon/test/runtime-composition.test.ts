import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { PhotonPresentationOperation } from "../../chassis/src/photon-contract.ts";
import type { PhotonStateStores } from "../../chassis/src/photon-state.ts";
import { createPhotonAdapterComposition } from "../src/composition.ts";
import { constructAdvanced, type AdvancedClient } from "../src/provider/compatibility.ts";
import type { ProviderLine } from "../src/provider/capabilities.ts";
import type {
  DeliveryDispatchClaim,
  PhotonLineOwnerClaim,
  RecoverableDeliveryOperationRecord,
  RecoverableDeliveryOperationStorePort,
} from "../src/ports.ts";

const line: ProviderLine = {
  reference: {
    provider: "advanced-imessage",
    installationId: "installation-runtime",
    projectId: "project-runtime",
    lineId: "line-runtime",
  },
  phone: "+15555550199",
  kind: "dedicated",
};

const operation: Extract<PhotonPresentationOperation, { name: "message.text" }> = {
  operationId: "operation-runtime",
  attemptId: "attempt-runtime",
  name: "message.text",
  conversation: { ...line.reference, conversationId: "conversation-runtime" },
  idempotencyKey: "logical-runtime",
  input: { text: "hello" },
};

function deliveryStore() {
  let record: RecoverableDeliveryOperationRecord | undefined;
  const calls: string[] = [];
  const store: RecoverableDeliveryOperationStorePort = {
    async reserve(input) {
      calls.push("reserve");
      if (record) return "duplicate";
      record = {
        operation: input,
        attempts: [{ operationId: input.operationId, attemptId: input.attemptId }],
        parts: [{ partId: "part-runtime", partIndex: 0, state: "reserved", dispatchFence: 0 }],
        state: "reserved",
        dispatchFence: 0,
        version: 1,
      };
      return "reserved";
    },
    async acquireDispatch(input, expectedVersion, ownerId, _now, leaseExpiresAt) {
      calls.push("acquire");
      if (record?.state !== "reserved" || record.version !== expectedVersion) return undefined;
      const dispatchClaim: DeliveryDispatchClaim = { ownerId, fence: 1, leaseExpiresAt };
      const { dispatchClaim: _dispatchClaim, ...completed } = record;
      record = {
        ...completed,
        operation: input,
        state: "dispatched",
        dispatchFence: 1,
        dispatchClaim,
        parts: [{ ...record.parts[0]!, state: "dispatched", dispatchFence: 1 }],
        version: 2,
      };
      return record;
    },
    async renewDispatch() {
      return undefined;
    },
    async expireDispatch() {
      return undefined;
    },
    async recordConfirmedPart() {
      return undefined;
    },
    async complete(input, claim, outcome) {
      calls.push("complete");
      if (record?.state !== "dispatched" || record.operation.operationId !== input.operationId) return false;
      if (
        record.dispatchClaim?.ownerId !== claim.ownerId ||
        record.dispatchClaim.fence !== claim.fence ||
        record.dispatchClaim.leaseExpiresAt !== claim.leaseExpiresAt
      )
        return false;
      record = {
        ...record,
        state:
          outcome.kind === "confirmed-message" || outcome.kind === "confirmed-no-message" ? "confirmed" : outcome.kind,
        outcome,
        version: 3,
      };
      return true;
    },
    async discoverRecoverable() {
      return { deliveries: [] };
    },
    async retry() {
      return undefined;
    },
    async reconcile() {
      return false;
    },
    async read() {
      return record;
    },
  };
  return { store, calls, read: () => record };
}

test("runtime composition resolves credentials, owns the line, and completes one durable dispatch", async () => {
  const delivery = deliveryStore();
  const released: PhotonLineOwnerClaim[] = [];
  const real = constructAdvanced({ address: "runtime-address", token: "runtime-token" });
  const sdk = {
    ...real,
    close: () => real.close(),
    chats: { get: real.chats.get },
    messages: { sendText: real.messages.sendText },
  } as AdvancedClient;
  mock.method(sdk.chats, "get", async () => ({ guid: operation.conversation.conversationId, isGroup: false }));
  mock.method(sdk.messages, "sendText", async () => ({
    guid: "provider-message-runtime",
    isFromMe: true,
    chatGuids: [operation.conversation.conversationId],
    partCount: 1,
  }));
  const stores = {
    deliveries: delivery.store,
    receipts: {},
    lineOwners: {
      async claim(
        key: { installationId: string; lineId: string },
        ownerId: string,
        _now: string,
        leaseExpiresAt: string,
      ) {
        return { key, ownerId, fence: 1, leaseExpiresAt };
      },
      async renew(claim: PhotonLineOwnerClaim) {
        return { ...claim, leaseExpiresAt: new Date(Date.parse(claim.leaseExpiresAt) + 30_000).toISOString() };
      },
      async release(claim: PhotonLineOwnerClaim) {
        released.push(claim);
        return true;
      },
    },
  } as unknown as PhotonStateStores;
  let now = Date.parse("2026-09-14T08:00:00.000Z");
  const composition = createPhotonAdapterComposition({
    stores,
    core: { coreUrl: "https://core.example.test", signingSecret: "source-signing-secret" },
    acquireCredential: async () => ({
      kind: "ready",
      credential: {
        provider: line.reference.provider,
        installationId: line.reference.installationId,
        projectId: line.reference.projectId!,
        lineId: line.reference.lineId,
        phone: line.phone,
        address: "runtime-address",
        token: "runtime-token",
        expiresAt: "2026-09-14T09:00:00.000Z",
      },
    }),
    trustedAddress: ({ address }) => address === "runtime-address",
    materialize: async () => new Uint8Array(),
    constructors: {
      advanced: () => sdk,
      spectrum: async () => {
        throw new Error("unexpected Spectrum construction");
      },
    },
    ownership: { leaseTtlMs: 60_000, renewAfterMs: 30_000 },
    now: () => now++,
    dispatchOwnerId: () => "delivery-owner-runtime",
  });
  const connected = await composition.connect(line);
  assert.equal(connected.kind, "ready");
  if (connected.kind !== "ready") return;
  await assert.rejects(
    connected.connection.start(async () => undefined),
    /PHOTON_INBOUND_UNAVAILABLE/u,
  );
  const outcome = await connected.connection.dispatch(operation);
  assert.equal(outcome.kind, "confirmed-message");
  assert.deepEqual(delivery.calls, ["reserve", "acquire", "complete"]);
  assert.equal(delivery.read()?.state, "confirmed");
  await connected.connection.stop();
  assert.equal(released.length, 1);
});

test("runtime composition fails closed before SDK construction when credentials are unavailable", async () => {
  let constructed = false;
  const composition = createPhotonAdapterComposition({
    stores: {
      lineOwners: {},
    } as unknown as PhotonStateStores,
    core: { coreUrl: "https://core.example.test", signingSecret: "source-signing-secret" },
    acquireCredential: async () => ({ kind: "unavailable", code: "PHOTON_CREDENTIAL_LINE_NOT_FOUND" }),
    trustedAddress: () => true,
    materialize: async () => new Uint8Array(),
    constructors: {
      advanced: () => {
        constructed = true;
        throw new Error("must not construct");
      },
      spectrum: async () => {
        constructed = true;
        throw new Error("must not construct");
      },
    },
    now: () => Date.parse("2026-09-14T08:00:00.000Z"),
  });
  const result = await composition.connect(line);
  assert.deepEqual(result, { kind: "unavailable", code: "PHOTON_CREDENTIAL_LINE_NOT_FOUND" });
  assert.equal(constructed, false);
});
