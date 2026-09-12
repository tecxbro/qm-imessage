import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import {
  ConnectionError,
  TypedEventStream,
  type AdvancedIMessage,
  type CatchUpEvent,
  type Chat,
  type LiveEvent,
  type Message,
  type MessageEvent,
  type Poll,
} from "@photon-ai/advanced-imessage/grpc";
import type { Content, ContentInput, Message as SpectrumMessage } from "spectrum-ts";
import {
  parseNormalizedPhotonInput,
  parsePhotonOperationOutcome,
  type PhotonPresentationOperation,
  type PhotonPresentationOperationInput,
} from "../../chassis/src/photon-contract.ts";
import {
  createAdvancedProviderClient,
  createSpectrumProviderClient,
  observeAdvancedMessage,
} from "../src/provider/clients.ts";
import { constructAdvanced, narrowSpectrum, type SpectrumSpace } from "../src/provider/compatibility.ts";
import { createConnectionManager } from "../src/provider/connection.ts";
import { operationRestriction, type ProviderLine } from "../src/provider/capabilities.ts";
import { eventKey, startProviderIntake } from "../src/provider/recovery.ts";
import { normalizeAdvancedEvent, normalizeSpectrumMessage } from "../src/provider/subscriptions.ts";
import { FakeEventReceiptStore } from "./fixtures.ts";

const timestamp = new Date("2026-09-12T12:00:00.000Z");
const phone = "+15550000001";
const chatGuid = "any;+;test-group";
const credentials = { address: "127.0.0.1:1", token: "offline-token" };

function line(): ProviderLine {
  return {
    reference: { provider: "advanced-imessage", installationId: randomUUID(), lineId: "line", projectId: "project" },
    phone,
    kind: "dedicated",
  };
}

