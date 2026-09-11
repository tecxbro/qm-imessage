import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { AdvancedIMessage, MiniAppMessageResult, Poll } from "@photon-ai/advanced-imessage/grpc";
import type { IMessageMessage } from "@spectrum-ts/imessage";
import type { Space } from "spectrum-ts";

import {
  parseActionBinding,
  parseCheckedQmChannelOperation,
  parseInstallationDisplayStatus,
  parseNormalizedPhotonInput,
  parsePhotonOperationOutcome,
  parsePhotonPresentationOperation,
  parsePhotonReconciliationEvidence,
  parseQmChannelOperationRequest,
  projectInstallationForDashboard,
  type MessageReference,
  type NormalizedPhotonInput,
  type PhotonOperationOutcome,
  type PhotonPollState,
} from "../../chassis/src/photon-contract.ts";
import type { AdvancedIMessageProviderClientPort } from "../src/ports.ts";
import {
  chats,
  competingActions,
  connectedStatus,
  FakeActionBindingStore,
  FakeCanonicalIdentityLookup,
  FakeDeliveryOperationStore,
  FakeEventReceiptStore,
  FakeInstallationStore,
  FakeMessageBindingStore,
  FakePollReferenceStore,
  FakePublicCardHandleStore,
  FakeTextStreamSessionStore,
  multipartMessages,
  normalizedInputs,
  operationReference,
  providerEvents,
  textOperation,
} from "./fixtures.ts";

type SpectrumEditResult = Awaited<ReturnType<Space["edit"]>>;
type AdvancedUnsendResult = Awaited<ReturnType<AdvancedIMessage["messages"]["unsend"]>>;
type AdvancedEditResult = Awaited<ReturnType<AdvancedIMessage["messages"]["edit"]>>;
type AdvancedSendResult = Awaited<ReturnType<AdvancedIMessage["messages"]["sendText"]>>;
type AdvancedVoteResult = Awaited<ReturnType<AdvancedIMessage["polls"]["vote"]>>;
type AdvancedUnvoteResult = Awaited<ReturnType<AdvancedIMessage["polls"]["unvote"]>>;
type AdvancedAddOptionResult = Awaited<ReturnType<AdvancedIMessage["polls"]["addOption"]>>;
type AdvancedCreatePollResult = Awaited<ReturnType<AdvancedIMessage["polls"]["create"]>>;
type AdvancedSendMiniAppResult = Awaited<ReturnType<AdvancedIMessage["messages"]["sendCustomizedMiniApp"]>>;
type AdvancedUpdateMiniAppResult = Awaited<ReturnType<AdvancedIMessage["messages"]["updateCustomizedMiniApp"]>>;
type AdvancedRenameResult = Awaited<ReturnType<AdvancedIMessage["groups"]["setDisplayName"]>>;
type AdvancedAddParticipantResult = Awaited<ReturnType<AdvancedIMessage["groups"]["addParticipants"]>>;
type AdvancedRemoveParticipantResult = Awaited<ReturnType<AdvancedIMessage["groups"]["removeParticipants"]>>;
type AdvancedShareContactResult = Awaited<ReturnType<AdvancedIMessage["chats"]["shareContactInfo"]>>;
type SpectrumMiniAppSession = NonNullable<IMessageMessage["miniAppCardSession"]>;
type Exact<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

const spectrumEditReturnsVoid: Exact<SpectrumEditResult, void> = true;
const advancedUnsendReturnsVoid: Exact<AdvancedUnsendResult, void> = true;
const advancedEditReturnsMessage: Exact<AdvancedEditResult, AdvancedSendResult> = true;
const advancedPollMutationsReturnPoll: Exact<AdvancedVoteResult, AdvancedUnvoteResult> &
  Exact<AdvancedVoteResult, AdvancedAddOptionResult> = true;
const advancedPollCreateReturnsPoll: Exact<AdvancedCreatePollResult, Poll> = true;
const advancedMiniAppsReturnSession: Exact<AdvancedSendMiniAppResult, MiniAppMessageResult> &
  Exact<AdvancedUpdateMiniAppResult, MiniAppMessageResult> = true;
const advancedGroupMutationsReturnChat: Exact<AdvancedRenameResult, AdvancedAddParticipantResult> &
  Exact<AdvancedRenameResult, AdvancedRemoveParticipantResult> = true;
const advancedShareContactReturnsVoid: Exact<AdvancedShareContactResult, void> = true;
const spectrumMiniAppSessionIsStable: Exact<
  SpectrumMiniAppSession,
  { chatGuid: string; messageGuid: string; sessionId: string; targetMessageGuid: string }
> = true;

function reverseObjectOrder<Value>(value: Value): Value {
  if (Array.isArray(value)) return value.map(reverseObjectOrder) as Value;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, entry]) => [key, reverseObjectOrder(entry)]),
    ) as Value;
  }
  return value;
}

function advancedApp(cardId = "card-a") {
  return {
    provider: "advanced-imessage" as const,
    cardId,
    appName: "QM",
    extensionBundleId: "com.example.qm.imessage",
    layout: { caption: "Ready" },
    live: true,
    teamId: "ABCDE12345",
    url: "https://example.com/card",
  };
}

function noMessageOutcome(
  operationId: string,
  result: SpectrumEditResult | AdvancedUnsendResult,
): Extract<PhotonOperationOutcome, { kind: "confirmed-no-message" }> {
  assert.equal(result, undefined);
  const operation = {
    ...operationReference({
      ...textOperation(0),
      operationId,
      name: "message.edit",
      input: { target: { ...chats[0], messageId: "message", partIndex: 0 }, content: { kind: "text", text: "edited" } },
    }),
    name: "message.edit" as const,
  };
  return { kind: "confirmed-no-message", operation };
}

function confirmedAdvancedMessage(
  operationId: string,
  result: Pick<AdvancedSendResult, "guid" | "chatGuids" | "partCount">,
): Extract<PhotonOperationOutcome, { kind: "confirmed-message" }> {
  assert.ok(result.chatGuids.includes("chat-shared"));
  const operation = { ...operationReference(textOperation(0, { operationId })), operationId };
  const message = {
    conversation: chats[0],
    messageId: result.guid,
    parts: Array.from({ length: result.partCount ?? 1 }, (_, partIndex) => ({ messageId: result.guid, partIndex })),
  };
  return {
    kind: "confirmed-message",
    operation,
    message,
    confirmedParts: message.parts.map((part, logicalPartIndex) => ({
      logicalPartIndex,
      part: { ...chats[0], ...part },
    })),
  };
}

test("message input preserves ordered content and underlying multipart identities", () => {
  const parsed = parseNormalizedPhotonInput(normalizedInputs[0]!);
  assert.equal(parsed.kind, "message");
  if (parsed.kind !== "message") return;
  assert.deepEqual(
    parsed.content.map((entry) => entry.kind),
    ["text", "attachment"],
  );
  assert.deepEqual(
    parsed.message.parts.map((part) => part.messageId),
    ["part-text-shared", "part-file-shared"],
  );
});

test("read, mutation, reaction, poll, group, and lifecycle events retain only their actual fields", () => {
  const target = { ...chats[0], messageId: "message-shared" };
  const events: NormalizedPhotonInput[] = [
    { event: providerEvents[0], kind: "read", target: { kind: "conversation", conversation: chats[0] } },
    {
      event: providerEvents[0],
      kind: "reaction",
      conversation: chats[0],
      actor: normalizedInputs[0]!.actor,
      target,
      reaction: { action: "add", value: "❤️" },
    },
    {
      event: providerEvents[0],
      kind: "edit",
      conversation: chats[0],
      target,
      content: {
        attachments: [
          {
            companionKind: "unknown",
            fileName: "edit.png",
            guid: "attachment-guid",
            isHidden: false,
            isOutgoing: false,
            isSticker: false,
            mimeType: "image/png",
            totalBytes: 128,
            transferState: "finished",
            uti: "public.png",
          },
        ],
        formatting: [{ type: "effect", start: 0, length: 6, effectName: "future-effect" }],
        mentions: [{ address: "+15550000001", start: 0, length: 6 }],
        text: "edited",
        expressiveSendStyleId: "future-provider-effect",
        miniApp: { extensionBundleId: "app", teamId: "team", live: true, url: "http://provider.example/card" },
      },
    },
    {
      event: providerEvents[0],
      kind: "poll",
      conversation: chats[0],
      actor: normalizedInputs[0]!.actor,
      pollMessageGuid: "poll-guid",
      optionIdentifier: "option-guid",
      action: "voted",
    },
    {
      event: providerEvents[0],
      kind: "poll",
      conversation: chats[0],
      pollMessageGuid: "poll-guid",
      action: "created",
      title: "Choose",
      options: [{ optionIdentifier: "option-guid", text: "One" }],
    },
    {
      event: providerEvents[0],
      kind: "group",
      conversation: chats[0],
      action: "renamed",
      displayName: "Project room",
    },
    { event: { ...providerEvents[0], direction: "system" }, kind: "lifecycle", action: "connected" },
    {
      event: {
        provider: providerEvents[0].provider,
        installationId: providerEvents[0].installationId,
        eventId: "catchup",
        occurredAt: providerEvents[0].occurredAt,
        direction: "system",
      },
      kind: "lifecycle",
      action: "catchup-complete",
      headSequence: "200",
    },
  ];
  assert.deepEqual(
    events.map((event) => parseNormalizedPhotonInput(event).kind),
    ["read", "reaction", "edit", "poll", "poll", "group", "lifecycle", "lifecycle"],
  );
  assert.equal("partIndex" in target, false);
  assert.equal("text" in events[6]!, false);
  assert.equal("conversation" in events[6]!, false);
  assert.equal("actor" in events[6]!, false);
});

