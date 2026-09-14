import assert from "node:assert/strict";
import test from "node:test";
import type { CatchUpEvent, LiveEvent, Message, MessageEvent } from "@photon-ai/advanced-imessage/grpc";

import type { CapturedEventReceipt, EventReceipt, ProviderLineScope } from "../src/ports.ts";
import type { ProviderLine } from "../src/provider/capabilities.ts";
import type { ProviderConnection } from "../src/provider/connection.ts";
import { eventKey, startProviderIntake } from "../src/provider/recovery.ts";
import { normalizeAdvancedEvent } from "../src/provider/subscriptions.ts";
import type { ReceiptRecoveryPage, ReceiptRecoveryQuery } from "../../chassis/src/photon-state/receipts.ts";
import { FakeEventReceiptStore } from "./fixtures.ts";

const timestamp = new Date("2026-09-10T12:00:00.000Z");
const line: ProviderLine = {
  reference: {
    provider: "advanced-imessage",
    installationId: "recovery-installation",
    projectId: "recovery-project",
    lineId: "recovery-line",
  },
  phone: "+15550000001",
  kind: "dedicated",
};

function message(sequence: number): Message {
  return {
    guid: `message-${sequence}`,
    chatGuids: ["recovery-chat"],
    content: { text: `message ${sequence}`, attachments: [], formatting: [], mentions: [] },
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
  };
}

function event(sequence: number): Extract<MessageEvent, { type: "message.received" }> {
  return {
    type: "message.received",
    sequence,
    chatGuid: "recovery-chat",
    occurredAt: timestamp,
    isFromMe: false,
    actor: { address: "+15550000002", service: "iMessage" },
    message: message(sequence),
  };
}

function feed<T>() {
  const queued: T[] = [];
  let changed = Promise.withResolvers<void>();
  let closed = false;
  return {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        const value = queued.shift();
        if (value !== undefined) yield value;
        else await changed.promise;
      }
    },
    push(value: T) {
      queued.push(value);
      const previous = changed;
      changed = Promise.withResolvers<void>();
      previous.resolve();
    },
    async close() {
      closed = true;
      changed.resolve();
    },
  };
}

function sameScope(receipt: EventReceipt, query: ReceiptRecoveryQuery): boolean {
  return (
    receipt.key.provider === query.provider &&
    receipt.key.installationId === query.installationId &&
    receipt.key.lineId === query.lineId
  );
}

class RecoverableStore extends FakeEventReceiptStore {
  beforeReturn: (() => Promise<void> | void) | undefined;
  afterCapture: ((receipt: CapturedEventReceipt) => void) | undefined;

  override async capture(receipt: CapturedEventReceipt) {
    const result = await super.capture(receipt);
    this.afterCapture?.(receipt);
    return result;
  }

  async discoverRecoverable(query: ReceiptRecoveryQuery): Promise<ReceiptRecoveryPage> {
    const candidates = this.receipts
      .filter(
        (receipt) =>
          sameScope(receipt, query) &&
          (receipt.state === "captured" ||
            (receipt.state === "processing" &&
              receipt.claim !== undefined &&
              Date.parse(receipt.claim.leaseExpiresAt) <= Date.parse(query.now))),
      )
      .filter(
        (receipt) =>
          query.after === undefined ||
          receipt.capturedAt > query.after.capturedAt ||
          (receipt.capturedAt === query.after.capturedAt && receipt.key.eventId > query.after.eventId),
      )
      .sort((left, right) =>
        left.capturedAt === right.capturedAt
          ? left.key.eventId.localeCompare(right.key.eventId)
          : left.capturedAt.localeCompare(right.capturedAt),
      );
    const receipts = candidates.slice(0, query.limit);
    const last = receipts.at(-1);
    await this.beforeReturn?.();
    this.beforeReturn = undefined;
    return {
      receipts,
      ...(candidates.length > query.limit && last
        ? { next: { capturedAt: last.capturedAt, eventId: last.key.eventId } }
        : {}),
    };
  }
}

function connection() {
  const messages = feed<LiveEvent>();
  const chats = feed<Extract<LiveEvent, { type: `chat.${string}` }>>();
  const groups = feed<Extract<LiveEvent, { type: "group.changed" }>>();
  const polls = feed<Extract<LiveEvent, { type: "poll.changed" }>>();
  const catchup = feed<CatchUpEvent>();
  let active = true;
  let consumer: (() => Promise<void>) | undefined;
  const value = {
    kind: "advanced" as const,
    line,
    sdk: {
      messages: { subscribeEvents: () => messages },
      chats: { subscribeEvents: () => chats },
      groups: { subscribeEvents: () => groups },
      polls: { subscribeEvents: () => polls },
      events: { catchUp: () => catchup },
    },
    assertActive() {
      if (!active) throw new Error("PROVIDER_CONNECTION_STOPPED");
    },
    addConsumer(stop: () => Promise<void>) {
      if (consumer) throw new Error("PROVIDER_INTAKE_ALREADY_OWNED");
      consumer = stop;
      return () => {
        consumer = undefined;
      };
    },
    async stop() {
      active = false;
      await consumer?.();
    },
  } as unknown as ProviderConnection;
  return { value, messages, catchup };
}

