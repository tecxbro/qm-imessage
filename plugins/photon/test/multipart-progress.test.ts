import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { type AdvancedIMessage, type Chat, type Message as AdvancedMessage } from "@photon-ai/advanced-imessage/grpc";
import type { ContentInput, Message as SpectrumMessage } from "spectrum-ts";
import {
  parsePhotonOperationOutcome,
  type ConfirmedMessagePart,
  type MessagePartReference,
  type PhotonPresentationOperation,
  type PhotonPresentationOperationInput,
} from "../../chassis/src/photon-contract.ts";
import {
  createAdvancedProviderClient,
  createSpectrumProviderClient,
  withPhotonDeliveryRuntimeProgress,
  type PhotonDeliveryRuntimeProgress,
} from "../src/provider/clients.ts";
import { constructAdvanced, narrowSpectrum, type SpectrumSpace } from "../src/provider/compatibility.ts";
import { createConnectionManager } from "../src/provider/connection.ts";
import type { ProviderLineOwnership } from "../src/provider/line-owner.ts";
import type { ProviderLine } from "../src/provider/capabilities.ts";
import type { DeliveryDispatchClaim, PhotonDeliveryDispatch, PhotonDeliveryProgressPort } from "../src/ports.ts";
import { FakeEventReceiptStore } from "./fixtures.ts";

const timestamp = new Date("2026-09-12T12:00:00.000Z");
const phone = "+15550000001";
const chatGuid = "any;+;test-group";
const credentials = { address: "127.0.0.1:1", token: "offline-token" };

function testOwnership(): ProviderLineOwnership {
  return {
    async acquire(key) {
      let active = true;
      return {
        claim: {
          key: structuredClone(key),
          ownerId: "multipart-progress-owner",
          fence: 1,
          leaseExpiresAt: "2099-01-01T00:00:00.000Z",
        },
        assertActive() {
          if (!active) throw new Error("PROVIDER_LINE_OWNERSHIP_LOST");
        },
        async release() {
          if (!active) return false;
          active = false;
          return true;
        },
      };
    },
  };
}

interface ProgressHooks {
  assertCanContinue?(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    logicalPartIndex: number,
    now: string,
  ): void | Promise<void>;
  recordConfirmedPart?(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    logicalPartIndex: number,
    part: MessagePartReference,
    now: string,
  ): void | Promise<void>;
}

function line(provider: "advanced-imessage" | "spectrum-imessage"): ProviderLine {
  return {
    reference: { provider, installationId: randomUUID(), lineId: "line", projectId: "project" },
    phone,
    kind: "dedicated",
  };
}

function operation<Name extends PhotonPresentationOperation["name"]>(
  scope: ProviderLine,
  name: Name,
  input: PhotonPresentationOperationInput[Name],
  identifiers: { operationId?: string; attemptId?: string; idempotencyKey?: string } = {},
): Extract<PhotonPresentationOperation, { name: Name }> {
  return {
    operationId: identifiers.operationId ?? "operation",
    attemptId: identifiers.attemptId ?? "attempt",
    name,
    conversation: { ...scope.reference, conversationId: chatGuid },
    idempotencyKey: identifiers.idempotencyKey ?? "logical-key",
    input,
  } as Extract<PhotonPresentationOperation, { name: Name }>;
}

function dispatch<Operation extends PhotonPresentationOperation>(
  operationValue: Operation,
  logicalPartIndexes: readonly number[],
  confirmedParts: readonly ConfirmedMessagePart[],
  progress?: PhotonDeliveryRuntimeProgress,
): PhotonDeliveryDispatch<Operation> {
  const value: PhotonDeliveryDispatch<Operation> = {
    operation: operationValue,
    logicalPartIndexes,
    confirmedParts,
  };
  return progress ? withPhotonDeliveryRuntimeProgress(value, progress) : value;
}