test("event and nested references must agree on provider, installation, line, and conversation", () => {
  assert.throws(() => parseNormalizedPhotonInput({ ...normalizedInputs[0]!, projectSecret: "must-not-cross" }));
  assert.throws(() => parseNormalizedPhotonInput({ ...normalizedInputs[0]!, event: providerEvents[1] }));
  assert.throws(() =>
    parseNormalizedPhotonInput({ ...normalizedInputs[0]!, event: { ...providerEvents[0], lineId: "line-other" } }),
  );
  assert.throws(() =>
    parseNormalizedPhotonInput({
      event: providerEvents[0],
      kind: "unknown",
      rawType: "future-event",
      reason: "not mapped",
      payload: [],
    }),
  );
  assert.throws(() =>
    parseNormalizedPhotonInput({
      ...normalizedInputs[0]!,
      content: [
        { kind: "text", part: multipartMessages[0]!.parts[0]!, text: "first part" },
        {
          kind: "attachment",
          attachment: {
            ...chats[1],
            messageId: "part-file-shared",
            partIndex: 1,
            attachmentId: "attachment-shared",
            providerReference: "provider-attachment-shared",
          },
        },
      ],
    }),
  );
  assert.throws(() =>
    parseNormalizedPhotonInput({
      ...normalizedInputs[0]!,
      content: [
        { kind: "text", part: { messageId: "undeclared", partIndex: 0 }, text: "first part" },
        normalizedInputs[0]!.content[1]!,
      ],
    }),
  );
  const wrongTarget = { ...chats[0], conversationId: "other-chat", messageId: "message-shared" };
  for (const input of [
    {
      event: providerEvents[0],
      kind: "edit",
      conversation: chats[0],
      target: wrongTarget,
      content: { attachments: [], formatting: [], mentions: [] },
    },
    { event: providerEvents[0], kind: "unsend", conversation: chats[0], target: wrongTarget },
    {
      event: providerEvents[0],
      kind: "reaction",
      conversation: chats[0],
      actor: normalizedInputs[0]!.actor,
      target: wrongTarget,
      reaction: { action: "add", value: "like" },
    },
  ]) {
    assert.throws(() => parseNormalizedPhotonInput(input));
  }
});

test("provider event and catch-up sequences are canonical safe integers", () => {
  assert.throws(() =>
    parseNormalizedPhotonInput({
      ...normalizedInputs[0],
      event: { ...normalizedInputs[0]!.event, sequence: "0101" },
    }),
  );
  assert.throws(() =>
    parseNormalizedPhotonInput({
      event: { ...providerEvents[0], eventId: "catchup", direction: "system" },
      kind: "lifecycle",
      action: "catchup-complete",
      headSequence: "1.5",
    }),
  );
});

test("membership events require at least one nonblank affected member", () => {
  for (const memberIds of [[], ["  "]]) {
    assert.throws(() =>
      parseNormalizedPhotonInput({
        event: providerEvents[0],
        kind: "membership",
        conversation: chats[0],
        action: "added",
        memberIds,
      }),
    );
  }
});

test("poll snapshots require unique option identifiers", () => {
  assert.throws(() =>
    parseNormalizedPhotonInput({
      event: providerEvents[0],
      kind: "poll",
      conversation: chats[0],
      action: "created",
      pollMessageGuid: "poll-guid",
      title: "Choose",
      options: [
        { optionIdentifier: "same", text: "One" },
        { optionIdentifier: "same", text: "Two" },
      ],
    }),
  );
});

test("wire validators reject non-JSON values, cycles, class instances, and malformed payloads", () => {
  assert.throws(() => parsePhotonPresentationOperation({ ...textOperation(0), input: { text: Number.NaN } }));
  assert.throws(() => parsePhotonPresentationOperation({ ...textOperation(0), input: { text: 1n } }));
  assert.throws(() => parsePhotonPresentationOperation({ ...textOperation(0), input: { text: () => "hello" } }));
  assert.throws(() => parsePhotonPresentationOperation({ ...textOperation(0), input: new Date() }));
  const cycle: Record<string, unknown> = { text: "hello" };
  cycle.self = cycle;
  const sparseOptions: unknown[] = [];
  sparseOptions.length = 2;
  const sparseParts: unknown[] = [];
  sparseParts.length = 1;
  const sparseContent: unknown[] = [];
  sparseContent.length = 2;
  assert.throws(() => parsePhotonPresentationOperation({ ...textOperation(0), input: cycle }));
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.poll.create",
      input: { title: "Choose", options: sparseOptions },
    }),
  );
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.multipart",
      input: { parts: sparseParts },
    }),
  );
  assert.throws(() => parseNormalizedPhotonInput({ ...normalizedInputs[0], content: sparseContent }));
  assert.throws(() => parsePhotonPresentationOperation({ ...textOperation(0), input: {} }));
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "conversation.avatar.clear",
      input: { projectSecret: "must-not-cross" },
    }),
  );
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.multipart",
      input: { parts: [1] },
    }),
  );
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.poll.create",
      input: { title: "Choose", options: ["only one"] },
    }),
  );
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.poll.create",
      input: { title: "Choose", options: ["One", "  "] },
    }),
  );
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.poll.create",
      input: { title: "  ", options: ["One", "Two"] },
    }),
  );
  assert.doesNotThrow(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.poll.unvote",
      input: { pollMessageGuid: "poll-guid" },
    }),
  );
  for (const content of [
    { kind: "markdown", markdown: "**edited**" },
    { kind: "app", app: advancedApp() },
  ]) {
    assert.throws(() =>
      parsePhotonPresentationOperation({
        ...textOperation(0),
        conversation: { ...chats[0], provider: "advanced-imessage" },
        name: "message.edit",
        input: { target: { ...chats[0], provider: "advanced-imessage", messageId: "message-a" }, content },
      }),
    );
  }
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.poll.add-option",
      input: { pollMessageGuid: "poll-guid", text: "  " },
    }),
  );
  for (const layout of [{}, { summary: "fallback" }, { imageTitle: "title" }]) {
    assert.throws(() =>
      parsePhotonPresentationOperation({
        ...textOperation(0),
        conversation: { ...chats[0], provider: "advanced-imessage" },
        name: "message.app.send",
        input: { app: { ...advancedApp(), layout } },
      }),
    );
  }
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.app.update",
      input: {
        handle: {
          provider: "spectrum-imessage",
          cardId: "card-a",
          target: { ...chats[0], messageId: "message-a" },
          session: {
            chatGuid: "chat-shared",
            messageGuid: "message-a",
            sessionId: "session-guid",
            targetMessageGuid: "wrong-target",
          },
          revision: "2",
        },
        app: { provider: "spectrum-imessage", cardId: "card-a", url: "https://example.com/card" },
      },
    }),
  );
  assert.doesNotThrow(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      conversation: { ...chats[0], provider: "advanced-imessage" },
      name: "message.app.update",
      input: {
        handle: {
          provider: "advanced-imessage",
          cardId: "card-a",
          session: {
            chatGuid: "chat-shared",
            messageGuid: "message-guid",
            sessionId: "session-guid",
            targetMessageGuid: "target-guid",
          },
          revision: "2",
        },
        app: advancedApp(),
      },
    }),
  );
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      conversation: { ...chats[0], provider: "advanced-imessage" },
      name: "message.app.update",
      input: {
        handle: {
          provider: "advanced-imessage",
          cardId: "card-a",
          session: {
            chatGuid: "wrong-chat",
            messageGuid: "message-guid",
            sessionId: "session-guid",
            targetMessageGuid: "target-guid",
          },
          revision: "2",
        },
        app: advancedApp(),
      },
    }),
  );
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.app.update",
      input: {
        handle: {
          provider: "spectrum-imessage",
          cardId: "card-a",
          target: { ...chats[0], messageId: "message-a" },
          session: {
            chatGuid: "chat-shared",
            messageGuid: "message-a",
            sessionId: "session-guid",
            targetMessageGuid: "message-a",
          },
          revision: "2",
        },
        app: { provider: "spectrum-imessage", cardId: "card-b", url: "https://example.com/card" },
      },
    }),
  );
  assert.doesNotThrow(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.poll.add-option",
      input: { pollMessageGuid: "poll-guid", text: "New option" },
    }),
  );
  assert.doesNotThrow(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.markdown",
      input: {
        markdown: "**ready**",
        replyTo: { ...chats[0], messageId: "parent", partIndex: 0 },
        effect: "com.apple.messages.effect.CKConfettiEffect",
        enableLinkPreview: true,
      },
    }),
  );
  assert.doesNotThrow(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.text.stream",
      input: { format: "markdown" },
    }),
  );
  assert.doesNotThrow(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.link",
      input: { url: "https://example.com/result", preview: true },
    }),
  );
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.link",
      input: { url: "http://example.com/result", preview: true },
    }),
  );
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.react",
      input: {
        target: { ...chats[0], messageId: "message-a", partIndex: Number.MAX_SAFE_INTEGER + 1 },
        action: "add",
        reaction: { kind: "like" },
      },
    }),
  );
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.link",
      input: { url: "https://", preview: true },
    }),
  );
  const request = {
    operationId: "qm-operation",
    name: "session.rename",
    actorId: "qm-user-a",
    sessionId: "session-a",
    idempotencyKey: "qm-logical",
    input: { sessionId: "session-a", title: "New title" },
  } as const;
  assert.deepEqual(parseQmChannelOperationRequest(request), request);
  assert.throws(() => parseQmChannelOperationRequest({ ...request, authorization: { decision: "allowed" } }));
  assert.throws(() =>
    parseQmChannelOperationRequest({ ...request, input: { ...request.input, sessionId: "session-b" } }),
  );
  assert.doesNotThrow(() =>
    parseQmChannelOperationRequest({
      operationId: "turn-operation",
      name: "turn.start",
      actorId: "qm-user-a",
      idempotencyKey: "turn-logical",
      input: { source: "photon", request: normalizedInputs[0], redeliveryKey: "event-a" },
    }),
  );
  assert.throws(() =>
    parseQmChannelOperationRequest({
      operationId: "turn-operation",
      name: "turn.start",
      actorId: "qm-user-a",
      idempotencyKey: "turn-logical",
      input: { source: "photon", request: { ...normalizedInputs[0], secret: "x" }, redeliveryKey: "event-a" },
    }),
  );
  assert.doesNotThrow(() =>
    parseQmChannelOperationRequest({
      operationId: "reach-operation",
      name: "reach.send",
      actorId: "qm-user-a",
      idempotencyKey: "reach-logical",
      input: {
        destination: { kind: "principal", principalId: "qm-user-b" },
        content: {
          attachments: [{ attachmentId: "stored-a", providerReference: "durable://stored-a" }],
        },
      },
    }),
  );
  assert.throws(() =>
    parseQmChannelOperationRequest({
      operationId: "reach-operation",
      name: "reach.send",
      actorId: "qm-user-a",
      idempotencyKey: "reach-logical",
      input: { destination: { kind: "principal", principalId: "qm-user-b", secret: "x" }, content: {} },
    }),
  );
});