function message(overrides: Partial<Message> = {}): Message {
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

function chat(): Chat {
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

function poll(): Poll {
  return {
    chatGuid,
    pollMessageGuid: "poll",
    title: "Lunch",
    options: [
      { optionIdentifier: "id-a", text: "Same" },
      { optionIdentifier: "id-b", text: "Same", creatorHandle: "creator" },
    ],
    votes: [{ optionIdentifier: "id-b", participant: { address: "voter", service: "iMessage" } }],
  };
}

function operation<Name extends PhotonPresentationOperation["name"]>(
  scope: ProviderLine,
  name: Name,
  input: PhotonPresentationOperationInput[Name],
): Extract<PhotonPresentationOperation, { name: Name }> {
  return {
    operationId: "operation",
    attemptId: "attempt",
    name,
    conversation: { ...scope.reference, conversationId: chatGuid },
    idempotencyKey: "logical-key",
    input,
  } as Extract<PhotonPresentationOperation, { name: Name }>;
}

function event(
  sequence: number,
  overrides: Partial<Extract<MessageEvent, { type: "message.received" }>> = {},
): Extract<MessageEvent, { type: "message.received" }> {
  return {
    type: "message.received",
    sequence,
    chatGuid,
    occurredAt: timestamp,
    isFromMe: false,
    actor: { address: "+15550000002", service: "iMessage" },
    message: message({ guid: `message-${sequence}` }),
    ...overrides,
  };
}

function stream<T>() {
  const queued: T[] = [];
  let changed = Promise.withResolvers<void>();
  let ended = false;
  const source = {
    async *[Symbol.asyncIterator]() {
      while (!ended) {
        const value = queued.shift();
        if (value !== undefined) yield value;
        else await changed.promise;
      }
    },
  };
  const close = async () => {
    ended = true;
    changed.resolve();
  };
  return {
    stream: new TypedEventStream(source, close),
    push(value: T) {
      queued.push(value);
      const previous = changed;
      changed = Promise.withResolvers<void>();
      previous.resolve();
    },
    close,
  };
}

async function harness(scope = line()) {
  const real = constructAdvanced(credentials);
  function resource<T extends object>(source: T, names: (keyof T)[]): T {
    return Object.fromEntries(names.map((name) => [name, Reflect.get(source, name)])) as T;
  }
  const sdk: AdvancedIMessage = {
    ...real,
    close: () => real.close(),
    [Symbol.asyncDispose]: () => real.close(),
    chats: resource(real.chats, ["get", "create", "setTyping", "markRead", "subscribeEvents"]),
    messages: resource(real.messages, [
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
    polls: resource(real.polls, ["get", "create", "vote", "unvote", "addOption", "subscribeEvents"]),
    groups: resource(real.groups, [
      "setDisplayName",
      "addParticipants",
      "removeParticipants",
      "leave",
      "setIcon",
      "removeIcon",
      "subscribeEvents",
    ]),
    events: resource(real.events, ["catchUp"]),
  };
  mock.method(sdk.chats, "get", async () => chat());
  mock.method(sdk.messages, "get", async (guid: string) => message({ guid, isFromMe: true }));
  mock.method(sdk.polls, "get", async () => poll());
  const manager = createConnectionManager({
    advanced: () => sdk,
    spectrum: async () => {
      throw new Error("unexpected-spectrum");
    },
  });
  const connection = await manager.replace(scope, credentials);
  assert.equal(connection.kind, "advanced");
  if (connection.kind !== "advanced") throw new Error("wrong-provider");
  const client = createAdvancedProviderClient(connection, async () => new Uint8Array([1, 2, 3]));
  return { sdk, manager, connection, client, scope };
}

function installStreams(sdk: AdvancedIMessage) {
  const messages = stream<MessageEvent>();
  const chats = stream<Extract<LiveEvent, { type: `chat.${string}` }>>();
  const groups = stream<Extract<LiveEvent, { type: "group.changed" }>>();
  const polls = stream<Extract<LiveEvent, { type: "poll.changed" }>>();
  const catchup = stream<CatchUpEvent>();
  mock.method(sdk.messages, "subscribeEvents", () => messages.stream);
  mock.method(sdk.chats, "subscribeEvents", () => chats.stream);
  mock.method(sdk.groups, "subscribeEvents", () => groups.stream);
  mock.method(sdk.polls, "subscribeEvents", () => polls.stream);
  const catchUp = mock.method(sdk.events, "catchUp", () => catchup.stream);
  return { messages, chats, groups, polls, catchup, catchUp };
}

test("normalizes native event families with exact non-message fields and stable event identities", () => {
  const scope = line();
  const base = {
    sequence: 10,
    chatGuid,
    occurredAt: timestamp,
    isFromMe: false,
    actor: { address: "actor", service: "iMessage" as const },
  };
  const examples: LiveEvent[] = [
    event(1),
    {
      ...base,
      type: "message.edited",
      messageGuid: "target",
      editedAt: timestamp,
      content: {
        text: "edit",
        attachments: [],
        formatting: [{ type: "bold", start: 0, length: 4 }],
        mentions: [{ address: "who", start: 0, length: 4 }],
        miniApp: { extensionBundleId: "app", teamId: "TEAM", live: true, sessionId: "session" },
      },
    },
    { ...base, type: "message.unsent", messageGuid: "target", retractedAt: timestamp },
    { ...base, type: "message.read", messageGuid: "target", readAt: timestamp },
    {
      ...base,
      type: "message.reactionRemoved",
      messageGuid: "target",
      targetPartIndex: 2,
      reaction: { kind: "emoji", emoji: "🌈" },
    },
    { ...base, type: "chat.markedRead" },
    { ...base, type: "group.changed", change: { type: "displayNameChanged", displayName: "Actual name" } },
    {
      ...base,
      type: "group.changed",
      change: { type: "participantLeft", participant: { address: "leaver", service: "SMS" } },
    },
    { ...base, type: "group.changed", change: { type: "iconRemoved" } },
    {
      ...base,
      type: "poll.changed",
      pollMessageGuid: "poll",
      delta: { type: "optionAdded", title: "Actual title", options: poll().options },
    },
    { ...base, type: "poll.changed", pollMessageGuid: "poll", delta: { type: "unvoted", optionIdentifier: "id-b" } },
    { ...base, type: "chat.archived" },
  ];
  for (const input of examples) {
    const normalized = normalizeAdvancedEvent(input, scope);
    assert.deepEqual(parseNormalizedPhotonInput(normalized), normalized);
    assert.equal(normalized.event.eventId, String(input.sequence));
    assert.deepEqual(normalizeAdvancedEvent(input, scope), normalized);
    assert.equal(normalized.kind === "message", input.type === "message.received");
  }
  const normalized = normalizeAdvancedEvent(examples[9]!, scope);
  assert.ok(normalized.kind === "poll" && normalized.action === "option-added");
  assert.equal(normalized.options[1]?.optionIdentifier, "id-b");
  assert.equal(normalized.options[1]?.creatorId, "creator");
});

test("preserves attachment order, reply identity, and rejects invented human messages", () => {
  const scope = line();
  const attachment = {
    guid: "file",
    fileName: "a.png",
    mimeType: "image/png",
    totalBytes: 3,
    isHidden: false,
    isOutgoing: false,
    isSticker: false,
    transferState: "finished" as const,
    uti: "public.png",
  };
  const input = event(1, {
    message: message({
      content: { text: "before\uFFFCafter", attachments: [attachment], formatting: [], mentions: [] },
      partCount: 3,
      replyTargetGuid: "reply",
      threadOriginatorPart: "2",
    }),
  });
  const normalized = normalizeAdvancedEvent(input, scope);
  assert.equal(normalized.kind, "message");
  if (normalized.kind !== "message") throw new Error("wrong-event");
  assert.deepEqual(
    normalized.content.map((part) => part.kind),
    ["text", "attachment", "text"],
  );
  assert.equal(normalized.replyTo?.partIndex, 2);
  parseNormalizedPhotonInput(normalized);
  for (const overrides of [
    { isFromMe: true },
    { isSystemMessage: true },
    { chatGuids: ["foreign"] },
    { threadOriginatorPart: "p:2/unknown" },
  ])
    assert.equal(normalizeAdvancedEvent(event(1, { message: message(overrides) }), scope).kind, "unknown");
  assert.throws(() => normalizeAdvancedEvent(event(Number.MAX_SAFE_INTEGER + 1), scope), /UNREPRESENTABLE/u);
});

test("Advanced writes keep declared options and undefined remains ambiguous", async () => {
  const h = await harness();
  try {
    const write = mock.method(h.sdk.messages, "sendText", async () => message({ isFromMe: true }));
    const op = operation(h.scope, "message.text", { text: "hello", enableLinkPreview: true });
    const first = await h.client.sendText(op);
    assert.equal(first.kind, "confirmed-message");
    parsePhotonOperationOutcome(first);
    const second = await h.client.sendText({ ...op, operationId: "next-attempt", attemptId: "two" });
    assert.equal(second.kind, "confirmed-message");
    assert.equal(
      write.mock.calls[0]?.arguments[2]?.clientMessageId,
      write.mock.calls[1]?.arguments[2]?.clientMessageId,
    );
    mock.method(h.sdk.messages, "sendText", async () => undefined);
    assert.equal((await h.client.sendText(op)).kind, "ambiguous");
    mock.method(h.sdk.messages, "sendText", async () => {
      throw new ConnectionError("timeout", { code: "timeout", grpcCode: 4, retryable: true });
    });
    assert.equal((await h.client.sendText(op)).kind, "ambiguous");
  } finally {
    await h.manager.stop();
  }
});

test("unsupported operations and foreign lines cannot invoke writes", async () => {
  const h = await harness();
  try {
    const write = mock.method(h.sdk.messages, "sendText", async () => {
      throw new Error("must-not-send");
    });
    assert.equal(
      (
        await h.client.sendText(
          operation({ ...h.scope, reference: { ...h.scope.reference, lineId: "foreign" } }, "message.text", {
            text: "hello",
          }),
        )
      ).kind,
      "unsupported",
    );
    assert.equal(
      (await h.client.sendMarkdown(operation(h.scope, "message.markdown", { markdown: "**hello**" }))).kind,
      "unsupported",
    );
    assert.equal(write.mock.callCount(), 0);
    const rename = mock.method(h.sdk.groups, "setDisplayName", async () => chat());
    const shared = { ...h.scope, kind: "shared" as const };
    assert.equal(
      operationRestriction(shared, operation(shared, "conversation.rename", { title: "group" })),
      "dedicated-line-required",
    );
    assert.equal(rename.mock.callCount(), 0);
  } finally {
    await h.manager.stop();
  }
});

test("poll mutations and Chat receipts keep exact native identifiers", async () => {
  const h = await harness();
  try {
    mock.method(h.sdk.polls, "create", async () => poll());
    mock.method(h.sdk.polls, "vote", async () => poll());
    mock.method(h.sdk.groups, "setDisplayName", async () => chat());
    const created = await h.client.createPoll(
      operation(h.scope, "message.poll.create", { title: "Lunch", options: ["Same", "Same"] }),
    );
    assert.ok(created.kind === "confirmed-message");
    assert.deepEqual(created.providerReceipt, {
      receiptType: "poll",
      pollMessageGuid: "poll",
      optionIdentifiers: ["id-a", "id-b"],
    });
    const voted = await h.client.votePoll(
      operation(h.scope, "message.poll.vote", { pollMessageGuid: "poll", optionIdentifier: "id-b" }),
    );
    assert.equal(voted.kind, "confirmed-no-message");
    parsePhotonOperationOutcome(voted);
    assert.deepEqual(await h.client.getPoll({ ...h.scope.reference, conversationId: chatGuid }, "poll"), poll());
    const renamed = await h.client.renameConversation(operation(h.scope, "conversation.rename", { title: "Team" }));
    assert.ok(renamed.kind === "confirmed-no-message" && renamed.providerReceipt.receiptType === "chat");
    mock.method(h.sdk.polls, "get", async () => ({ ...poll(), chatGuid: "foreign" }));
    const vote = mock.method(h.sdk.polls, "vote", async () => poll());
    assert.equal(
      (
        await h.client.votePoll(
          operation(h.scope, "message.poll.vote", { pollMessageGuid: "poll", optionIdentifier: "id-b" }),
        )
      ).kind,
      "ambiguous",
    );
    assert.equal(vote.mock.callCount(), 0);
  } finally {
    await h.manager.stop();
  }
});

test("multipart retries preserve prior parts and never resend resolved indexes", async () => {
  const h = await harness();
  try {
    const send = mock.method(h.sdk.messages, "sendMultipart", async () =>
      message({ guid: "remaining", isFromMe: true, partCount: 1 }),
    );
    const op = operation(h.scope, "message.multipart", {
      parts: [
        { kind: "text", text: "first" },
        { kind: "text", text: "second" },
      ],
    });
    const prior = { logicalPartIndex: 0, part: { ...op.conversation, messageId: "already-sent", partIndex: 0 } };
    const outcome = await h.client.sendMultipart({ operation: op, logicalPartIndexes: [1], confirmedParts: [prior] });
    assert.ok(outcome.kind === "confirmed-message");
    assert.deepEqual(outcome.confirmedParts[0], prior);
    assert.deepEqual(send.mock.calls[0]?.arguments[1], [{ text: "second", bubbleIndex: 0 }]);
    parsePhotonOperationOutcome(outcome);
  } finally {
    await h.manager.stop();
  }
});

test("scoped observations never infer operation success from matching text or absent history", async () => {
  const h = await harness();
  try {
    const target = { ...h.scope.reference, conversationId: chatGuid, messageId: "target" };
    assert.equal((await observeAdvancedMessage(h.connection, target)).kind, "inconclusive");
    mock.method(h.sdk.messages, "get", async () => message({ guid: "target", chatGuids: ["foreign"] }));
    await assert.rejects(observeAdvancedMessage(h.connection, target), /FOREIGN_OBSERVATION/u);
    mock.method(h.sdk.messages, "get", async () => undefined);
    await assert.rejects(observeAdvancedMessage(h.connection, target), /FOREIGN_OBSERVATION/u);
  } finally {
    await h.manager.stop();
  }
});

test("late successful writes retain actual receipts after shutdown", async () => {
  const h = await harness();
  const started = Promise.withResolvers<void>();
  const sent = Promise.withResolvers<Message>();
  mock.method(h.sdk.messages, "sendText", () => {
    started.resolve();
    return sent.promise;
  });
  const op = operation(h.scope, "message.text", { text: "hello" });
  const pending = h.client.sendText(op);
  await started.promise;
  await h.manager.stop();
  sent.resolve(message({ isFromMe: true }));
  assert.equal((await pending).kind, "confirmed-message");
  assert.equal((await h.client.sendText(op)).kind, "failed");
});

test("live and catch-up overlap is captured before ordered handoff and never advances to head", async () => {
  const h = await harness();
  const feeds = installStreams(h.sdk);
  const store = new FakeEventReceiptStore();
  const received: string[] = [];
  try {
    const intake = await startProviderIntake(h.connection, store, async (input) => {
      assert.ok(await store.read({ ...eventKey(input), eventId: "1" }));
      received.push(input.event.sequence!);
    });
    feeds.messages.push(event(3));
    feeds.catchup.push(event(2));
    feeds.catchup.push(event(1));
    feeds.catchup.push(event(3));
    feeds.catchup.push({ type: "catchup.complete", headSequence: 100 });
    assert.deepEqual(await intake.completion, { mode: "catchup", headSequence: "100" });
    assert.deepEqual(received, ["1", "2", "3"]);
    assert.equal(await store.readContiguousCheckpoint(h.scope.reference), undefined);
    await assert.rejects(
      startProviderIntake(h.connection, store, async () => undefined),
      /ALREADY_OWNED/u,
    );
    await intake.stop();
  } finally {
    await h.manager.stop();
  }
});

test("bounded recovery retains captured receipts and does not prematurely hand off", async () => {
  const h = await harness();
  const feeds = installStreams(h.sdk);
  const store = new FakeEventReceiptStore();
  let calls = 0;
  try {
    const intake = await startProviderIntake(
      h.connection,
      store,
      async () => {
        calls += 1;
      },
      { maxEvents: 1, maxBytes: 100_000, catchupTimeoutMs: 5000 },
    );
    feeds.catchup.push(event(1));
    feeds.catchup.push(event(2));
    await assert.rejects(intake.completion, /BOUND_EXCEEDED/u);
    assert.equal(calls, 0);
    assert.ok(await store.read({ ...h.scope.reference, eventId: "2" }));
    assert.equal(await store.readContiguousCheckpoint(h.scope.reference), undefined);
    await intake.stop();
  } finally {
    await h.manager.stop();
  }
});

test("restart replays from the durable cursor and late old stream events stay stopped", async () => {
  const h = await harness();
  const store = new FakeEventReceiptStore();
  const firstFeeds = installStreams(h.sdk);
  const now = "2026-09-12T12:00:01.000Z";
  const input = normalizeAdvancedEvent(event(1), h.scope);
  await store.capture({
    key: eventKey(input),
    sequence: "1",
    state: "captured",
    capturedAt: now,
    payload: { kind: "envelope", envelope: input },
  });
  const claimed = await store.claim(eventKey(input), "worker", now, "2026-09-12T12:01:00.000Z");
  assert.ok(claimed?.claim);
  assert.equal(
    await store.advanceContiguousCheckpoint(
      { ...eventKey(input), lineId: h.scope.reference.lineId },
      0,
      "1",
      claimed.claim,
      now,
    ),
    true,
  );
  let received = 0;
  try {
    const first = await startProviderIntake(h.connection, store, async () => {
      received += 1;
    });
    firstFeeds.catchup.push({ type: "catchup.complete", headSequence: 1 });
    await first.completion;
    assert.equal(firstFeeds.catchUp.mock.calls[0]?.arguments[0], 1);
    await first.stop();
    firstFeeds.messages.push(event(2));
    const feeds = installStreams(h.sdk);
    const second = await startProviderIntake(h.connection, store, async () => {
      received += 1;
    });
    feeds.catchup.push(event(2));
    feeds.catchup.push({ type: "catchup.complete", headSequence: 2 });
    await second.completion;
    assert.equal(received, 1);
    await second.stop();
  } finally {
    await h.manager.stop();
  }
});

test("credential renewal and line replacement close old clients before new construction", async () => {
  const scope = line();
  const order: string[] = [];
  const manager = createConnectionManager({
    advanced: (options) => {
      order.push(`construct:${typeof options.token === "string" ? options.token : "function"}`);
      const sdk = constructAdvanced(options);
      const close = sdk.close.bind(sdk);
      mock.method(sdk, "close", async () => {
        order.push("close");
        await close();
      });
      return sdk;
    },
    spectrum: async () => {
      throw new Error("unexpected-spectrum");
    },
  });
  try {
    const old = await manager.replace(scope, credentials);
    await manager.replace(scope, { ...credentials, token: "renewed" });
    assert.throws(() => old.assertActive(), /STOPPED/u);
    await manager.replace(
      { ...scope, reference: { ...scope.reference, lineId: "replacement" } },
      { ...credentials, token: "replacement" },
    );
    assert.deepEqual(order, [
      "construct:offline-token",
      "close",
      "construct:renewed",
      "close",
      "construct:replacement",
    ]);
  } finally {
    await manager.stop();
  }
});

test("two managers cannot own the same physical line under different provider names", async () => {
  const h = await harness();
  const other = createConnectionManager();
  try {
    await assert.rejects(
      other.replace({ ...h.scope, reference: { ...h.scope.reference, provider: "spectrum-imessage" } }, credentials),
      /LINE_ALREADY_OWNED/u,
    );
  } finally {
    await other.stop();
    await h.manager.stop();
  }
});

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

async function spectrumHarness() {
  const base = line();
  const scope: ProviderLine = { ...base, reference: { ...base.reference, provider: "spectrum-imessage" } };
  const manager = createConnectionManager();
  const connection = await manager.replace(scope, credentials);
  if (connection.kind !== "spectrum") throw new Error("wrong-provider");
  const sdk = narrowSpectrum(connection.sdk);
  const space = await sdk.space.get(chatGuid, { phone });
  mock.method(sdk.space, "get", async () => space);
  return {
    scope,
    manager,
    connection,
    sdk,
    space,
    client: createSpectrumProviderClient(
      connection,
      new FakeEventReceiptStore(),
      async () => new Uint8Array([1, 2, 3]),
    ),
  };
}

test("Spectrum normalization preserves child IDs and maps controls without human turns", async () => {
  const h = await spectrumHarness();
  try {
    const first = Object.assign(spectrumMessage(h.space, { id: "child-a", content: { type: "text", text: "A" } }), {
      partIndex: 0,
      parentId: "container",
    });
    const second = Object.assign(spectrumMessage(h.space, { id: "child-b", content: { type: "text", text: "B" } }), {
      partIndex: 1,
      parentId: "container",
    });
    const group = spectrumMessage(h.space, { id: "container", content: { type: "group", items: [first, second] } });
    const result = normalizeSpectrumMessage(group, h.scope);
    assert.ok(result.kind === "message");
    assert.deepEqual(result.message.parts, [
      { messageId: "child-a", partIndex: 0 },
      { messageId: "child-b", partIndex: 1 },
    ]);
    assert.equal(result.event.sequence, undefined);
    parseNormalizedPhotonInput(result);
    const contents: Content[] = [
      { type: "read", target: first },
      { type: "reaction", target: second, emoji: "❤️" },
      { type: "rename", displayName: "Actual group title" },
      { type: "addMember", members: ["actual-member"] },
      { type: "removeMember", members: ["actual-member"] },
      { type: "leaveSpace" },
      { type: "avatar", action: { kind: "clear" } },
      {
        type: "poll_option",
        option: { title: "Same" },
        poll: { type: "poll", title: "Pick", options: [{ title: "Same" }, { title: "Same" }] },
        selected: true,
        title: "Same",
      },
    ];
    for (const content of contents) {
      const input = normalizeSpectrumMessage(spectrumMessage(h.space, { content }), h.scope);
      assert.notEqual(input.kind, "message");
      parseNormalizedPhotonInput(input);
    }
    assert.throws(
      () => normalizeSpectrumMessage(spectrumMessage({ ...h.space, phone: "foreign" }), h.scope),
      /FOREIGN_SPECTRUM_LINE/u,
    );
  } finally {
    await h.manager.stop();
  }
});

test("Spectrum sends one stream, checks returned line, and never confirms missing messages", async () => {
  const h = await spectrumHarness();
  try {
    const output = spectrumMessage(h.space, { direction: "outbound" });
    const chunks: string[] = [];
    const send = mock.method(h.space, "send", async (input: ContentInput) => {
      const content = typeof input === "string" ? { type: "text" as const, text: input } : await input.build();
      if (content.type === "streamText") for await (const chunk of content.stream()) chunks.push(chunk);
      return output;
    });
    const op = operation(h.scope, "message.text.stream", { format: "plain" });
    const iterable = {
      async *[Symbol.asyncIterator]() {
        yield "first";
        yield "second";
      },
    };
    assert.equal((await h.client.streamText(op, iterable)).kind, "confirmed-message");
    assert.deepEqual(chunks, ["first", "second"]);
    assert.equal(send.mock.callCount(), 1);
    const plain = operation(h.scope, "message.text", { text: "hello" });
    mock.method(h.space, "send", async () => undefined);
    assert.equal(
      (await h.client.deliver({ operation: plain, logicalPartIndexes: [0], confirmedParts: [] })).kind,
      "ambiguous",
    );
    mock.method(h.space, "send", async () =>
      spectrumMessage({ ...h.space, phone: "foreign" }, { direction: "outbound" }),
    );
    assert.equal(
      (await h.client.deliver({ operation: plain, logicalPartIndexes: [0], confirmedParts: [] })).kind,
      "ambiguous",
    );
  } finally {
    await h.manager.stop();
  }
});

test("Spectrum app sends require a native session receipt", async () => {
  const h = await spectrumHarness();
  try {
    const op = operation(h.scope, "message.app.send", {
      app: { provider: "spectrum-imessage", cardId: "card", url: "https://example.com/card", live: true },
    });
    const session = { chatGuid, messageGuid: "card-message", sessionId: "session", targetMessageGuid: "card-message" };
    mock.method(h.space, "send", async () =>
      Object.assign(spectrumMessage(h.space, { id: "card-message", direction: "outbound" }), {
        miniAppCardSession: session,
      }),
    );
    const outcome = await h.client.deliver({ operation: op, logicalPartIndexes: [0], confirmedParts: [] });
    assert.ok(outcome.kind === "confirmed-message");
    assert.deepEqual(outcome.providerReceipt, { receiptType: "app-card", session });
    mock.method(h.space, "send", async () => spectrumMessage(h.space, { id: "card-message", direction: "outbound" }));
    assert.equal(
      (await h.client.deliver({ operation: op, logicalPartIndexes: [0], confirmedParts: [] })).kind,
      "ambiguous",
    );
  } finally {
    await h.manager.stop();
  }
});

test("Advanced app updates retain sessions and reaction removal uses the declared boolean", async () => {
  const h = await harness();
  try {
    const app = {
      provider: "advanced-imessage" as const,
      cardId: "card",
      appName: "QM",
      extensionBundleId: "com.example.qm",
      teamId: "ABCDE12345",
      url: "https://example.com/card",
      layout: { caption: "Ready" },
    };
    const session = { chatGuid, messageGuid: "card-message", sessionId: "session", targetMessageGuid: "card-message" };
    mock.method(h.sdk.messages, "sendCustomizedMiniApp", async () => ({
      ...message({ guid: "card-message", isFromMe: true }),
      miniAppCardSession: session,
    }));
    const created = await h.client.sendAppCard(operation(h.scope, "message.app.send", { app }));
    assert.ok(created.kind === "confirmed-message");
    assert.deepEqual(created.providerReceipt, { receiptType: "app-card", session });
    mock.method(h.sdk.messages, "updateCustomizedMiniApp", async () => ({
      ...message({ guid: "card-message", isFromMe: true }),
      miniAppCardSession: session,
    }));
    const update = await h.client.updateAppCard(
      operation(h.scope, "message.app.update", {
        app,
        handle: { provider: "advanced-imessage", cardId: "card", session, revision: "1" },
      }),
    );
    assert.equal(update.kind, "confirmed-message");
    const react = mock.method(h.sdk.messages, "setReaction", async () => message({ isFromMe: true }));
    const removed = await h.client.react(
      operation(h.scope, "message.react", {
        target: { ...h.scope.reference, conversationId: chatGuid, messageId: "target", partIndex: 2 },
        action: "remove",
        reaction: { kind: "like" },
      }),
    );
    assert.equal(removed.kind, "confirmed-message");
    assert.equal(react.mock.calls[0]?.arguments[3], false);
    assert.equal(react.mock.calls[0]?.arguments[4]?.partIndex, 2);
  } finally {
    await h.manager.stop();
  }
});

test("catch-up timeout and live termination stay explicit without moving checkpoints", async () => {
  const h = await harness();
  const store = new FakeEventReceiptStore();
  try {
    installStreams(h.sdk);
    const timeout = await startProviderIntake(h.connection, store, async () => undefined, {
      maxEvents: 2,
      maxBytes: 10000,
      catchupTimeoutMs: 10,
    });
    await assert.rejects(timeout.completion, /CATCHUP_TIMEOUT/u);
    await timeout.stop();
    const feeds = installStreams(h.sdk);
    const ended = await startProviderIntake(h.connection, store, async () => undefined);
    await feeds.messages.close();
    await assert.rejects(ended.failure, /LIVE_STREAM_ENDED/u);
    await ended.stop();
    assert.equal(await store.readContiguousCheckpoint(h.scope.reference), undefined);
  } finally {
    await h.manager.stop();
  }
});

test("shutdown during slow construction closes the late client and never activates it", async () => {
  const created = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let closed = false;
  const manager = createConnectionManager({
    advanced: constructAdvanced,
    spectrum: async () => {
      created.resolve();
      await release.promise;
      return {
        messages: { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }) },
        stop: async () => {
          closed = true;
        },
      };
    },
  });
  const base = line();
  const pending = manager.replace(
    { ...base, reference: { ...base.reference, provider: "spectrum-imessage" } },
    credentials,
  );
  await created.promise;
  const stopped = manager.stop();
  release.resolve();
  await assert.rejects(pending, /REPLACED_DURING_CONSTRUCTION/u);
  await stopped;
  assert.equal(closed, true);
});

test("shutdown timeout retains ownership until an already-started handoff finishes", async () => {
  const h = await harness();
  const feeds = installStreams(h.sdk);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  try {
    const intake = await startProviderIntake(
      h.connection,
      new FakeEventReceiptStore(),
      async () => {
        entered.resolve();
        await finish.promise;
      },
      { maxEvents: 2, maxBytes: 10000, catchupTimeoutMs: 5000, shutdownTimeoutMs: 10 },
    );
    feeds.catchup.push(event(1));
    feeds.catchup.push({ type: "catchup.complete", headSequence: 1 });
    await entered.promise;
    await assert.rejects(h.manager.stop(), /DRAIN_TIMEOUT/u);
    const other = createConnectionManager();
    await assert.rejects(other.replace(h.scope, credentials), /LINE_ALREADY_OWNED/u);
    finish.resolve();
    await intake.stop();
    await h.manager.stop();
  } finally {
    finish.resolve();
    await h.manager.stop();
  }
});

test("a Spectrum grouped result with unexpected parts cannot confirm its container", async () => {
  const h = await spectrumHarness();
  try {
    const first = Object.assign(spectrumMessage(h.space, { id: "real-a", direction: "outbound" }), { partIndex: 0 });
    const second = Object.assign(spectrumMessage(h.space, { id: "real-b", direction: "outbound" }), { partIndex: 1 });
    const parent = spectrumMessage(h.space, {
      id: "container",
      direction: "outbound",
      content: { type: "group", items: [first, second] },
    });
    mock.method(h.space, "send", async () => parent);
    const op = operation(h.scope, "message.multipart", {
      parts: [
        { kind: "text", text: "A" },
        { kind: "text", text: "B" },
      ],
    });
    const result = await h.client.deliver({ operation: op, logicalPartIndexes: [0, 1], confirmedParts: [] });
    assert.ok(result.kind === "ambiguous");
    assert.deepEqual(result.confirmedParts, []);
    parsePhotonOperationOutcome(result);
  } finally {
    await h.manager.stop();
  }
});

test("Spectrum multipart failure retains each earlier provider receipt", async () => {
  const h = await spectrumHarness();
  try {
    let calls = 0;
    mock.method(h.space, "send", async () => {
      calls += 1;
      if (calls === 2) throw new Error("lost-response");
      return spectrumMessage(h.space, { id: "accepted-first", direction: "outbound" });
    });
    const op = operation(h.scope, "message.multipart", {
      parts: [
        { kind: "text", text: "A" },
        { kind: "text", text: "B" },
      ],
    });
    const outcome = await h.client.deliver({ operation: op, logicalPartIndexes: [0, 1], confirmedParts: [] });
    assert.ok(outcome.kind === "ambiguous");
    assert.equal(outcome.confirmedParts.length, 1);
    assert.equal(outcome.confirmedParts[0]?.part.messageId, "accepted-first");
    assert.equal(outcome.confirmedParts[0]?.logicalPartIndex, 0);
  } finally {
    await h.manager.stop();
  }
});

test("reply reads reject a foreign-chat target before any Advanced write", async () => {
  const h = await harness();
  try {
    mock.method(h.sdk.messages, "get", async () => message({ guid: "reply", chatGuids: ["foreign"] }));
    const send = mock.method(h.sdk.messages, "sendText", async () => message({ isFromMe: true }));
    const op = operation(h.scope, "message.text", {
      text: "hello",
      replyTo: { ...h.scope.reference, conversationId: chatGuid, messageId: "reply", partIndex: 0 },
    });
    assert.equal((await h.client.sendText(op)).kind, "ambiguous");
    assert.equal(send.mock.callCount(), 0);
  } finally {
    await h.manager.stop();
  }
});