function progressRecorder(
  hooks: ProgressHooks = {},
  times = [
    "2026-09-14T12:00:00.000Z",
    "2026-09-14T12:00:01.000Z",
    "2026-09-14T12:00:02.000Z",
    "2026-09-14T12:00:03.000Z",
  ],
) {
  const claim: DeliveryDispatchClaim = {
    ownerId: "dispatch-owner",
    fence: 7,
    leaseExpiresAt: "2026-09-14T12:01:00.000Z",
  };
  const assertCalls: Parameters<PhotonDeliveryProgressPort["assertCanContinue"]>[] = [];
  const recordCalls: Parameters<PhotonDeliveryProgressPort["recordConfirmedPart"]>[] = [];
  const persisted: ConfirmedMessagePart[] = [];
  let timeIndex = 0;
  const port: PhotonDeliveryProgressPort = {
    async assertCanContinue(operation, receivedClaim, logicalPartIndex, now) {
      assertCalls.push([operation, receivedClaim, logicalPartIndex, now]);
      await hooks.assertCanContinue?.(operation, receivedClaim, logicalPartIndex, now);
    },
    async recordConfirmedPart(operation, receivedClaim, logicalPartIndex, part, now) {
      recordCalls.push([operation, receivedClaim, logicalPartIndex, part, now]);
      await hooks.recordConfirmedPart?.(operation, receivedClaim, logicalPartIndex, part, now);
      persisted.push({ logicalPartIndex, part: structuredClone(part) });
    },
  };
  const progress: PhotonDeliveryRuntimeProgress = {
    port,
    claim,
    now() {
      const value = times[timeIndex++];
      if (!value) throw new Error("missing canonical test time");
      return value;
    },
  };
  return { progress, claim, assertCalls, recordCalls, persisted };
}

function advancedMessage(overrides: Partial<AdvancedMessage> = {}): AdvancedMessage {
  return {
    guid: "message",
    chatGuids: [chatGuid],
    content: { text: "hello", attachments: [], formatting: [], mentions: [] },
    dateCreated: timestamp,
    sender: { address: "+15550000002", service: "iMessage" },
    appliedReactions: [],
    placedStickers: [],
    dataDetectorResultsPresent: false,
    didNotifyRecipient: false,
    isArchived: false,
    isAudioMessage: false,
    isAutoReply: false,
    isCorrupt: false,
    isDelayed: false,
    isDelivered: false,
    isDeliveredQuietly: false,
    isExpirable: false,
    isForward: false,
    isFromMe: false,
    isSent: false,
    isServiceMessage: false,
    isSpam: false,
    isSystemMessage: false,
    itemType: "normal",
    sendErrorCode: 0,
    ...overrides,
  };
}

function advancedChat(): Chat {
  return {
    guid: chatGuid,
    displayName: "Team",
    isArchived: false,
    isFiltered: false,
    isGroup: true,
    participants: [{ address: "+15550000002", service: "iMessage" }],
    service: "iMessage",
  };
}

function spectrumMessage(space: SpectrumSpace, overrides: Partial<SpectrumMessage> = {}): SpectrumMessage {
  return {
    id: "spectrum-message",
    platform: "imessage",
    direction: "inbound",
    space,
    timestamp,
    sender: { __platform: "imessage", id: "human" },
    content: { type: "text", text: "hello" },
    edit: async () => undefined,
    unsend: async () => undefined,
    read: async () => undefined,
    react: async () => undefined,
    reply: space.send.bind(space),
    ...overrides,
  };
}

function advancedResources<T extends object>(source: T, names: (keyof T)[]): T {
  return Object.fromEntries(names.map((name) => [name, Reflect.get(source, name)])) as T;
}