test("presentation inputs reject arbitrary bags and preserve outbound-only attachment identity", () => {
  const attachment = { attachmentId: "stored-a", providerReference: "durable://stored-a", mediaType: "image/png" };
  assert.doesNotThrow(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.attachment",
      input: { attachment },
    }),
  );
  assert.doesNotThrow(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.multipart",
      input: {
        parts: [
          { kind: "attachment", attachment },
          { kind: "link", url: "https://example.com", preview: true },
        ],
      },
    }),
  );
  assert.throws(() =>
    parsePhotonPresentationOperation({ ...textOperation(0), name: "message.multipart", input: { parts: [{}] } }),
  );
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.text",
      input: { text: "hello", effect: "confetti" },
    }),
  );
  assert.doesNotThrow(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.app.update",
      input: {
        handle: {
          provider: "spectrum-imessage",
          cardId: "card-a",
          target: { ...chats[0], messageId: "message-a" },
          session: {
            chatGuid: "chat-shared",
            messageGuid: "message-a",
            sessionId: "session-guid",
            targetMessageGuid: "message-a",
          },
          revision: "2",
        },
        app: { provider: "spectrum-imessage", cardId: "card-a", url: "https://example.com/card", live: true },
      },
    }),
  );
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.app.send",
      input: {
        app: { provider: "spectrum-imessage", cardId: "card-a", url: "https://example.com/card", secret: "x" },
      },
    }),
  );
  assert.doesNotThrow(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.edit",
      input: {
        target: { ...chats[0], messageId: "message-a" },
        content: { kind: "markdown", markdown: "**ready**" },
      },
    }),
  );
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      name: "message.react",
      input: {
        action: "add",
        target: { ...chats[0], messageId: "message-a" },
        reaction: { kind: "custom", value: "x" },
      },
    }),
  );
});

test("checked QM operations reject class instances at every wire boundary", () => {
  const checked = {
    operationId: "qm-operation",
    name: "session.rename" as const,
    actorId: "qm-user-a",
    sessionId: "session-a",
    idempotencyKey: "qm-logical",
    input: { sessionId: "session-a", title: "New title" },
    authorization: {
      actorId: "qm-user-a",
      capabilityId: "session.rename",
      resourceRevision: "1",
      checkedAt: "2026-09-10T12:00:00.000Z",
      decision: "allowed" as const,
    },
  };
  assert.doesNotThrow(() => parseCheckedQmChannelOperation(checked));
  class CheckedOperation {
    operationId = checked.operationId;
    name = checked.name;
    actorId = checked.actorId;
    sessionId = checked.sessionId;
    idempotencyKey = checked.idempotencyKey;
    input = checked.input;
    authorization = checked.authorization;
  }
  class Authorization {
    actorId = checked.authorization.actorId;
    capabilityId = checked.authorization.capabilityId;
    resourceRevision = checked.authorization.resourceRevision;
    checkedAt = checked.authorization.checkedAt;
    decision = checked.authorization.decision;
  }
  assert.throws(() => parseCheckedQmChannelOperation(new CheckedOperation()));
  assert.throws(() => parseCheckedQmChannelOperation({ ...checked, authorization: new Authorization() }));
});

test("wire validators reject unsupported fields at every typed reference boundary", () => {
  assert.throws(() =>
    parseNormalizedPhotonInput({
      ...normalizedInputs[0],
      event: { ...normalizedInputs[0]!.event, secret: "event-secret" },
    }),
  );
  assert.throws(() =>
    parseNormalizedPhotonInput({
      ...normalizedInputs[0],
      conversation: { ...normalizedInputs[0]!.conversation, secret: "conversation-secret" },
    }),
  );
  assert.throws(() =>
    parseNormalizedPhotonInput({
      ...normalizedInputs[0],
      actor: { ...normalizedInputs[0]!.actor, secret: "actor-secret" },
    }),
  );
  assert.throws(() =>
    parseNormalizedPhotonInput({
      ...normalizedInputs[0],
      content: [
        { kind: "text", part: { ...multipartMessages[0]!.parts[0], secret: "part-secret" }, text: "first part" },
        normalizedInputs[0]!.content[1],
      ],
    }),
  );
  assert.throws(() =>
    parseNormalizedPhotonInput({
      event: providerEvents[0],
      kind: "edit",
      conversation: chats[0],
      target: { ...chats[0], messageId: "message-shared" },
      content: {
        attachments: [],
        formatting: [],
        mentions: [],
        miniApp: { extensionBundleId: "app", teamId: "team", live: true, secret: "x" },
      },
    }),
  );
  assert.throws(() =>
    parsePhotonPresentationOperation({
      ...textOperation(0),
      conversation: { ...chats[0], secret: "operation-secret" },
    }),
  );
  assert.throws(() =>
    parseActionBinding({ ...competingActions[0], actor: { ...competingActions[0]!.actor, secret: "x" } }),
  );
});

test("pre-project setup states need no fabricated project, line, or credential identifiers", () => {
  assert.deepEqual(parseInstallationDisplayStatus({ state: "not-started", installationId: "installation-a" }), {
    state: "not-started",
    installationId: "installation-a",
  });
  assert.deepEqual(parseInstallationDisplayStatus({ state: "provisioning", installationId: "installation-a" }), {
    state: "provisioning",
    installationId: "installation-a",
  });
  assert.throws(() =>
    parseInstallationDisplayStatus({
      state: "connected",
      installationId: "installation-a",
      projectId: "project-a",
      lines: [],
    }),
  );
});

test("installation records retain installation, project, and monotonic CAS identity", async () => {
  const store = new FakeInstallationStore();
  const record = {
    installation: { installationId: "installation-a", projectId: "project-a" },
    status: {
      state: "connected" as const,
      installationId: "installation-a",
      projectId: "project-a",
      lines: [],
    },
    ownerRevision: "1",
    version: 1,
  };
  assert.equal(await store.create(record), true);
  assert.equal(
    await store.create({
      ...record,
      installation: { installationId: "installation-b", projectId: "project-a" },
      version: 1,
    }),
    false,
  );
  assert.equal(await store.compareAndSet("installation-a", 1, { ...record, version: 3 }), false);
  assert.equal(
    await store.compareAndSet("installation-a", 1, {
      ...record,
      status: { ...record.status, projectId: "project-other" },
      version: 2,
    }),
    false,
  );
  assert.equal(await store.compareAndSet("installation-a", 1, { ...record, ownerRevision: "2", version: 2 }), true);
});

test("device authorization URLs are bound to the trusted management origin", () => {
  const privateStatus = {
    state: "awaiting-authorization" as const,
    installationId: "installation-a",
    managementOrigin: "https://photon.internal.example/api",
    userCode: "ABCD-EFGH",
    verificationUrl: "https://photon.internal.example/device",
    expiresAt: "2026-09-10T13:00:00.000Z",
  };
  const projected = projectInstallationForDashboard(privateStatus);
  assert.equal(projected.state, "awaiting-authorization");
  if (projected.state !== "awaiting-authorization") return;
  assert.equal(projected.verificationUrl, privateStatus.verificationUrl);
  assert.throws(() =>
    projectInstallationForDashboard({ ...privateStatus, verificationUrl: "https://attacker.example/device" }),
  );
});

test("dashboard projection cannot serialize private or nested credential fields", () => {
  const projected = projectInstallationForDashboard({
    ...connectedStatus(0),
    management: { accessToken: "token-secret", credentialPath: "/private/credentials.json" },
    runtime: { projectSecret: "project-secret", credentialCiphertext: "ciphertext" },
  });
  const serialized = JSON.stringify(projected);
  assert.equal(serialized.includes("token-secret"), false);
  assert.equal(serialized.includes("project-secret"), false);
  assert.equal(serialized.includes("credentials.json"), false);
  assert.throws(() => parseInstallationDisplayStatus({ ...connectedStatus(0), projectSecret: "secret" }));
  assert.throws(() =>
    parseInstallationDisplayStatus({
      ...connectedStatus(0),
      lines: [{ lineId: "line-shared", maskedAddress: "+1•••0001", token: "nested-secret" }],
    }),
  );
});

test("captured envelopes remain recoverable and identical event IDs are tenant-isolated", async () => {
  const store = new FakeEventReceiptStore();
  const receipts = normalizedInputs.map(
    (envelope, index) =>
      ({
        key: {
          provider: providerEvents[index]!.provider,
          installationId: providerEvents[index]!.installationId,
          eventId: providerEvents[index]!.eventId,
          lineId: providerEvents[index]!.lineId,
        },
        sequence: providerEvents[index]!.sequence!,
        capturedAt: "2026-09-10T12:00:02.000Z",
        payload: { kind: "envelope", envelope },
        state: "captured",
      }) as const,
  );
  assert.equal(await store.capture(receipts[0]!), "captured");
  assert.equal(await store.capture(receipts[0]!), "duplicate");
  assert.equal(await store.capture(reverseObjectOrder(receipts[0]!)), "duplicate");
  assert.equal(await store.capture(receipts[1]!), "captured");
  const secondLine = {
    key: { ...receipts[0]!.key, lineId: "line-second" },
    sequence: "102",
    capturedAt: "2026-09-10T12:00:03.000Z",
    payload: { kind: "reference" as const, reference: "durable://event-second-line", payloadSha256: "a".repeat(64) },
    state: "captured" as const,
  };
  assert.equal(await store.capture(secondLine), "captured");
  const catchup = {
    key: { provider: "advanced-imessage" as const, installationId: "installation-b", eventId: "catchup" },
    capturedAt: "2026-09-10T12:00:04.000Z",
    payload: {
      kind: "envelope" as const,
      envelope: {
        event: {
          provider: "advanced-imessage" as const,
          installationId: "installation-b",
          eventId: "catchup",
          occurredAt: "2026-09-10T12:00:04.000Z",
          direction: "system" as const,
        },
        kind: "lifecycle" as const,
        action: "catchup-complete" as const,
        headSequence: "200",
      },
    },
    state: "captured" as const,
  };
  assert.equal(await store.capture(catchup), "captured");
  assert.equal(
    await store.capture({ ...receipts[0]!, key: { ...receipts[0]!.key, installationId: "installation-b" } }),
    "conflict",
  );
  assert.deepEqual((await store.read(receipts[0]!.key))?.payload, receipts[0]!.payload);
  assert.deepEqual((await store.read(receipts[1]!.key))?.payload, receipts[1]!.payload);
  assert.deepEqual((await store.read(secondLine.key))?.payload, secondLine.payload);
  assert.equal(await store.capture({ ...receipts[0]!, state: "checkpointed", checkpoint: "101" } as never), "conflict");
});