async function capture(store: RecoverableStore, sequence: number) {
  const input = normalizeAdvancedEvent(event(sequence), line);
  assert.equal(
    await store.capture({
      key: eventKey(input),
      ...(input.event.sequence === undefined ? {} : { sequence: input.event.sequence }),
      capturedAt: timestamp.toISOString(),
      payload: { kind: "envelope", envelope: input },
      state: "captured",
    }),
    "captured",
  );
  return input;
}

test("replacement intake replays durable envelopes once across catch-up overlap", async () => {
  const store = new RecoverableStore();
  await capture(store, 1);
  const firstConnection = connection();
  const firstReceived: string[] = [];
  const first = await startProviderIntake(firstConnection.value, store, async (input) => {
    firstReceived.push(input.event.eventId);
  });
  firstConnection.catchup.push(event(1));
  firstConnection.catchup.push({ type: "catchup.complete", headSequence: 1 });
  assert.deepEqual(await first.completion, { mode: "catchup", headSequence: "1" });
  assert.deepEqual(firstReceived, ["1"]);
  assert.equal(await store.readContiguousCheckpoint(line.reference as ProviderLineScope), undefined);
  await first.stop();

  const replacementConnection = connection();
  const replacementReceived: string[] = [];
  const replacement = await startProviderIntake(replacementConnection.value, store, async (input) => {
    replacementReceived.push(input.event.eventId);
  });
  replacementConnection.catchup.push({ type: "catchup.complete", headSequence: 1 });
  await replacement.completion;
  assert.deepEqual(replacementReceived, ["1"]);
  await replacement.stop();
});

test("Advanced intake co-sorts durable and concurrent catch-up envelopes", async () => {
  const store = new RecoverableStore();
  await capture(store, 2);
  const current = connection();
  store.beforeReturn = () => {
    current.catchup.push(event(1));
    current.catchup.push({ type: "catchup.complete", headSequence: 2 });
  };
  const received: string[] = [];
  const checkpointed: boolean[] = [];
  const intake = await startProviderIntake(current.value, store, async (input) => {
    received.push(input.event.eventId);
    const now = "2026-09-10T12:10:00.000Z";
    const claimed = await store.claim(eventKey(input), "co-sorted-worker", now, "2026-09-10T12:20:00.000Z");
    assert.ok(claimed?.claim && input.event.sequence !== undefined);
    const checkpoint = await store.readContiguousCheckpoint(line.reference as ProviderLineScope);
    checkpointed.push(
      await store.advanceContiguousCheckpoint(
        eventKey(input) as ReturnType<typeof eventKey> & ProviderLineScope,
        checkpoint?.version ?? 0,
        input.event.sequence,
        claimed.claim,
        now,
      ),
    );
  });
  await intake.completion;
  assert.deepEqual(received, ["1", "2"]);
  assert.deepEqual(checkpointed, [true, true]);
  assert.equal((await store.readContiguousCheckpoint(line.reference as ProviderLineScope))?.sequence, "2");
  await intake.stop();
});