async function advancedHarness(scope = line("advanced-imessage")) {
  const real = constructAdvanced(credentials);
  const sdk: AdvancedIMessage = {
    ...real,
    close: () => real.close(),
    [Symbol.asyncDispose]: () => real.close(),
    chats: advancedResources(real.chats, ["get", "create", "setTyping", "markRead", "subscribeEvents"]),
    messages: advancedResources(real.messages, [
      "get",
      "sendText",
      "sendMultipart",
      "sendAttachment",
      "sendCustomizedMiniApp",
      "updateCustomizedMiniApp",
      "edit",
      "unsend",
      "setReaction",
      "subscribeEvents",
    ]),
    polls: advancedResources(real.polls, ["get", "create", "vote", "unvote", "addOption", "subscribeEvents"]),
    groups: advancedResources(real.groups, [
      "setDisplayName",
      "addParticipants",
      "removeParticipants",
      "leave",
      "setIcon",
      "removeIcon",
      "subscribeEvents",
    ]),
    events: advancedResources(real.events, ["catchUp"]),
  };
  mock.method(sdk.chats, "get", async () => advancedChat());
  mock.method(sdk.messages, "get", async (guid: string) => advancedMessage({ guid, isFromMe: true }));
  const manager = createConnectionManager(
    {
      advanced: () => sdk,
      spectrum: async () => {
        throw new Error("unexpected-spectrum");
      },
    },
    testOwnership(),
  );
  const connection = await manager.replace(scope, credentials);
  if (connection.kind !== "advanced") throw new Error("wrong-provider");
  return {
    scope,
    manager,
    connection,
    sdk,
    client: createAdvancedProviderClient(connection, async () => new Uint8Array([1, 2, 3])),
  };
}

async function spectrumHarness(scope = line("spectrum-imessage")) {
  const manager = createConnectionManager(undefined, testOwnership());
  const connection = await manager.replace(scope, credentials);
  if (connection.kind !== "spectrum") throw new Error("wrong-provider");
  const sdk = narrowSpectrum(connection.sdk);
  const space = await sdk.space.get(chatGuid, { phone });
  const spaceGet = mock.method(sdk.space, "get", async () => space);
  return {
    scope,
    manager,
    connection,
    sdk,
    space,
    spaceGet,
    client: createSpectrumProviderClient(
      connection,
      new FakeEventReceiptStore(),
      async () => new Uint8Array([1, 2, 3]),
    ),
  };
}

function multipart(scope: ProviderLine, first = "A", second = "B", identifiers = {}) {
  return operation(
    scope,
    "message.multipart",
    {
      parts: [
        { kind: "text", text: first },
        { kind: "text", text: second },
      ],
    },
    identifiers,
  );
}

test("Spectrum multipart with multiple unresolved parts requires durable progress before provider side effects", async () => {
  const h = await spectrumHarness();
  try {
    const send = mock.method(h.space, "send", async () => {
      throw new Error("must-not-send");
    });
    const outcome = await h.client.deliver(dispatch(multipart(h.scope), [0, 1], []));
    assert.ok(outcome.kind === "unsupported");
    assert.equal(outcome.reason, "durable-multipart-progress-unavailable");
    assert.equal(h.spaceGet.mock.callCount(), 0);
    assert.equal(send.mock.callCount(), 0);
  } finally {
    await h.manager.stop();
  }
});