for (const terminalState of ["checkpointed", "rejected"] as const) {
  for (const predecessorState of ["captured", "processing"] as const) {
    test(`first ${terminalState} checkpoint cannot skip a ${predecessorState} predecessor`, async () => {
      const store = new FakeEventReceiptStore();
      const now = "2026-09-10T12:00:02.000Z";
      const expiry = "2026-09-10T12:01:00.000Z";
      const firstKey = { ...providerEvents[0]!, eventId: "first", lineId: "line-shared" };
      const secondKey = { ...firstKey, eventId: "second" };
      for (const [key, sequence] of [
        [secondKey, "102"],
        [firstKey, "101"],
      ] as const) {
        assert.equal(
          await store.capture({
            key,
            sequence,
            capturedAt: now,
            state: "captured",
            payload: { kind: "reference", reference: `durable://${key.eventId}`, payloadSha256: "a".repeat(64) },
          }),
          "captured",
        );
      }
      let first = predecessorState === "processing" ? await store.claim(firstKey, "first", now, expiry) : undefined;
      const second = await store.claim(secondKey, "second", now, expiry);
      assert.ok(second?.claim);
      const finish =
        terminalState === "checkpointed"
          ? store.advanceContiguousCheckpoint.bind(store)
          : (...args: Parameters<typeof store.advanceContiguousCheckpoint>) =>
              store.rejectAndAdvanceContiguousCheckpoint(...args, "UNSUPPORTED_EVENT");
      const before = structuredClone(store.receipts);
      assert.equal(await finish(secondKey, 0, "102", second.claim, now), false);
      assert.equal(await store.readContiguousCheckpoint(secondKey), undefined);
      assert.deepEqual(store.receipts, before);
      first ??= await store.claim(firstKey, "first", now, expiry);
      assert.ok(first?.claim);
      assert.equal(await finish(firstKey, 0, "101", first.claim, now), true);
      assert.equal(await finish(secondKey, 1, "102", second.claim, now), true);
      assert.equal((await store.read(firstKey))?.state, terminalState);
      assert.equal((await store.read(secondKey))?.state, terminalState);
      assert.equal((await store.readContiguousCheckpoint(secondKey))?.sequence, "102");
    });
  }
}

test("initial checkpoint boundaries are isolated by provider, installation, and line", async () => {
  for (const otherScope of [
    { ...providerEvents[0]!, provider: "advanced-imessage" as const },
    { ...providerEvents[0]!, installationId: "other-installation" },
    { ...providerEvents[0]!, lineId: "other-line" },
  ]) {
    const store = new FakeEventReceiptStore();
    const now = "2026-09-10T12:00:02.000Z";
    const key = { ...providerEvents[0]!, lineId: "line-shared" };
    for (const [scope, sequence] of [
      [otherScope, "101"],
      [key, "102"],
    ] as const) {
      await store.capture({
        key: scope,
        sequence,
        capturedAt: now,
        state: "captured",
        payload: { kind: "reference", reference: "durable://event", payloadSha256: "a".repeat(64) },
      });
    }
    const receipt = await store.claim(key, "worker", now, "2026-09-10T12:01:00.000Z");
    assert.ok(receipt?.claim);
    assert.equal(await store.advanceContiguousCheckpoint(key, 0, "102", receipt.claim, now), true);
  }
});

test("a stale receipt claim cannot complete, reject, or skip a sequence with a newer claim", async () => {
  const store = new FakeEventReceiptStore();
  const key = {
    provider: "spectrum-imessage",
    installationId: "installation-a",
    lineId: "line-shared",
    eventId: "event-shared",
  } as const;
  await store.capture({
    key,
    sequence: "101",
    capturedAt: "2026-09-10T12:00:02.000Z",
    payload: { kind: "envelope", envelope: normalizedInputs[0]! },
    state: "captured",
  });
  assert.equal(await store.claim(key, "worker-a", "invalid", "2026-09-10T12:01:00.000Z"), undefined);
  assert.equal(await store.claim(key, "worker-a", "2026-09-10T12:00:02.000Z", "2026-09-10T12:00:01.000Z"), undefined);
  const first = await store.claim(key, "worker-a", "2026-09-10T12:00:02.000Z", "2026-09-10T12:01:00.000Z");
  const early = await store.claim(key, "worker-b", "2026-09-10T12:00:59.000Z", "2026-09-10T12:02:00.000Z");
  const second = await store.claim(key, "worker-b", "2026-09-10T12:01:00.000Z", "2026-09-10T12:02:00.000Z");
  assert.ok(first?.claim);
  assert.equal(early, undefined);
  assert.ok(second?.claim);
  assert.equal(await store.completeWithoutSequence(key, first.claim, "2026-09-10T12:01:01.000Z"), false);
  assert.equal(
    await store.rejectAndAdvanceContiguousCheckpoint(key, 0, "101", first.claim, "2026-09-10T12:01:01.000Z", "STALE"),
    false,
  );
  assert.equal(
    await store.advanceContiguousCheckpoint(
      { ...key, lineId: "line-other" },
      0,
      "101",
      second.claim,
      "2026-09-10T12:01:01.000Z",
    ),
    false,
  );
  assert.equal(await store.advanceContiguousCheckpoint(key, 0, "999", second.claim, "2026-09-10T12:01:01.000Z"), false);
  assert.equal(await store.advanceContiguousCheckpoint(key, 0, "101", second.claim, "2026-09-10T12:01:01.000Z"), true);
  assert.deepEqual(await store.readContiguousCheckpoint(key), {
    scope: { provider: key.provider, installationId: key.installationId, lineId: key.lineId },
    sequence: "101",
    version: 1,
  });
  assert.equal(await store.readContiguousCheckpoint({ ...key, installationId: "installation-other" }), undefined);
  assert.equal(await store.readContiguousCheckpoint({ ...key, lineId: "line-other" }), undefined);
  assert.deepEqual(await store.read(key), {
    key,
    sequence: "101",
    capturedAt: "2026-09-10T12:00:02.000Z",
    payload: { kind: "envelope", envelope: normalizedInputs[0] },
    state: "checkpointed",
    claim: second.claim,
    checkpoint: "101",
  });
  const rejectedKey = { ...key, eventId: "event-rejected" };
  await store.capture({
    key: rejectedKey,
    sequence: "102",
    capturedAt: "2026-09-10T12:02:00.000Z",
    payload: { kind: "reference", reference: "durable://event-102", payloadSha256: "b".repeat(64) },
    state: "captured",
  });
  const rejected = await store.claim(rejectedKey, "worker-c", "2026-09-10T12:02:00.000Z", "2026-09-10T12:03:00.000Z");
  assert.ok(rejected?.claim);
  assert.equal(
    await store.rejectAndAdvanceContiguousCheckpoint(
      rejectedKey,
      1,
      "102",
      rejected.claim,
      "2026-09-10T12:02:01.000Z",
      undefined as never,
    ),
    false,
  );
  assert.equal(store.checkpoints[0]?.sequence, "101");
  assert.equal((await store.read(rejectedKey))?.state, "processing");
  assert.equal(
    await store.rejectAndAdvanceContiguousCheckpoint(
      rejectedKey,
      1,
      "102",
      rejected.claim,
      "2026-09-10T12:02:01.000Z",
      "UNSUPPORTED_EVENT",
    ),
    true,
  );
  assert.equal((await store.read(rejectedKey))?.state, "rejected");
  const nextKey = { ...key, eventId: "event-next" };
  await store.capture({
    key: nextKey,
    sequence: "103",
    capturedAt: "2026-09-10T12:02:01.000Z",
    payload: { kind: "reference", reference: "durable://event-103", payloadSha256: "c".repeat(64) },
    state: "captured",
  });
  const next = await store.claim(nextKey, "worker-d", "2026-09-10T12:02:01.000Z", "2026-09-10T12:03:01.000Z");
  assert.ok(next?.claim);
  assert.equal(
    await store.advanceContiguousCheckpoint(nextKey, 2, "103", next.claim, "2026-09-10T12:02:02.000Z"),
    true,
  );
});

test("unsequenced receipts complete atomically through their fenced claim", async () => {
  const store = new FakeEventReceiptStore();
  const key = { provider: "spectrum-imessage" as const, installationId: "installation-a", eventId: "lifecycle-a" };
  await store.capture({
    key,
    capturedAt: "2026-09-10T12:00:02.000Z",
    payload: { kind: "reference", reference: "durable://lifecycle-a", payloadSha256: "c".repeat(64) },
    state: "captured",
  });
  const claimed = await store.claim(key, "worker-a", "2026-09-10T12:00:02.000Z", "2026-09-10T12:01:00.000Z");
  assert.ok(claimed?.claim);
  assert.equal(
    await store.completeWithoutSequence(
      key,
      { ...claimed.claim, leaseExpiresAt: "2026-09-10T13:00:00.000Z" },
      "2026-09-10T12:01:01.000Z",
    ),
    false,
  );
  assert.equal(await store.completeWithoutSequence(key, claimed.claim, "2026-09-10T12:00:03.000Z"), true);
  assert.equal((await store.read(key))?.state, "checkpointed");
  assert.equal(await store.completeWithoutSequence(key, claimed.claim, "2026-09-10T12:00:04.000Z"), false);
  const rejectedKey = { ...key, eventId: "lifecycle-b" };
  await store.capture({
    key: rejectedKey,
    capturedAt: "2026-09-10T12:00:03.000Z",
    payload: { kind: "reference", reference: "durable://lifecycle-b", payloadSha256: "d".repeat(64) },
    state: "captured",
  });
  const rejected = await store.claim(rejectedKey, "worker-b", "2026-09-10T12:00:03.000Z", "2026-09-10T12:01:03.000Z");
  assert.ok(rejected?.claim);
  assert.equal(
    await store.rejectWithoutSequence(rejectedKey, rejected.claim, "2026-09-10T12:00:04.000Z", undefined as never),
    false,
  );
  assert.equal((await store.read(rejectedKey))?.state, "processing");
  assert.equal(
    await store.rejectWithoutSequence(rejectedKey, rejected.claim, "2026-09-10T12:00:04.000Z", "UNSUPPORTED_EVENT"),
    true,
  );
  assert.equal((await store.read(rejectedKey))?.state, "rejected");
});

test("canonical actor lookup includes provider scope", async () => {
  const lookup = new FakeCanonicalIdentityLookup();
  assert.equal(
    (await lookup.resolveActor(providerEvents[0], normalizedInputs[0]!.actor))?.canonicalIdentityId,
    "qm-user-a",
  );
  assert.equal(
    await lookup.resolveActor({ ...providerEvents[0], provider: "advanced-imessage" }, normalizedInputs[0]!.actor),
    undefined,
  );
});