test("Advanced catch-up completion cancels its timeout before durable discovery finishes", async () => {
  const resumeDiscovery = Promise.withResolvers<void>();
  const store = new RecoverableStore();
  await capture(store, 9);
  const current = connection();
  store.beforeReturn = async () => {
    current.catchup.push({ type: "catchup.complete", headSequence: 9 });
    await resumeDiscovery.promise;
  };
  const starting = startProviderIntake(current.value, store, async () => undefined, {
    maxEvents: 2,
    maxBytes: 100_000,
    catchupTimeoutMs: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  resumeDiscovery.resolve();
  const intake = await starting;
  assert.deepEqual(await intake.completion, { mode: "catchup", headSequence: "9" });
  await intake.stop();
});

test("recovery catches inserts behind a cursor and obeys event and byte bounds", async () => {
  const store = new RecoverableStore();
  await capture(store, 2);
  store.receipts[0] = { ...store.receipts[0]!, capturedAt: "2026-09-10T12:01:00.000Z" };
  store.beforeReturn = async () => {
    const behind = await capture(store, 1);
    const index = store.receipts.findIndex((receipt) => receipt.key.eventId === behind.event.eventId);
    store.receipts[index] = { ...store.receipts[index]!, capturedAt: "2026-09-10T11:59:00.000Z" };
  };
  const firstConnection = connection();
  const received: string[] = [];
  const checkpointed: boolean[] = [];
  const intake = await startProviderIntake(
    firstConnection.value,
    store,
    async (input) => {
      received.push(input.event.eventId);
      const now = "2026-09-10T12:10:00.000Z";
      const claimed = await store.claim(eventKey(input), "recovery-worker", now, "2026-09-10T12:20:00.000Z");
      assert.ok(claimed?.claim && input.event.sequence !== undefined);
      const checkpoint = await store.readContiguousCheckpoint(line.reference as ProviderLineScope);
      checkpointed.push(
        await store.advanceContiguousCheckpoint(
          eventKey(input) as ReturnType<typeof eventKey> & ProviderLineScope,
          checkpoint?.version ?? 0,
          input.event.sequence,
          claimed.claim,
          now,
        ),
      );
    },
    { maxEvents: 2, maxBytes: 100_000, catchupTimeoutMs: 5_000 },
  );
  firstConnection.catchup.push({ type: "catchup.complete", headSequence: 2 });
  await intake.completion;
  assert.deepEqual(received, ["1", "2"]);
  assert.deepEqual(checkpointed, [true, true]);
  assert.equal((await store.readContiguousCheckpoint(line.reference as ProviderLineScope))?.sequence, "2");
  await intake.stop();

  const bounded = new RecoverableStore();
  await capture(bounded, 3);
  await capture(bounded, 4);
  await assert.rejects(
    startProviderIntake(connection().value, bounded, async () => undefined, {
      maxEvents: 1,
      maxBytes: 100_000,
      catchupTimeoutMs: 5_000,
    }),
    /PROVIDER_RECOVERY_BOUND_EXCEEDED/u,
  );
  const byteBounded = new RecoverableStore();
  await capture(byteBounded, 8);
  await assert.rejects(
    startProviderIntake(connection().value, byteBounded, async () => undefined, {
      maxEvents: 1,
      maxBytes: 1,
      catchupTimeoutMs: 5_000,
    }),
    /PROVIDER_RECOVERY_BOUND_EXCEEDED/u,
  );
});

test("recovery skips a newly active claim and rejects unresolved references", async () => {
  const store = new RecoverableStore();
  const input = await capture(store, 5);
  store.beforeReturn = async () => {
    assert.ok(await store.claim(eventKey(input), "other-worker", new Date().toISOString(), "2099-01-01T00:00:00.000Z"));
  };
  let received = 0;
  const claimedConnection = connection();
  const claimed = await startProviderIntake(claimedConnection.value, store, async () => {
    received += 1;
  });
  assert.equal(received, 0);
  claimedConnection.catchup.push({ type: "catchup.complete", headSequence: 5 });
  await claimed.completion;
  await claimed.stop();

  const unresolved = new RecoverableStore();
  await unresolved.capture({
    key: { ...line.reference, eventId: "reference" },
    capturedAt: timestamp.toISOString(),
    payload: { kind: "reference", reference: "blob://reference", payloadSha256: "a".repeat(64) },
    state: "captured",
  });
  await assert.rejects(
    startProviderIntake(connection().value, unresolved, async () => undefined),
    /PROVIDER_RECOVERY_REFERENCE_UNRESOLVED/u,
  );
});

test("recovery stops without handoff when intake is cancelled during discovery", async () => {
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const store = new RecoverableStore();
  await capture(store, 6);
  store.beforeReturn = async () => {
    started.resolve();
    await resume.promise;
  };
  const current = connection();
  let received = 0;
  const starting = startProviderIntake(current.value, store, async () => {
    received += 1;
  });
  await started.promise;
  const stopping = current.value.stop();
  resume.resolve();
  await stopping;
  await assert.rejects(starting, /PROVIDER_INTAKE_STOPPED/u);
  assert.equal(received, 0);
});

test("live input is captured while a durable discovery failure is pending", async () => {
  const discoveryStarted = Promise.withResolvers<void>();
  const resumeDiscovery = Promise.withResolvers<void>();
  const liveCaptured = Promise.withResolvers<void>();
  const store = new RecoverableStore();
  await store.capture({
    key: { ...line.reference, eventId: "reference-before-live" },
    capturedAt: timestamp.toISOString(),
    payload: { kind: "reference", reference: "blob://reference", payloadSha256: "a".repeat(64) },
    state: "captured",
  });
  store.beforeReturn = async () => {
    discoveryStarted.resolve();
    await resumeDiscovery.promise;
  };
  store.afterCapture = (receipt) => {
    if (receipt.key.eventId === "7") liveCaptured.resolve();
  };
  const current = connection();
  const starting = startProviderIntake(current.value, store, async () => undefined);
  await discoveryStarted.promise;
  current.messages.push(event(7));
  await liveCaptured.promise;
  resumeDiscovery.resolve();
  await assert.rejects(starting, /PROVIDER_RECOVERY_REFERENCE_UNRESOLVED/u);
  assert.ok(await store.read(eventKey(normalizeAdvancedEvent(event(7), line))));
});

test("missing durable discovery fails closed", async () => {
  await assert.rejects(
    startProviderIntake(connection().value, new FakeEventReceiptStore(), async () => undefined),
    /PROVIDER_RECEIPT_RECOVERY_UNAVAILABLE/u,
  );
});
