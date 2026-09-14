import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { type AdvancedIMessage, type Chat, type Message as AdvancedMessage } from "@photon-ai/advanced-imessage/grpc";
import type { ContentInput, Message as SpectrumMessage } from "spectrum-ts";
import {
  parsePhotonOperationOutcome,
  type ConfirmedMessagePart,
  type PhotonPresentationOperation,
  type PhotonPresentationOperationInput,
} from "../../chassis/src/photon-contract.ts";
import { createAdvancedProviderClient, createSpectrumProviderClient } from "../src/provider/clients.ts";
import { constructAdvanced, narrowSpectrum, type SpectrumSpace } from "../src/provider/compatibility.ts";
import { createConnectionManager } from "../src/provider/connection.ts";
import type { ProviderLine } from "../src/provider/capabilities.ts";
import type { PhotonDeliveryDispatch } from "../src/ports.ts";
import { FakeEventReceiptStore } from "./fixtures.ts";

const timestamp = new Date("2026-09-12T12:00:00.000Z");
const phone = "+15550000001";
const chatGuid = "any;+;test-group";
const credentials = { address: "127.0.0.1:1", token: "offline-token" };

interface RepairProgress {
  beforeSend(logicalPartIndexes: readonly number[]): Promise<void>;
  confirm(part: ConfirmedMessagePart): Promise<void>;
}

type RepairDispatch<Operation extends PhotonPresentationOperation = PhotonPresentationOperation> =
  PhotonDeliveryDispatch<Operation> & { progress?: RepairProgress };

interface ProgressHooks {
  beforeSend?(logicalPartIndexes: readonly number[]): void | Promise<void>;
  confirm?(part: ConfirmedMessagePart): void | Promise<void>;
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
  progress?: RepairProgress,
): RepairDispatch<Operation> {
  return {
    operation: operationValue,
    logicalPartIndexes,
    confirmedParts,
    ...(progress ? { progress } : {}),
  };
}

function progressRecorder(hooks: ProgressHooks = {}) {
  const beforeCalls: number[][] = [];
  const confirmCalls: ConfirmedMessagePart[] = [];
  const persisted: ConfirmedMessagePart[] = [];
  const progress: RepairProgress = {
    async beforeSend(logicalPartIndexes) {
      const copy = [...logicalPartIndexes];
      beforeCalls.push(copy);
      await hooks.beforeSend?.(copy);
    },
    async confirm(part) {
      confirmCalls.push(part);
      await hooks.confirm?.(part);
      persisted.push(structuredClone(part));
    },
  };
  return { progress, beforeCalls, confirmCalls, persisted };
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
  const manager = createConnectionManager({
    advanced: () => sdk,
    spectrum: async () => {
      throw new Error("unexpected-spectrum");
    },
  });
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
  const manager = createConnectionManager();
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

test("Spectrum multipart requires durable progress before provider side effects", async () => {
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
    beforeSend(indexes) {
      events.push(`before:${indexes.join(",")}`);
    },
    async confirm(part) {
      events.push(`confirm:${part.logicalPartIndex}`);
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
    const pending = h.client.deliver(dispatch(multipart(h.scope), [0, 1], [], recorder.progress));
    await entered.promise;
    assert.equal(send.mock.callCount(), 1);
    assert.deepEqual(events, ["before:0", "send:0", "confirm:0"]);
    release.resolve();
    const outcome = await pending;
    assert.ok(outcome.kind === "confirmed-message");
    assert.equal(send.mock.callCount(), 2);
    assert.deepEqual(events, ["before:0", "send:0", "confirm:0", "before:1", "send:1", "confirm:1"]);
    assert.deepEqual(recorder.beforeCalls, [[0], [1]]);
    assert.deepEqual(
      recorder.persisted.map((part) => part.logicalPartIndex),
      [0, 1],
    );
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
      async confirm() {
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
    assert.deepEqual(recorder.beforeCalls, [[0]]);
    assert.deepEqual(
      recorder.confirmCalls.map((part) => part.logicalPartIndex),
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
      async beforeSend(indexes) {
        if (indexes[0] === 1) throw new Error("stale-dispatch-fence");
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
    assert.deepEqual(recorder.beforeCalls, [[0], [1]]);
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
      async beforeSend(indexes) {
        if (indexes[0] === 1) throw new Error("dispatch-owner-replaced");
      },
    });
    const firstSend = mock.method(first.space, "send", async () =>
      spectrumMessage(first.space, { id: "accepted-first", direction: "outbound" }),
    );
    const firstOutcome = await first.client.deliver(dispatch(multipart(scope), [0, 1], [], firstProgress.progress));
    assert.ok(firstOutcome.kind === "ambiguous");
    assert.equal(firstSend.mock.callCount(), 1);
    assert.deepEqual(
      firstProgress.confirmCalls.map((part) => part.logicalPartIndex),
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
      assert.deepEqual(secondProgress.beforeCalls, [[1]]);
      assert.deepEqual(
        secondProgress.confirmCalls.map((part) => part.logicalPartIndex),
        [1],
      );
      assert.deepEqual(
        secondProgress.persisted.map((part) => part.logicalPartIndex),
        [1],
      );
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

test("Advanced multipart keeps one atomic provider write and checkpoints each returned part", async () => {
  const h = await advancedHarness();
  try {
    const events: string[] = [];
    const recorder = progressRecorder({
      beforeSend(indexes) {
        events.push(`before:${indexes.join(",")}`);
      },
      confirm(part) {
        events.push(`confirm:${part.logicalPartIndex}`);
      },
    });
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
    assert.deepEqual(events, ["before:0,1", "provider", "confirm:0", "confirm:1"]);
    assert.deepEqual(recorder.beforeCalls, [[0, 1]]);
    assert.deepEqual(
      recorder.persisted.map((part) => part.logicalPartIndex),
      [0, 1],
    );
    assert.deepEqual(
      outcome.confirmedParts.map((part) => part.logicalPartIndex),
      [0, 1],
    );
    parsePhotonOperationOutcome(outcome);
  } finally {
    await h.manager.stop();
  }
});