test("message bindings isolate tenants and detect overlap in every multipart part", async () => {
  const store = new FakeMessageBindingStore();
  assert.equal(
    await store.bind({
      providerMessage: multipartMessages[0]!,
      qmSessionId: "session-a",
      qmEntrySequence: 1,
      resourceRevision: "1",
    }),
    "bound",
  );
  assert.equal(
    await store.bind({
      providerMessage: multipartMessages[0]!,
      qmSessionId: "session-a",
      qmEntrySequence: 1,
      resourceRevision: "1",
    }),
    "duplicate",
  );
  assert.equal(
    await store.bind({
      providerMessage: multipartMessages[1]!,
      qmSessionId: "session-b",
      qmEntrySequence: 1,
      resourceRevision: "1",
    }),
    "bound",
  );
  assert.equal(
    await store.bind({
      providerMessage: {
        conversation: chats[0],
        messageId: "another-message",
        parts: [
          { messageId: "new-part", partIndex: 0 },
          { messageId: "part-file-shared", partIndex: 1 },
        ],
      },
      qmSessionId: "session-a",
      qmEntrySequence: 1,
      resourceRevision: "1",
    }),
    "conflict",
  );
  const reordered = reverseObjectOrder({
    providerMessage: multipartMessages[0]!,
    qmSessionId: "session-a",
    qmEntrySequence: 1,
    resourceRevision: "1",
  });
  assert.equal(await store.bind(reordered), "duplicate");
  assert.equal(
    await store.bind({
      providerMessage: {
        conversation: chats[0],
        messageId: "duplicate-parts",
        parts: [
          { messageId: "same-part", partIndex: 0 },
          { messageId: "same-part", partIndex: 0 },
        ],
      },
      qmSessionId: "session-a",
      qmEntrySequence: 2,
      resourceRevision: "1",
    }),
    "conflict",
  );
});

test("poll references and app-card sessions replace through explicit versions", async () => {
  const polls = new FakePollReferenceStore();
  const firstPoll = {
    conversation: chats[0],
    pollMessageGuid: "poll-guid",
    optionIdentifiers: ["one", "two"],
    version: 1,
  };
  assert.equal(await polls.put(firstPoll), "stored");
  assert.equal(await polls.replace({ ...firstPoll, optionIdentifiers: ["one", "two", "three"], version: 2 }, 1), true);
  assert.equal(await polls.replace({ ...firstPoll, version: 2 }, 1), false);
  assert.equal(
    await polls.put({ ...firstPoll, pollMessageGuid: "poll-duplicate", optionIdentifiers: ["same", "same"] }),
    "conflict",
  );

  const cards = new FakePublicCardHandleStore();
  const firstCard = {
    conversation: { ...chats[0], provider: "advanced-imessage" as const },
    cardId: "card-a",
    handle: {
      provider: "advanced-imessage" as const,
      cardId: "card-a",
      session: {
        chatGuid: "chat-shared",
        messageGuid: "message-a",
        sessionId: "session-a",
        targetMessageGuid: "message-a",
      },
      revision: "1",
    },
    version: 1,
  };
  assert.equal(await cards.put(firstCard), "stored");
  const refreshed = {
    ...firstCard,
    handle: { ...firstCard.handle, session: { ...firstCard.handle.session, messageGuid: "message-b" }, revision: "2" },
    version: 2,
  };
  assert.equal(await cards.replace(refreshed, 1), true);
  assert.equal(await cards.replace(firstCard, 1), false);
  assert.equal(
    await cards.replace(
      {
        ...refreshed,
        handle: {
          ...refreshed.handle,
          session: { ...refreshed.handle.session, sessionId: "session-other" },
          revision: "3",
        },
        version: 3,
      },
      2,
    ),
    false,
  );
  assert.equal(
    await cards.put({
      ...firstCard,
      conversation: chats[0],
      cardId: "card-provider-mismatch",
      handle: { ...firstCard.handle, cardId: "card-provider-mismatch" },
    }),
    "conflict",
  );
  assert.equal(
    await cards.put({
      ...firstCard,
      cardId: "card-scope-mismatch",
      handle: {
        ...firstCard.handle,
        cardId: "card-scope-mismatch",
        session: { ...firstCard.handle.session, chatGuid: "wrong-chat" },
      },
    }),
    "conflict",
  );
});

test("unsupported is not confirmed and absent message results are operation-specific", () => {
  const operation = operationReference(textOperation(0));
  assert.deepEqual(
    parsePhotonOperationOutcome({ kind: "unsupported", operation, capability: "text", reason: "provider rejected" })
      .kind,
    "unsupported",
  );
  assert.throws(() => parsePhotonOperationOutcome({ kind: "confirmed-no-message", operation }));
  assert.equal(parsePhotonOperationOutcome(noMessageOutcome("spectrum-edit", undefined)).kind, "confirmed-no-message");
  const advancedEdit = {
    ...operation,
    name: "message.edit" as const,
    conversation: { ...operation.conversation, provider: "advanced-imessage" as const },
  };
  assert.throws(() => parsePhotonOperationOutcome({ kind: "confirmed-no-message", operation: advancedEdit }));
  const spectrumAppUpdate = {
    ...operation,
    name: "message.app.update" as const,
  };
  assert.equal(
    parsePhotonOperationOutcome({
      kind: "confirmed-no-message",
      operation: spectrumAppUpdate,
      providerReceipt: {
        receiptType: "app-card",
        session: {
          chatGuid: "chat-shared",
          messageGuid: "message-updated",
          sessionId: "session-guid",
          targetMessageGuid: "message-a",
        },
      },
    }).kind,
    "confirmed-no-message",
  );
  const spectrumAppSend = { ...operation, name: "message.app.send" as const };
  const spectrumAppMessage = {
    conversation: chats[0],
    messageId: "spectrum-app-guid",
    parts: [{ messageId: "spectrum-app-guid", partIndex: 0 }],
  };
  assert.throws(() =>
    parsePhotonOperationOutcome({
      kind: "confirmed-message",
      operation: spectrumAppSend,
      message: spectrumAppMessage,
      confirmedParts: [{ logicalPartIndex: 0, part: { ...chats[0], ...spectrumAppMessage.parts[0] } }],
    }),
  );
  assert.equal(
    parsePhotonOperationOutcome({
      kind: "confirmed-message",
      operation: spectrumAppSend,
      message: spectrumAppMessage,
      confirmedParts: [{ logicalPartIndex: 0, part: { ...chats[0], ...spectrumAppMessage.parts[0] } }],
      providerReceipt: {
        receiptType: "app-card",
        session: {
          chatGuid: "chat-shared",
          messageGuid: "spectrum-app-guid",
          sessionId: "spectrum-session",
          targetMessageGuid: "spectrum-app-guid",
        },
      },
    }).kind,
    "confirmed-message",
  );
  const advancedPollVote = {
    ...operation,
    name: "message.poll.vote" as const,
    conversation: { ...operation.conversation, provider: "advanced-imessage" as const },
  };
  const advancedPollCreate = { ...advancedPollVote, name: "message.poll.create" as const };
  const pollMessage = {
    conversation: advancedPollCreate.conversation,
    messageId: "poll-guid",
    parts: [{ messageId: "poll-guid", partIndex: 0 }],
  };
  assert.throws(() =>
    parsePhotonOperationOutcome({
      kind: "confirmed-message",
      operation: advancedPollCreate,
      message: pollMessage,
      confirmedParts: [{ logicalPartIndex: 0, part: { ...advancedPollCreate.conversation, ...pollMessage.parts[0] } }],
    }),
  );
  assert.equal(
    parsePhotonOperationOutcome({
      kind: "confirmed-message",
      operation: advancedPollCreate,
      message: pollMessage,
      confirmedParts: [{ logicalPartIndex: 0, part: { ...advancedPollCreate.conversation, ...pollMessage.parts[0] } }],
      providerReceipt: { receiptType: "poll", pollMessageGuid: "poll-guid", optionIdentifiers: ["option-guid"] },
    }).kind,
    "confirmed-message",
  );
  assert.throws(() =>
    parsePhotonOperationOutcome({
      kind: "confirmed-message",
      operation: advancedPollCreate,
      message: pollMessage,
      confirmedParts: [{ logicalPartIndex: 0, part: { ...advancedPollCreate.conversation, ...pollMessage.parts[0] } }],
      providerReceipt: { receiptType: "poll", pollMessageGuid: "wrong-poll", optionIdentifiers: ["option-guid"] },
    }),
  );
  assert.throws(() =>
    parsePhotonOperationOutcome({
      kind: "confirmed-message",
      operation: advancedPollCreate,
      message: pollMessage,
      confirmedParts: [{ logicalPartIndex: 0, part: { ...advancedPollCreate.conversation, ...pollMessage.parts[0] } }],
      providerReceipt: {
        receiptType: "poll",
        pollMessageGuid: "poll-guid",
        optionIdentifiers: ["option-guid", "option-guid"],
      },
    }),
  );
  const advancedAppSend = { ...advancedPollVote, name: "message.app.send" as const };
  const appMessage = {
    conversation: advancedAppSend.conversation,
    messageId: "app-guid",
    parts: [{ messageId: "app-guid", partIndex: 0 }],
  };
  assert.equal(
    parsePhotonOperationOutcome({
      kind: "confirmed-message",
      operation: advancedAppSend,
      message: appMessage,
      confirmedParts: [{ logicalPartIndex: 0, part: { ...advancedAppSend.conversation, ...appMessage.parts[0] } }],
      providerReceipt: {
        receiptType: "app-card",
        session: {
          chatGuid: "chat-shared",
          messageGuid: "app-guid",
          sessionId: "session-guid",
          targetMessageGuid: "app-guid",
        },
      },
    }).kind,
    "confirmed-message",
  );
  assert.throws(() =>
    parsePhotonOperationOutcome({
      kind: "confirmed-message",
      operation: advancedAppSend,
      message: appMessage,
      confirmedParts: [{ logicalPartIndex: 0, part: { ...advancedAppSend.conversation, ...appMessage.parts[0] } }],
      providerReceipt: {
        receiptType: "app-card",
        session: {
          chatGuid: "chat-shared",
          messageGuid: "app-guid",
          sessionId: "session-guid",
          targetMessageGuid: "wrong-target",
        },
      },
    }),
  );
  assert.throws(() => parsePhotonOperationOutcome({ kind: "confirmed-no-message", operation: advancedPollVote }));
  assert.equal(
    parsePhotonOperationOutcome({
      kind: "confirmed-no-message",
      operation: advancedPollVote,
      providerReceipt: { receiptType: "poll", pollMessageGuid: "poll-guid", optionIdentifiers: ["option-guid"] },
    }).kind,
    "confirmed-no-message",
  );
  assert.throws(() =>
    parsePhotonOperationOutcome({ kind: "confirmed-no-message", operation: advancedPollVote, providerReceipt: {} }),
  );
  const advancedRename = { ...advancedPollVote, name: "conversation.rename" as const };
  assert.equal(
    parsePhotonOperationOutcome({
      kind: "confirmed-no-message",
      operation: advancedRename,
      providerReceipt: {
        receiptType: "chat",
        chatGuid: "chat-shared",
        participantIds: ["+15550000001", "+15550000002"],
        displayName: "Project room",
      },
    }).kind,
    "confirmed-no-message",
  );
  assert.throws(() =>
    parsePhotonOperationOutcome({
      kind: "confirmed-no-message",
      operation: advancedRename,
      providerReceipt: {
        receiptType: "chat",
        chatGuid: "wrong-chat",
        participantIds: ["+15550000001"],
      },
    }),
  );
  assert.throws(() =>
    parsePhotonOperationOutcome({
      kind: "confirmed-message",
      operation: advancedPollVote,
      message: pollMessage,
      confirmedParts: [{ logicalPartIndex: 0, part: { ...advancedPollVote.conversation, ...pollMessage.parts[0] } }],
    }),
  );
  const advancedContact = { ...advancedPollVote, name: "message.contact" as const };
  assert.throws(() =>
    parsePhotonOperationOutcome({
      kind: "confirmed-message",
      operation: advancedContact,
      message: appMessage,
      confirmedParts: [{ logicalPartIndex: 0, part: { ...advancedContact.conversation, ...appMessage.parts[0] } }],
    }),
  );
  assert.equal(
    parsePhotonOperationOutcome({
      kind: "unsupported",
      operation: advancedContact,
      capability: "message.contact",
      reason: "Advanced iMessage cannot send an arbitrary vCard",
    }).kind,
    "unsupported",
  );
  assert.equal(spectrumEditReturnsVoid, true);
  assert.equal(advancedUnsendReturnsVoid, true);
  assert.equal(advancedEditReturnsMessage, true);
  assert.equal(advancedPollMutationsReturnPoll, true);
  assert.equal(advancedPollCreateReturnsPoll, true);
  assert.equal(advancedMiniAppsReturnSession, true);
  assert.equal(advancedGroupMutationsReturnChat, true);
  assert.equal(advancedShareContactReturnsVoid, true);
  assert.equal(spectrumMiniAppSessionIsStable, true);
});