test("Spectrum multipart waits for durable confirmation before starting the next send", { timeout: 2000 }, async () => {
  const h = await spectrumHarness();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  let confirmCount = 0;
  const recorder = progressRecorder({
    assertCanContinue(_operation, _claim, logicalPartIndex) {
      events.push(`before:${logicalPartIndex}`);
    },
    async recordConfirmedPart(_operation, _claim, logicalPartIndex) {
      events.push(`confirm:${logicalPartIndex}`);
      if (confirmCount++ === 0) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  let sendIndex = 0;
  const send = mock.method(h.space, "send", async (_input: ContentInput) => {
    const index = sendIndex++;
    events.push(`send:${index}`);
    return spectrumMessage(h.space, { id: `accepted-${index}`, direction: "outbound" });
  });
  try {
    const op = multipart(h.scope, "A", "B", { operationId: "operation-1", attemptId: "attempt-1" });
    const runtimeDispatch = dispatch(op, [0, 1], [], recorder.progress);
    assert.deepEqual(JSON.parse(JSON.stringify(runtimeDispatch)), {
      operation: op,
      logicalPartIndexes: [0, 1],
      confirmedParts: [],
    });
    const pending = h.client.deliver(runtimeDispatch);
    await entered.promise;
    assert.equal(send.mock.callCount(), 1);
    assert.deepEqual(events, ["before:0", "send:0", "confirm:0"]);
    release.resolve();
    const outcome = await pending;
    assert.ok(outcome.kind === "confirmed-message");
    assert.equal(send.mock.callCount(), 2);
    assert.deepEqual(events, ["before:0", "send:0", "confirm:0", "before:1", "send:1", "confirm:1"]);
    assert.deepEqual(
      recorder.assertCalls.map((call) => call[2]),
      [0, 1],
    );
    assert.deepEqual(
      recorder.assertCalls.map((call) => call[3]),
      ["2026-09-14T12:00:00.000Z", "2026-09-14T12:00:02.000Z"],
    );
    assert.deepEqual(
      recorder.recordCalls.map((call) => call[4]),
      ["2026-09-14T12:00:01.000Z", "2026-09-14T12:00:03.000Z"],
    );
    for (const call of [...recorder.assertCalls, ...recorder.recordCalls]) {
      assert.strictEqual(call[0], op);
      assert.strictEqual(call[1], recorder.claim);
      assert.equal(call[0].attemptId, "attempt-1");
    }
    assert.deepEqual(
      recorder.persisted.map((part) => part.logicalPartIndex),
      [0, 1],
    );
    assert.equal(JSON.stringify(outcome).includes("dispatch-owner"), false);
    parsePhotonOperationOutcome(outcome);
  } finally {
    release.resolve();
    await h.manager.stop();
  }
});

test("Spectrum durable confirmation rejection returns ambiguous evidence without a later send", async () => {
  const h = await spectrumHarness();
  try {
    const recorder = progressRecorder({
      async recordConfirmedPart() {
        throw new Error("durable-receipt-rejected");
      },
    });
    const send = mock.method(h.space, "send", async () =>
      spectrumMessage(h.space, { id: "accepted-first", direction: "outbound" }),
    );
    const outcome = await h.client.deliver(dispatch(multipart(h.scope), [0, 1], [], recorder.progress));
    assert.ok(outcome.kind === "ambiguous");
    assert.equal(send.mock.callCount(), 1);
    assert.equal(outcome.confirmedParts.length, 1);
    assert.equal(outcome.confirmedParts[0]?.logicalPartIndex, 0);
    assert.equal(outcome.confirmedParts[0]?.part.messageId, "accepted-first");
    assert.deepEqual(
      recorder.assertCalls.map((call) => call[2]),
      [0],
    );
    assert.deepEqual(
      recorder.recordCalls.map((call) => call[2]),
      [0],
    );
    assert.equal(recorder.persisted.length, 0);
    parsePhotonOperationOutcome(outcome);
  } finally {
    await h.manager.stop();
  }
});

test("Spectrum authority loss before a later part prevents that provider write", async () => {
  const h = await spectrumHarness();
  try {
    const recorder = progressRecorder({
      async assertCanContinue(_operation, _claim, logicalPartIndex) {
        if (logicalPartIndex === 1) throw new Error("stale-dispatch-fence");
      },
    });
    let sendIndex = 0;
    const send = mock.method(h.space, "send", async () => {
      const index = sendIndex++;
      return spectrumMessage(h.space, { id: `accepted-${index}`, direction: "outbound" });
    });
    const outcome = await h.client.deliver(dispatch(multipart(h.scope), [0, 1], [], recorder.progress));
    assert.ok(outcome.kind === "ambiguous");
    assert.equal(send.mock.callCount(), 1);
    assert.deepEqual(
      recorder.assertCalls.map((call) => call[2]),
      [0, 1],
    );
    assert.deepEqual(
      recorder.persisted.map((part) => part.logicalPartIndex),
      [0],
    );
    assert.deepEqual(
      outcome.confirmedParts.map((part) => part.logicalPartIndex),
      [0],
    );
    parsePhotonOperationOutcome(outcome);
  } finally {
    await h.manager.stop();
  }
});

test("Spectrum restart resumes unresolved parts while retaining the prior durable receipt", async () => {
  const scope = line("spectrum-imessage");
  const first = await spectrumHarness(scope);
  try {
    const firstProgress = progressRecorder({
      async assertCanContinue(_operation, _claim, logicalPartIndex) {
        if (logicalPartIndex === 1) throw new Error("dispatch-owner-replaced");
      },
    });
    const firstSend = mock.method(first.space, "send", async () =>
      spectrumMessage(first.space, { id: "accepted-first", direction: "outbound" }),
    );
    const firstOutcome = await first.client.deliver(dispatch(multipart(scope), [0, 1], [], firstProgress.progress));
    assert.ok(firstOutcome.kind === "ambiguous");
    assert.equal(firstSend.mock.callCount(), 1);
    assert.deepEqual(
      firstProgress.recordCalls.map((call) => call[2]),
      [0],
    );
    assert.deepEqual(
      firstProgress.persisted.map((part) => part.logicalPartIndex),
      [0],
    );
    const prior = firstOutcome.confirmedParts[0];
    assert.ok(prior);
    await first.manager.stop();

    const restarted = await spectrumHarness(scope);
    try {
      let sentText: string | undefined;
      const secondSend = mock.method(restarted.space, "send", async (input: ContentInput) => {
        const built = typeof input === "string" ? { type: "text" as const, text: input } : await input.build();
        if (built.type === "text") sentText = built.text;
        return spectrumMessage(restarted.space, { id: "accepted-second", direction: "outbound" });
      });
      const secondProgress = progressRecorder();
      const retry = multipart(scope, "A", "B", { operationId: "restart-operation", attemptId: "restart-attempt" });
      const outcome = await restarted.client.deliver(dispatch(retry, [1], [prior], secondProgress.progress));
      assert.ok(outcome.kind === "confirmed-message");
      assert.equal(secondSend.mock.callCount(), 1);
      assert.equal(sentText, "B");
      assert.deepEqual(secondProgress.assertCalls, []);
      assert.deepEqual(secondProgress.recordCalls, []);
      assert.deepEqual(
        outcome.confirmedParts.map((part) => part.logicalPartIndex),
        [0, 1],
      );
      assert.deepEqual(outcome.confirmedParts[0], prior);
      parsePhotonOperationOutcome(outcome);
    } finally {
      await restarted.manager.stop();
    }
  } finally {
    await first.manager.stop();
  }
});

test("Advanced multipart keeps one atomic provider write without sequential progress callbacks", async () => {
  const h = await advancedHarness();
  try {
    const events: string[] = [];
    const recorder = progressRecorder();
    const send = mock.method(h.sdk.messages, "sendMultipart", async () => {
      events.push("provider");
      return advancedMessage({ guid: "atomic-message", isFromMe: true, partCount: 2 });
    });
    const op = multipart(h.scope);
    const outcome = await h.client.sendMultipart(dispatch(op, [0, 1], [], recorder.progress));
    assert.ok(outcome.kind === "confirmed-message");
    assert.equal(send.mock.callCount(), 1);
    assert.deepEqual(send.mock.calls[0]?.arguments[1], [
      { text: "A", bubbleIndex: 0 },
      { text: "B", bubbleIndex: 1 },
    ]);
    assert.deepEqual(events, ["provider"]);
    assert.deepEqual(recorder.assertCalls, []);
    assert.deepEqual(recorder.recordCalls, []);
    assert.deepEqual(recorder.persisted, []);
    assert.deepEqual(
      outcome.confirmedParts.map((part) => part.logicalPartIndex),
      [0, 1],
    );
    parsePhotonOperationOutcome(outcome);
  } finally {
    await h.manager.stop();
  }
});