test("provider-void operations reserve no phantom message part", async () => {
  const operation = parsePhotonPresentationOperation({
    ...textOperation(0),
    name: "message.edit",
    input: {
      target: { ...chats[0], messageId: "message-a" },
      content: { kind: "text", text: "edited" },
    },
  });
  const store = new FakeDeliveryOperationStore();
  assert.equal(await store.reserve(operation), "reserved");
  const dispatched = await store.markDispatched(operation, 1);
  assert.ok(dispatched);
  assert.equal(dispatched.parts.length, 0);
  assert.equal(
    await store.complete(operation, dispatched.dispatchFence, noMessageOutcome("operation-shared", undefined)),
    true,
  );
  assert.equal((await store.read(operation))?.state, "confirmed");

  const appUpdate = parsePhotonPresentationOperation({
    ...textOperation(0),
    name: "message.app.update",
    input: {
      handle: {
        provider: "spectrum-imessage",
        cardId: "card-a",
        target: { ...chats[0], messageId: "message-a" },
        session: {
          chatGuid: "chat-shared",
          messageGuid: "message-a",
          sessionId: "session-guid",
          targetMessageGuid: "message-a",
        },
        revision: "1",
      },
      app: { provider: "spectrum-imessage", cardId: "card-a", url: "https://example.com/card" },
    },
  });
  const appStore = new FakeDeliveryOperationStore();
  await appStore.reserve(appUpdate);
  const appDispatch = await appStore.markDispatched(appUpdate, 1);
  assert.ok(appDispatch);
  const appOutcome = parsePhotonOperationOutcome({
    kind: "confirmed-no-message",
    operation: operationReference(appUpdate),
    providerReceipt: {
      receiptType: "app-card",
      session: {
        chatGuid: "chat-shared",
        messageGuid: "message-refreshed",
        sessionId: "session-guid",
        targetMessageGuid: "message-a",
      },
    },
  });
  assert.equal(await appStore.complete(appUpdate, appDispatch.dispatchFence, appOutcome), true);
});

test("confirmed messages account for every returned part exactly once", () => {
  const operation = operationReference(textOperation(0));
  const message = multipartMessages[0]!;
  const confirmedParts = message.parts.map((part, logicalPartIndex) => ({
    logicalPartIndex,
    part: { ...chats[0], ...part },
  }));
  assert.doesNotThrow(() =>
    parsePhotonOperationOutcome({ kind: "confirmed-message", operation, message, confirmedParts }),
  );
  assert.throws(() =>
    parsePhotonOperationOutcome({ kind: "confirmed-message", operation, message, confirmedParts: [] }),
  );
  assert.throws(() =>
    parsePhotonOperationOutcome({
      kind: "confirmed-message",
      operation,
      message,
      confirmedParts: [confirmedParts[0], confirmedParts[0]],
    }),
  );
  assert.throws(() =>
    parsePhotonOperationOutcome({
      kind: "confirmed-message",
      operation,
      message,
      confirmedParts: [
        confirmedParts[0],
        { logicalPartIndex: 1, part: { ...chats[0], messageId: "other", partIndex: 1 } },
      ],
    }),
  );
  assert.throws(() =>
    parsePhotonOperationOutcome({
      kind: "confirmed-message",
      operation,
      message,
      confirmedParts: [{ ...confirmedParts[0], providerReceipt: {} }, confirmedParts[1]],
    }),
  );
  assert.throws(() =>
    parsePhotonOperationOutcome({
      kind: "ambiguous",
      operation,
      reconciliationKey: "duplicate-provider-part",
      confirmedParts: [confirmedParts[0], { logicalPartIndex: 1, part: confirmedParts[0]!.part }],
    }),
  );
});

test("Spectrum poll and group void outcomes complete without Advanced receipts", async () => {
  const poll = parsePhotonPresentationOperation({
    ...textOperation(0),
    name: "message.poll.create",
    input: { title: "Choose", options: ["One", "Two"] },
  });
  const pollStore = new FakeDeliveryOperationStore();
  await pollStore.reserve(poll);
  const pollDispatch = await pollStore.markDispatched(poll, 1);
  assert.ok(pollDispatch);
  const message = {
    conversation: chats[0],
    messageId: "poll-message",
    parts: [{ messageId: "poll-message", partIndex: 0 }],
  };
  const pollOutcome = parsePhotonOperationOutcome({
    kind: "confirmed-message",
    operation: operationReference(poll),
    message,
    confirmedParts: [{ logicalPartIndex: 0, part: { ...chats[0], ...message.parts[0] } }],
  });
  assert.equal(await pollStore.complete(poll, pollDispatch.dispatchFence, pollOutcome), true);

  const advancedPoll = parsePhotonPresentationOperation({
    ...textOperation(0),
    conversation: { ...chats[0], provider: "advanced-imessage" },
    name: "message.poll.create",
    input: { title: "Choose", options: ["One", "Two"] },
  });
  const advancedStore = new FakeDeliveryOperationStore();
  await advancedStore.reserve(advancedPoll);
  const advancedDispatch = await advancedStore.markDispatched(advancedPoll, 1);
  assert.ok(advancedDispatch);
  const advancedMessage = { ...message, conversation: advancedPoll.conversation };
  const incompleteReceipt = parsePhotonOperationOutcome({
    kind: "confirmed-message",
    operation: operationReference(advancedPoll),
    message: advancedMessage,
    confirmedParts: [{ logicalPartIndex: 0, part: { ...advancedPoll.conversation, ...advancedMessage.parts[0] } }],
    providerReceipt: { receiptType: "poll", pollMessageGuid: "poll-message", optionIdentifiers: ["option-one"] },
  });
  assert.equal(await advancedStore.complete(advancedPoll, advancedDispatch.dispatchFence, incompleteReceipt), false);

  for (const name of [
    "conversation.rename",
    "conversation.membership.add",
    "conversation.membership.remove",
  ] as const) {
    const input = name === "conversation.rename" ? { title: "Room" } : { participantIds: ["+15550000001"] };
    const operation = parsePhotonPresentationOperation({ ...textOperation(0), name, input });
    const store = new FakeDeliveryOperationStore();
    await store.reserve(operation);
    const dispatched = await store.markDispatched(operation, 1);
    assert.ok(dispatched);
    const outcome = parsePhotonOperationOutcome({
      kind: "confirmed-no-message",
      operation: operationReference(operation),
    });
    assert.equal(await store.complete(operation, dispatched.dispatchFence, outcome), true);
  }

  for (const fixture of [
    {
      name: "conversation.rename" as const,
      input: { title: "Requested" },
      receipt: { participantIds: ["+15550000001"], displayName: "Stale" },
    },
    {
      name: "conversation.membership.add" as const,
      input: { participantIds: ["+15550000001"] },
      receipt: { participantIds: ["+15550000002"] },
    },
    {
      name: "conversation.membership.remove" as const,
      input: { participantIds: ["+15550000001"] },
      receipt: { participantIds: ["+15550000001", "+15550000002"] },
    },
  ]) {
    const operation = parsePhotonPresentationOperation({
      ...textOperation(0),
      conversation: { ...chats[0], provider: "advanced-imessage" },
      name: fixture.name,
      input: fixture.input,
    });
    const store = new FakeDeliveryOperationStore();
    await store.reserve(operation);
    const dispatched = await store.markDispatched(operation, 1);
    assert.ok(dispatched);
    const outcome = parsePhotonOperationOutcome({
      kind: "confirmed-no-message",
      operation: operationReference(operation),
      providerReceipt: {
        receiptType: "chat",
        chatGuid: "chat-shared",
        ...fixture.receipt,
      },
    });
    assert.equal(await store.complete(operation, dispatched.dispatchFence, outcome), false);
  }
});

test("stream sessions durably order chunks and finalize once before Spectrum delivery", async () => {
  const store = new FakeTextStreamSessionStore();
  const operation = parsePhotonPresentationOperation({
    ...textOperation(0),
    name: "message.text.stream",
    input: { format: "plain" },
  });
  if (operation.name !== "message.text.stream") return;
  assert.equal(await store.create(operation), "created");
  assert.equal(await store.create(operation), "duplicate");
  assert.equal(await store.create({ ...operation, input: { ...operation.input, format: "markdown" } }), "conflict");
  const first = await store.append(operation, 1, "hello ");
  assert.deepEqual(first?.chunks, ["hello "]);
  assert.equal(await store.append(operation, 1, "stale"), undefined);
  const second = await store.append(operation, first!.version, "world");
  const finalized = await store.finalize(operation, second!.version);
  assert.deepEqual(finalized?.chunks, ["hello ", "world"]);
  assert.equal(finalized?.state, "finalized");
  assert.equal(await store.append(operation, finalized!.version, "late"), undefined);
  assert.equal(await store.finalize(operation, finalized!.version), undefined);
});

test("partial multipart delivery uses explicit logical part identity even when evidence is sparse and reordered", async () => {
  const operation = textOperation(0, {
    name: "message.multipart",
    input: {
      parts: [
        { kind: "text", text: "first" },
        { kind: "text", text: "second" },
      ],
    },
  });
  const store = new FakeDeliveryOperationStore();
  assert.equal(await store.reserve(operation), "reserved");
  const dispatched = await store.markDispatched(operation, 1);
  assert.ok(dispatched);
  const outcome = parsePhotonOperationOutcome({
    kind: "ambiguous",
    operation: operationReference(operation),
    reconciliationKey: "sparse-result",
    confirmedParts: [
      {
        logicalPartIndex: 1,
        part: { ...chats[0], messageId: "provider-second", partIndex: 7 },
      },
    ],
  });
  assert.equal(await store.complete(operation, dispatched.dispatchFence, outcome), true);
  const current = await store.read(operation);
  assert.equal(current?.parts[0]?.state, "ambiguous");
  assert.equal(current?.parts[1]?.state, "confirmed");
  assert.equal(current?.parts[1]?.providerPart?.messageId, "provider-second");
});

test("unsupported delivery terminates every reserved child without leaving dispatched work", async () => {
  const store = new FakeDeliveryOperationStore();
  const operation = textOperation(0);
  assert.equal(await store.reserve(operation), "reserved");
  const dispatched = await store.markDispatched(operation, 1);
  assert.ok(dispatched);
  assert.equal(
    await store.complete(operation, dispatched.dispatchFence, {
      kind: "unsupported",
      operation: operationReference(operation),
      capability: "message.text",
      reason: "not available",
    }),
    true,
  );
  const current = await store.read(operation);
  assert.equal(current?.state, "unsupported");
  assert.deepEqual(
    current?.parts.map((part) => part.state),
    ["unsupported"],
  );
});

test("multipart reconciliation cannot confirm a parent from partial evidence", async () => {
  const store = new FakeDeliveryOperationStore();
  const operation = textOperation(0, {
    name: "message.multipart",
    input: {
      parts: [
        { kind: "text", text: "first" },
        { kind: "text", text: "second" },
      ],
    },
  });
  assert.equal(await store.reserve(operation), "reserved");
  const dispatched = await store.markDispatched(operation, 1);
  assert.ok(dispatched);
  const ambiguous = parsePhotonOperationOutcome({
    kind: "ambiguous",
    operation: operationReference(operation),
    reconciliationKey: "multipart-reconcile",
    confirmedParts: [],
  });
  assert.equal(await store.complete(operation, dispatched.dispatchFence, ambiguous), true);
  const current = await store.read(operation);
  assert.ok(current);
  const partialMessage: MessageReference = {
    conversation: chats[0],
    messageId: "partial-message",
    parts: [{ messageId: "partial-part", partIndex: 0 }],
  };
  assert.equal(
    await store.reconcile(
      {
        operation: operationReference(operation),
        observedAt: "2026-09-10T12:03:00.000Z",
        source: "provider-query",
        outcome: {
          kind: "confirmed-message",
          operation: operationReference(operation),
          message: partialMessage,
          confirmedParts: [{ logicalPartIndex: 0, part: { ...chats[0], ...partialMessage.parts[0]! } }],
        },
      },
      current.version,
    ),
    false,
  );
  assert.equal((await store.read(operation))?.state, "ambiguous");
});

test("reconciliation cannot bind a success receipt to another poll", async () => {
  const store = new FakeDeliveryOperationStore();
  const operation = parsePhotonPresentationOperation({
    ...textOperation(0),
    conversation: { ...chats[0], provider: "advanced-imessage" },
    name: "message.poll.vote",
    input: { pollMessageGuid: "poll-requested", optionIdentifier: "option-a" },
  });
  assert.equal(await store.reserve(operation), "reserved");
  const dispatched = await store.markDispatched(operation, 1);
  assert.ok(dispatched);
  assert.equal(
    await store.complete(operation, dispatched.dispatchFence, {
      kind: "ambiguous",
      operation: operationReference(operation),
      reconciliationKey: "poll-reconcile",
      confirmedParts: [],
    }),
    true,
  );
  const current = await store.read(operation);
  assert.ok(current);
  const evidence = {
    operation: operationReference(operation),
    observedAt: "2026-09-10T12:03:00.000Z",
    source: "provider-query",
    outcome: {
      kind: "confirmed-no-message" as const,
      operation: operationReference(operation),
      providerReceipt: {
        receiptType: "poll" as const,
        pollMessageGuid: "poll-other",
        optionIdentifiers: ["option-a"],
      },
    },
  };
  assert.equal(await store.reconcile(evidence, current.version), false);
  assert.equal((await store.read(operation))?.state, "ambiguous");
});

test("ambiguous delivery preserves confirmed parts and requires evidence-based reconciliation", async () => {
  const store = new FakeDeliveryOperationStore();
  const operation = textOperation(0);
  assert.equal(await store.reserve(operation), "reserved");
  const dispatched = await store.markDispatched(operation, 1);
  assert.ok(dispatched);
  const part = { ...chats[0], messageId: "part-text-shared", partIndex: 0 };
  const ambiguous = parsePhotonOperationOutcome({
    kind: "ambiguous",
    operation: operationReference(operation),
    reconciliationKey: "reconcile-1",
    confirmedParts: [{ logicalPartIndex: 0, part }],
  });
  assert.equal(await store.complete(operation, dispatched.dispatchFence, ambiguous), true);
  const current = await store.read(operation);
  assert.equal(current?.state, "ambiguous");
  assert.equal(current?.outcome?.kind === "ambiguous" ? current.outcome.confirmedParts.length : 0, 1);
  const messageOutcome = confirmedAdvancedMessage("operation-shared", {
    guid: "part-text-shared",
    chatGuids: ["chat-shared"],
    partCount: 1,
  });
  assert.throws(() =>
    parsePhotonReconciliationEvidence({
      operation: operationReference(operation),
      observedAt: "2026-09-10T12:03:00.000Z",
      source: "provider-query",
      outcome: { ...messageOutcome, operation: { ...messageOutcome.operation, operationId: "different" } },
    }),
  );
  assert.equal(
    await store.reconcile(
      {
        operation: operationReference(operation),
        observedAt: "2026-09-10T12:03:00.000Z",
        source: "provider-query",
        outcome: { ...messageOutcome, confirmedParts: [] },
      },
      current!.version,
    ),
    false,
  );
  assert.equal(
    await store.reconcile(
      {
        operation: operationReference(operation),
        observedAt: "2026-09-10T12:03:00.000Z",
        source: "provider-query",
        outcome: messageOutcome,
      },
      current!.version,
    ),
    true,
  );
  assert.equal((await store.read(operation))?.state, "confirmed");
});

test("logical idempotency detects payload conflicts even when attempt and operation IDs change", async () => {
  const store = new FakeDeliveryOperationStore();
  const first = textOperation(0);
  assert.equal(await store.reserve(first), "reserved");
  assert.equal(
    await store.reserve(textOperation(0, { operationId: "operation-2", attemptId: "attempt-2" })),
    "duplicate",
  );
  assert.equal(
    await store.reserve(
      textOperation(0, { operationId: "operation-3", attemptId: "attempt-3", input: { text: "changed" } }),
    ),
    "conflict",
  );
  assert.equal(
    await store.markDispatched(
      textOperation(0, { operationId: "operation-4", attemptId: "attempt-4", input: { text: "changed" } }),
      1,
    ),
    undefined,
  );
  const link = parsePhotonPresentationOperation({
    ...textOperation(0, { operationId: "link-1", idempotencyKey: "link-key" }),
    name: "message.link",
    input: { url: "https://example.com", preview: true },
  });
  assert.equal(await store.reserve(link), "reserved");
  assert.equal(await store.reserve(reverseObjectOrder(link)), "duplicate");
  const otherScope = textOperation(1);
  assert.equal(await store.reserve(otherScope), "reserved");
  assert.notEqual((await store.read(first))?.parts[0]?.partId, (await store.read(otherScope))?.parts[0]?.partId);
});

test("retryable failures require a new fenced attempt while ambiguity remains reconcile-first", async () => {
  const store = new FakeDeliveryOperationStore();
  const first = textOperation(0);
  await store.reserve(first);
  const dispatched = await store.markDispatched(first, 1);
  assert.ok(dispatched);
  assert.equal(
    await store.complete(first, dispatched.dispatchFence, {
      kind: "failed",
      operation: operationReference(first),
      code: "TEMPORARY",
      retryable: true,
      confirmedParts: [],
    }),
    true,
  );
  const failed = await store.read(first);
  assert.ok(failed);
  const retry = textOperation(0, { operationId: "operation-retry", attemptId: "attempt-retry" });
  assert.equal(await store.retry(first, failed.version), undefined);
  const reserved = await store.retry(retry, failed.version);
  assert.equal(reserved?.state, "reserved");
  const redispatched = await store.markDispatched(retry, reserved!.version);
  assert.equal(redispatched?.dispatchFence, dispatched.dispatchFence + 1);
  assert.equal(
    await store.complete(retry, redispatched!.dispatchFence, {
      kind: "failed",
      operation: operationReference(retry),
      code: "TEMPORARY",
      retryable: true,
      confirmedParts: [],
    }),
    true,
  );
  const retriedFailure = await store.read(retry);
  assert.ok(retriedFailure);
  assert.equal(await store.retry(first, retriedFailure.version), undefined);

  const ambiguousStore = new FakeDeliveryOperationStore();
  await ambiguousStore.reserve(first);
  const ambiguousDispatch = await ambiguousStore.markDispatched(first, 1);
  assert.ok(ambiguousDispatch);
  await ambiguousStore.complete(first, ambiguousDispatch.dispatchFence, {
    kind: "ambiguous",
    operation: operationReference(first),
    reconciliationKey: "query-first",
    confirmedParts: [],
  });
  const ambiguous = await ambiguousStore.read(first);
  assert.ok(ambiguous);
  assert.equal(await ambiguousStore.retry(retry, ambiguous.version), undefined);

  const multipart = textOperation(0, {
    name: "message.multipart",
    input: {
      parts: [
        { kind: "text", text: "first" },
        { kind: "text", text: "second" },
      ],
    },
  });
  const multipartStore = new FakeDeliveryOperationStore();
  await multipartStore.reserve(multipart);
  const multipartDispatch = await multipartStore.markDispatched(multipart, 1);
  assert.ok(multipartDispatch);
  await multipartStore.complete(multipart, multipartDispatch.dispatchFence, {
    kind: "failed",
    operation: operationReference(multipart),
    code: "TEMPORARY",
    retryable: true,
    confirmedParts: [
      {
        logicalPartIndex: 0,
        part: { ...chats[0], messageId: "provider-first", partIndex: 0 },
      },
    ],
  });
  const partial = await multipartStore.read(multipart);
  assert.ok(partial);
  const multipartRetry = {
    ...multipart,
    operationId: "operation-multipart-retry",
    attemptId: "attempt-multipart-retry",
  };
  const multipartReserved = await multipartStore.retry(multipartRetry, partial.version);
  assert.deepEqual(
    multipartReserved?.parts.map((part) => part.state),
    ["confirmed", "reserved"],
  );
  const multipartRedispatched = await multipartStore.markDispatched(multipartRetry, multipartReserved!.version);
  assert.deepEqual(
    multipartRedispatched?.parts.map((part) => part.state),
    ["confirmed", "dispatched"],
  );
  const retryDispatch = {
    operation: multipartRetry,
    logicalPartIndexes: multipartRedispatched!.parts
      .filter((part) => part.state === "dispatched")
      .map((part) => part.partIndex),
    confirmedParts: multipartRedispatched!.parts.flatMap((part) =>
      part.state === "confirmed" && part.providerPart !== undefined
        ? [{ logicalPartIndex: part.partIndex, part: part.providerPart }]
        : [],
    ),
  };
  assert.deepEqual(retryDispatch.logicalPartIndexes, [1]);
  assert.equal(retryDispatch.confirmedParts[0]?.logicalPartIndex, 0);
  const retryMessage = {
    conversation: chats[0],
    messageId: "provider-first",
    parts: [
      { messageId: "provider-first", partIndex: 0 },
      { messageId: "provider-second", partIndex: 0 },
    ],
  };
  const retryOutcome = parsePhotonOperationOutcome({
    kind: "confirmed-message",
    operation: operationReference(multipartRetry),
    message: retryMessage,
    confirmedParts: [
      retryDispatch.confirmedParts[0]!,
      { logicalPartIndex: 1, part: { ...chats[0], ...retryMessage.parts[1] } },
    ],
  });
  const conflictingPart = { ...chats[0], messageId: "provider-conflicting", partIndex: 0 };
  for (const conflict of [
    parsePhotonOperationOutcome({
      ...retryOutcome,
      message: {
        ...retryMessage,
        messageId: conflictingPart.messageId,
        parts: [{ messageId: conflictingPart.messageId, partIndex: conflictingPart.partIndex }, retryMessage.parts[1]],
      },
      confirmedParts: [
        { logicalPartIndex: 0, part: conflictingPart },
        retryOutcome.kind === "confirmed-message" ? retryOutcome.confirmedParts[1] : undefined,
      ],
    }),
    {
      kind: "failed" as const,
      operation: operationReference(multipartRetry),
      code: "TEMPORARY",
      retryable: true,
      confirmedParts: [{ logicalPartIndex: 0, part: conflictingPart }],
    },
    {
      kind: "ambiguous" as const,
      operation: operationReference(multipartRetry),
      reconciliationKey: "retry-unknown",
      confirmedParts: [{ logicalPartIndex: 0, part: conflictingPart }],
    },
  ]) {
    const before = structuredClone(await multipartStore.read(multipartRetry));
    assert.equal(await multipartStore.complete(multipartRetry, multipartRedispatched!.dispatchFence, conflict), false);
    assert.deepEqual(await multipartStore.read(multipartRetry), before);
  }
  assert.equal(await multipartStore.complete(multipartRetry, multipartRedispatched!.dispatchFence, retryOutcome), true);
  assert.equal((await multipartStore.read(multipartRetry))?.state, "confirmed");
});

test("delivery completion rejects an outcome from another scoped operation", async () => {
  const store = new FakeDeliveryOperationStore();
  const operation = textOperation(0);
  await store.reserve(operation);
  const dispatched = await store.markDispatched(operation, 1);
  assert.ok(dispatched);
  const otherOperation = textOperation(1);
  const message = multipartMessages[1]!;
  const outcome = parsePhotonOperationOutcome({
    kind: "confirmed-message",
    operation: operationReference(otherOperation),
    message,
    confirmedParts: message.parts.map((part, logicalPartIndex) => ({
      logicalPartIndex,
      part: { ...chats[1], ...part },
    })),
  });
  assert.equal(await store.complete(operation, dispatched.dispatchFence, outcome), false);
});

test("action binding validates every authority dimension, expiry, and single use", async () => {
  const binding = parseActionBinding(competingActions[0]);
  const store = new FakeActionBindingStore();
  assert.equal(await store.create(binding), "created");
  assert.equal(await store.create(reverseObjectOrder(binding)), "duplicate");
  assert.equal(await store.create(parseActionBinding(competingActions[1])), "created");
  assert.equal((await store.read(chats[0], binding.bindingId))?.conversation.installationId, "installation-a");
  assert.equal((await store.read(chats[1], binding.bindingId))?.conversation.installationId, "installation-b");
  const request = {
    bindingId: binding.bindingId,
    actor: binding.actor,
    resourceType: binding.resource.resourceType,
    resourceId: binding.resource.resourceId,
    resourceRevision: binding.resourceRevision,
    allowedAction: binding.allowedAction,
    sessionId: binding.session.sessionId,
    conversation: binding.conversation,
    now: "2026-09-10T12:30:00.000Z",
  } as const;
  assert.equal(await store.consume({ ...request, conversation: chats[1] }), undefined);
  assert.equal(await store.consume({ ...request, now: "2026-09-10" }), undefined);
  assert.equal(
    (
      await store.consume({
        ...request,
        actor: {
          providerAddress: "+15550000001",
          canonicalIdentityId: "qm-user-a",
          kind: "human",
          actorId: "provider-user",
        },
      })
    )?.bindingId,
    binding.bindingId,
  );
  assert.equal(await store.consume(request), undefined);
  assert.throws(() => parseActionBinding({ ...binding, expiresAt: "not-a-date" }));
  assert.throws(() => parseActionBinding({ ...binding, expiresAt: "2026-09-10" }));
});

test("action replay keys cannot collide through delimiter-bearing scope values", async () => {
  const store = new FakeActionBindingStore();
  const first = parseActionBinding({
    ...competingActions[0],
    bindingId: "binding",
    conversation: { ...chats[0], lineId: "line:a", conversationId: "chat" },
  });
  const second = parseActionBinding({
    ...competingActions[0],
    bindingId: "binding",
    conversation: { ...chats[0], lineId: "line", conversationId: "a:chat" },
  });
  await store.create(first);
  await store.create(second);
  const request = (binding: typeof first) => ({
    bindingId: binding.bindingId,
    actor: binding.actor,
    resourceType: binding.resource.resourceType,
    resourceId: binding.resource.resourceId,
    resourceRevision: binding.resourceRevision,
    allowedAction: binding.allowedAction,
    sessionId: binding.session.sessionId,
    conversation: binding.conversation,
    now: "2026-09-10T12:30:00.000Z",
  });
  assert.equal((await store.consume(request(first)))?.conversation.lineId, "line:a");
  assert.equal((await store.consume(request(second)))?.conversation.lineId, "line");
});

test("installed Photon declarations and package locks match the frozen evidence", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(packageJson.dependencies["spectrum-ts"], "12.8.0");
  assert.equal(packageJson.dependencies["@photon-ai/advanced-imessage"], "2.1.0");
  assert.equal(packageJson.devDependencies["@photon-ai/cli"], "2.2.0");
  assert.equal(lock.packages["node_modules/spectrum-ts"].version, "12.8.0");
  assert.equal(lock.packages["node_modules/@photon-ai/advanced-imessage"].version, "2.1.0");
  assert.equal(lock.packages["node_modules/@photon-ai/cli"].version, "2.2.0");
});

test("outbound tapbacks require an explicit add or remove action", () => {
  for (const action of ["add", "remove"] as const) {
    const operation = {
      ...textOperation(0),
      name: "message.react" as const,
      input: {
        action,
        target: { ...chats[0], messageId: "message-a", partIndex: 0 },
        reaction: { kind: "like" as const },
      },
    };
    assert.deepEqual(parsePhotonPresentationOperation(operation), operation);
    for (const invalidAction of [undefined, "toggle", true]) {
      assert.throws(() =>
        parsePhotonPresentationOperation({ ...operation, input: { ...operation.input, action: invalidAction } }),
      );
    }
  }
});

test("the poll read port preserves the pinned SDK title, options, and current votes", async () => {
  const sdkAndPortAgree: Exact<Awaited<ReturnType<AdvancedIMessage["polls"]["get"]>>, PhotonPollState> &
    Exact<Awaited<ReturnType<AdvancedIMessageProviderClientPort["getPoll"]>>, PhotonPollState> = true;
  assert.equal(sdkAndPortAgree, true);
  const poll: Poll = {
    chatGuid: chats[1].conversationId,
    pollMessageGuid: "poll-guid",
    title: "Lunch?",
    options: [{ optionIdentifier: "pizza", text: "Pizza", creatorHandle: "owner@example.test" }],
    votes: [
      { optionIdentifier: "pizza", participant: { address: "voter@example.test", country: "US", service: "iMessage" } },
    ],
  };
  const client: Pick<AdvancedIMessageProviderClientPort, "getPoll"> = {
    async getPoll(conversation, pollMessageGuid) {
      assert.deepEqual(conversation, chats[1]);
      assert.equal(pollMessageGuid, poll.pollMessageGuid);
      return poll;
    },
  };
  assert.deepEqual(await client.getPoll(chats[1], "poll-guid"), poll);
});
