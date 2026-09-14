import type {
  ActionBinding,
  ConfirmedMessagePart,
  ConversationReference,
  InstallationDisplayStatus,
  InstallationReference,
  LineReference,
  MessagePartReference,
  MessageReference,
  NormalizedPhotonInput,
  PhotonOperationOutcome,
  PhotonOperationReference,
  PhotonPresentationOperation,
  PhotonReconciliationEvidence,
  ProviderActorReference,
  ProviderEventIdentity,
  ProviderScope,
} from "../../chassis/src/photon-contract.ts";
import { parsePhotonReconciliationEvidence } from "../../chassis/src/photon-contract.ts";
import type {
  ActionBindingConsumption,
  ActionBindingStorePort,
  CanonicalIdentityLookupPort,
  CapturedEventReceipt,
  DeliveryOperationRecord,
  DeliveryOperationStorePort,
  EventReceipt,
  InstallationRecord,
  InstallationStorePort,
  MessageBinding,
  MessageBindingStorePort,
  PollReference,
  PollReferenceStorePort,
  ProviderEventKey,
  ProviderLineScope,
  PublicCardHandle,
  PublicCardHandleStorePort,
  ReceiptRecoveryPage,
  ReceiptRecoveryQuery,
  RecoverableEventReceiptStorePort,
  ReceiptClaim,
  SpectrumProviderClientPort,
  TextStreamSessionRecord,
  TextStreamSessionStorePort,
} from "../src/ports.ts";

export const users = [
  { actorId: "provider-user", kind: "human", canonicalIdentityId: "qm-user-a", providerAddress: "+15550000001" },
  { actorId: "provider-user", kind: "human", canonicalIdentityId: "qm-user-b", providerAddress: "+15550000002" },
] as const satisfies readonly ProviderActorReference[];

export const installations = [
  { installationId: "installation-a", projectId: "project-shared" },
  { installationId: "installation-b", projectId: "project-shared" },
] as const satisfies readonly InstallationReference[];

export const lines = [
  {
    provider: "spectrum-imessage",
    installationId: installations[0].installationId,
    projectId: installations[0].projectId,
    lineId: "line-shared",
    maskedAddress: "+1•••0001",
  },
  {
    provider: "spectrum-imessage",
    installationId: installations[1].installationId,
    projectId: installations[1].projectId,
    lineId: "line-shared",
    maskedAddress: "+1•••0002",
  },
] as const satisfies readonly LineReference[];

export const chats = [
  { ...lines[0], conversationId: "chat-shared" },
  { ...lines[1], conversationId: "chat-shared" },
] as const satisfies readonly ConversationReference[];

export const providerEvents = [
  {
    provider: "spectrum-imessage",
    installationId: installations[0].installationId,
    eventId: "event-shared",
    lineId: lines[0].lineId,
    sequence: "101",
    occurredAt: "2026-09-10T12:00:00.000Z",
    direction: "inbound",
  },
  {
    provider: "spectrum-imessage",
    installationId: installations[1].installationId,
    eventId: "event-shared",
    lineId: lines[1].lineId,
    sequence: "101",
    occurredAt: "2026-09-10T12:00:00.000Z",
    direction: "inbound",
  },
] as const satisfies readonly ProviderEventIdentity[];

export const multipartMessages = [0, 1].map(
  (index) =>
    ({
      conversation: chats[index]!,
      messageId: "message-shared",
      parts: [
        { messageId: "part-text-shared", partIndex: 0 },
        { messageId: "part-file-shared", partIndex: 1 },
      ],
    }) satisfies MessageReference,
);

function part(index: 0 | 1, partIndex: 0 | 1): MessagePartReference {
  return { ...chats[index]!, ...multipartMessages[index]!.parts[partIndex]! };
}

export const normalizedInputs = [0, 1].map(
  (index) =>
    ({
      event: providerEvents[index]!,
      kind: "message",
      conversation: chats[index]!,
      actor: users[index]!,
      message: multipartMessages[index]!,
      content: [
        { kind: "text", part: multipartMessages[index]!.parts[0]!, text: "first part" },
        {
          kind: "attachment",
          attachment: {
            ...part(index as 0 | 1, 1),
            attachmentId: "attachment-shared",
            providerReference: "provider-attachment-shared",
            fileName: "one.png",
            mediaType: "image/png",
            byteLength: 128,
          },
        },
      ],
      replyTo: { ...chats[index]!, messageId: "message-parent", partIndex: 1 },
    }) satisfies NormalizedPhotonInput,
);

export const competingActions = [
  {
    bindingId: "binding-a",
    actor: users[0],
    resource: { resourceType: "approval", resourceId: "approval-a" },
    resourceRevision: "revision-1",
    allowedAction: "approval.resolve",
    expiresAt: "2026-09-10T13:00:00.000Z",
    session: { sessionId: "session-a" },
    conversation: chats[0],
  },
  {
    bindingId: "binding-a",
    actor: users[1],
    resource: { resourceType: "approval", resourceId: "approval-a" },
    resourceRevision: "revision-1",
    allowedAction: "approval.resolve",
    expiresAt: "2026-09-10T13:00:00.000Z",
    session: { sessionId: "session-a" },
    conversation: chats[1],
  },
] as const satisfies readonly ActionBinding[];

export function textOperation(
  index: 0 | 1,
  overrides: Partial<PhotonPresentationOperation> = {},
): PhotonPresentationOperation {
  return {
    operationId: "operation-shared",
    attemptId: "attempt-1",
    name: "message.text",
    conversation: chats[index],
    idempotencyKey: "logical-shared",
    input: { text: "hello" },
    ...overrides,
  } as PhotonPresentationOperation;
}

export function operationReference(operation: PhotonPresentationOperation): PhotonOperationReference {
  return {
    operationId: operation.operationId,
    name: operation.name,
    conversation: operation.conversation,
    idempotencyKey: operation.idempotencyKey,
  };
}

function sameScope(left: ProviderScope, right: ProviderScope): boolean {
  return left.provider === right.provider && left.installationId === right.installationId;
}

function sameConversation(left: ConversationReference, right: ConversationReference): boolean {
  return sameScope(left, right) && left.lineId === right.lineId && left.conversationId === right.conversationId;
}

function samePart(left: MessagePartReference, right: MessagePartReference): boolean {
  return sameConversation(left, right) && left.messageId === right.messageId && left.partIndex === right.partIndex;
}

function sameEvent(left: ProviderEventKey, right: ProviderEventKey): boolean {
  return sameScope(left, right) && left.lineId === right.lineId && left.eventId === right.eventId;
}

function sameOperation(left: PhotonPresentationOperation, right: PhotonPresentationOperation): boolean {
  return sameConversation(left.conversation, right.conversation) && left.idempotencyKey === right.idempotencyKey;
}

function samePayload(left: PhotonPresentationOperation, right: PhotonPresentationOperation): boolean {
  return left.name === right.name && sameJson(left.input, right.input);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    return `{${Object.keys(input)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameOperationReference(
  left: PhotonPresentationOperation | PhotonOperationReference,
  right: PhotonPresentationOperation | PhotonOperationReference,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.name === right.name &&
    left.idempotencyKey === right.idempotencyKey &&
    sameConversation(left.conversation, right.conversation)
  );
}

function operationReceiptMatches(operation: PhotonPresentationOperation, outcome: PhotonOperationOutcome): boolean {
  if (outcome.kind !== "confirmed-message" && outcome.kind !== "confirmed-no-message") return true;
  const receipt = outcome.providerReceipt;
  if (operation.conversation.provider === "advanced-imessage" && operation.name === "message.poll.create") {
    if (receipt?.receiptType !== "poll") return false;
    return (
      outcome.kind === "confirmed-message" &&
      receipt.pollMessageGuid === outcome.message.messageId &&
      receipt.optionIdentifiers.length === operation.input.options.length
    );
  }
  if (
    operation.conversation.provider === "advanced-imessage" &&
    (operation.name === "message.poll.vote" ||
      operation.name === "message.poll.unvote" ||
      operation.name === "message.poll.add-option")
  ) {
    return receipt?.receiptType === "poll" && receipt.pollMessageGuid === operation.input.pollMessageGuid;
  }
  if (operation.name === "message.app.send") {
    return (
      outcome.kind === "confirmed-message" &&
      receipt?.receiptType === "app-card" &&
      receipt.session.chatGuid === operation.conversation.conversationId &&
      receipt.session.messageGuid === outcome.message.messageId &&
      receipt.session.targetMessageGuid === outcome.message.messageId
    );
  }
  if (operation.name === "message.app.update") {
    if (receipt?.receiptType !== "app-card") return false;
    const handle = operation.input.handle;
    return (
      handle.cardId === operation.input.app.cardId &&
      receipt.session.chatGuid === operation.conversation.conversationId &&
      receipt.session.sessionId === handle.session.sessionId &&
      receipt.session.targetMessageGuid === handle.session.targetMessageGuid &&
      (outcome.kind !== "confirmed-message" || receipt.session.messageGuid === outcome.message.messageId)
    );
  }
  if (
    operation.conversation.provider === "advanced-imessage" &&
    ["conversation.rename", "conversation.membership.add", "conversation.membership.remove"].includes(operation.name)
  ) {
    if (receipt?.receiptType !== "chat" || receipt.chatGuid !== operation.conversation.conversationId) return false;
    if (operation.name === "conversation.rename") return receipt.displayName === operation.input.title;
    if (operation.name === "conversation.membership.add") {
      return operation.input.participantIds.every((participantId) => receipt.participantIds.includes(participantId));
    }
    if (operation.name === "conversation.membership.remove") {
      return operation.input.participantIds.every((participantId) => !receipt.participantIds.includes(participantId));
    }
  }
  return receipt === undefined;
}

function plannedPartCount(operation: PhotonPresentationOperation): number {
  if (operation.name === "message.multipart") return operation.input.parts.length;
  if (
    operation.conversation.provider === "spectrum-imessage" &&
    (operation.name === "message.app.update" || operation.name === "message.edit")
  )
    return 0;
  if (
    [
      "message.text",
      "message.markdown",
      "message.text.stream",
      "message.link",
      "message.attachment",
      "message.voice",
      "message.contact",
      "message.poll.create",
      "message.app.send",
      "message.react",
      ...(operation.conversation.provider === "advanced-imessage" ? ["message.app.update", "message.edit"] : []),
    ].includes(operation.name)
  )
    return 1;
  return 0;
}

function claimMatches(left: ReceiptClaim | undefined, right: ReceiptClaim): boolean {
  return left?.claimId === right.claimId && left.fence === right.fence && left.leaseExpiresAt === right.leaseExpiresAt;
}

function activeClaim(left: ReceiptClaim | undefined, right: ReceiptClaim, now: string): boolean {
  const nowMilliseconds = Date.parse(now);
  return (
    Number.isFinite(nowMilliseconds) &&
    new Date(nowMilliseconds).toISOString() === now &&
    claimMatches(left, right) &&
    left !== undefined &&
    Date.parse(left.leaseExpiresAt) > nowMilliseconds
  );
}

function canonicalSequence(value: string | undefined): boolean {
  return value !== undefined && /^(?:0|[1-9][0-9]*)$/u.test(value) && Number.isSafeInteger(Number(value));
}

export class FakeInstallationStore implements InstallationStorePort {
  readonly records = new Map<string, InstallationRecord>();

  async read(installationId: string): Promise<InstallationRecord | undefined> {
    return this.records.get(installationId);
  }

  async create(record: InstallationRecord): Promise<boolean> {
    if (!validInstallationRecord(record) || record.version !== 1) return false;
    if (this.records.has(record.installation.installationId)) return false;
    this.records.set(record.installation.installationId, record);
    return true;
  }

  async compareAndSet(installationId: string, expectedVersion: number, next: InstallationRecord): Promise<boolean> {
    if (
      this.records.get(installationId)?.version !== expectedVersion ||
      next.installation.installationId !== installationId ||
      next.version !== expectedVersion + 1 ||
      !validInstallationRecord(next)
    )
      return false;
    this.records.set(installationId, next);
    return true;
  }
}

function validInstallationRecord(record: InstallationRecord): boolean {
  if (record.status.installationId !== record.installation.installationId) return false;
  return record.status.state !== "connected" || record.status.projectId === record.installation.projectId;
}

export class FakeCanonicalIdentityLookup implements CanonicalIdentityLookupPort {
  async resolveActor(
    event: ProviderEventIdentity,
    actor: ProviderActorReference,
  ): Promise<ProviderActorReference | undefined> {
    return users.find(
      (candidate, index) =>
        candidate.actorId === actor.actorId &&
        installations[index]?.installationId === event.installationId &&
        lines[index]?.provider === event.provider,
    );
  }
}

export class FakeEventReceiptStore implements RecoverableEventReceiptStorePort {
  readonly receipts: EventReceipt[] = [];
  readonly checkpoints: Array<{ scope: ProviderLineScope; sequence: string; version: number }> = [];

  async capture(receipt: CapturedEventReceipt): Promise<"captured" | "duplicate" | "conflict"> {
    const input = receipt as unknown as Record<string, unknown>;
    if (
      receipt.state !== "captured" ||
      "claim" in input ||
      "checkpoint" in input ||
      "rejectionCode" in input ||
      Object.keys(input).some((key) => !["key", "sequence", "capturedAt", "payload", "state"].includes(key))
    )
      return "conflict";
    if (receipt.sequence !== undefined && !canonicalSequence(receipt.sequence)) return "conflict";
    if (receipt.payload.kind === "envelope") {
      const event = receipt.payload.envelope.event;
      if (
        event.provider !== receipt.key.provider ||
        event.installationId !== receipt.key.installationId ||
        event.eventId !== receipt.key.eventId ||
        event.lineId !== receipt.key.lineId ||
        event.sequence !== receipt.sequence
      )
        return "conflict";
    }
    const current = this.receipts.find((candidate) => sameEvent(candidate.key, receipt.key));
    if (current !== undefined)
      return current.sequence === receipt.sequence && sameJson(current.payload, receipt.payload)
        ? "duplicate"
        : "conflict";
    this.receipts.push(receipt);
    return "captured";
  }

  async claim(
    key: ProviderEventKey,
    claimantId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<EventReceipt | undefined> {
    const nowMilliseconds = Date.parse(now);
    const leaseMilliseconds = Date.parse(leaseExpiresAt);
    if (
      claimantId.trim().length === 0 ||
      !Number.isFinite(nowMilliseconds) ||
      !Number.isFinite(leaseMilliseconds) ||
      new Date(nowMilliseconds).toISOString() !== now ||
      new Date(leaseMilliseconds).toISOString() !== leaseExpiresAt ||
      leaseMilliseconds <= nowMilliseconds
    )
      return undefined;
    const index = this.receipts.findIndex((candidate) => sameEvent(candidate.key, key));
    const current = this.receipts[index];
    if (current === undefined || current.state === "checkpointed" || current.state === "rejected") return undefined;
    if (
      current.state === "processing" &&
      current.claim !== undefined &&
      Date.parse(current.claim.leaseExpiresAt) > nowMilliseconds
    )
      return undefined;
    const claim = { claimId: claimantId, fence: (current.claim?.fence ?? 0) + 1, leaseExpiresAt };
    const claimed = { ...current, state: "processing" as const, claim };
    this.receipts[index] = claimed;
    return claimed;
  }

  async discoverRecoverable(query: ReceiptRecoveryQuery): Promise<ReceiptRecoveryPage> {
    const now = Date.parse(query.now);
    if (!Number.isFinite(now) || new Date(now).toISOString() !== query.now) throw new TypeError("now is invalid");
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 128) {
      throw new TypeError("limit is invalid");
    }
    const eligible = this.receipts
      .filter(
        (receipt) =>
          receipt.key.provider === query.provider &&
          receipt.key.installationId === query.installationId &&
          receipt.key.lineId === query.lineId &&
          (receipt.state === "captured" ||
            (receipt.state === "processing" &&
              receipt.claim !== undefined &&
              Date.parse(receipt.claim.leaseExpiresAt) <= now)),
      )
      .sort(
        (left, right) =>
          left.capturedAt.localeCompare(right.capturedAt) || left.key.eventId.localeCompare(right.key.eventId),
      )
      .filter(
        (receipt) =>
          query.after === undefined ||
          receipt.capturedAt > query.after.capturedAt ||
          (receipt.capturedAt === query.after.capturedAt && receipt.key.eventId > query.after.eventId),
      );
    const receipts = eligible.slice(0, query.limit);
    const last = receipts.at(-1);
    return {
      receipts,
      ...(eligible.length > query.limit && last
        ? { next: { capturedAt: last.capturedAt, eventId: last.key.eventId } }
        : {}),
    };
  }

  async completeWithoutSequence(key: ProviderEventKey, claim: ReceiptClaim, now: string): Promise<boolean> {
    const index = this.receipts.findIndex((candidate) => sameEvent(candidate.key, key));
    const current = this.receipts[index];
    if (
      current === undefined ||
      current.state !== "processing" ||
      !activeClaim(current.claim, claim, now) ||
      current.sequence !== undefined
    )
      return false;
    this.receipts[index] = { ...current, state: "checkpointed" };
    return true;
  }

  async rejectWithoutSequence(
    key: ProviderEventKey,
    claim: ReceiptClaim,
    now: string,
    safeCode: string,
  ): Promise<boolean> {
    if (typeof safeCode !== "string" || safeCode.trim().length === 0) return false;
    const index = this.receipts.findIndex((candidate) => sameEvent(candidate.key, key));
    const current = this.receipts[index];
    if (
      current === undefined ||
      current.state !== "processing" ||
      !activeClaim(current.claim, claim, now) ||
      current.sequence !== undefined
    )
      return false;
    this.receipts[index] = { ...current, state: "rejected", rejectionCode: safeCode };
    return true;
  }

  async rejectAndAdvanceContiguousCheckpoint(
    key: ProviderEventKey & ProviderLineScope,
    expectedVersion: number,
    nextSequence: string,
    claim: ReceiptClaim,
    now: string,
    safeCode: string,
  ): Promise<boolean> {
    return this.finishSequenced(key, expectedVersion, nextSequence, claim, now, "rejected", safeCode);
  }

  async read(key: ProviderEventKey): Promise<EventReceipt | undefined> {
    return this.receipts.find((candidate) => sameEvent(candidate.key, key));
  }

  async readContiguousCheckpoint(scope: ProviderLineScope) {
    return this.checkpoints.find(
      (checkpoint) => sameScope(checkpoint.scope, scope) && checkpoint.scope.lineId === scope.lineId,
    );
  }

  async advanceContiguousCheckpoint(
    key: ProviderEventKey & ProviderLineScope,
    expectedVersion: number,
    nextSequence: string,
    claim: ReceiptClaim,
    now: string,
  ): Promise<boolean> {
    return this.finishSequenced(key, expectedVersion, nextSequence, claim, now, "checkpointed");
  }

  private finishSequenced(
    key: ProviderEventKey & ProviderLineScope,
    expectedVersion: number,
    nextSequence: string,
    claim: ReceiptClaim,
    now: string,
    state: "checkpointed" | "rejected",
    rejectionCode?: string,
  ): boolean {
    if (state === "rejected" && (typeof rejectionCode !== "string" || rejectionCode.trim().length === 0)) return false;
    const receiptIndex = this.receipts.findIndex((candidate) => sameEvent(candidate.key, key));
    const receipt = this.receipts[receiptIndex];
    if (
      receipt === undefined ||
      receipt.state !== "processing" ||
      !activeClaim(receipt.claim, claim, now) ||
      receipt.sequence !== nextSequence
    )
      return false;
    if (!canonicalSequence(nextSequence)) return false;
    const scope = { provider: key.provider, installationId: key.installationId, lineId: key.lineId };
    const current = this.checkpoints.find(
      (checkpoint) => sameScope(checkpoint.scope, scope) && checkpoint.scope.lineId === scope.lineId,
    );
    if ((current?.version ?? 0) !== expectedVersion) return false;
    if (current !== undefined && Number(nextSequence) !== Number(current.sequence) + 1) return false;
    if (
      current === undefined &&
      this.receipts.some(
        (candidate) =>
          sameScope(candidate.key, scope) &&
          candidate.key.lineId === scope.lineId &&
          candidate.sequence !== undefined &&
          Number(candidate.sequence) < Number(nextSequence),
      )
    )
      return false;
    if (current === undefined) this.checkpoints.push({ scope, sequence: nextSequence, version: 1 });
    else Object.assign(current, { sequence: nextSequence, version: current.version + 1 });
    if (state === "rejected") {
      this.receipts[receiptIndex] = { ...receipt, state, checkpoint: nextSequence, rejectionCode: rejectionCode! };
    } else {
      this.receipts[receiptIndex] = { ...receipt, state, checkpoint: nextSequence };
    }
    return true;
  }
}

export class FakeTextStreamSessionStore implements TextStreamSessionStorePort {
  readonly sessions: TextStreamSessionRecord[] = [];

  async create(
    operation: Extract<PhotonPresentationOperation, { name: "message.text.stream" }>,
  ): Promise<"created" | "duplicate" | "conflict"> {
    const current = this.sessions.find((session) => sameOperation(session.operation, operation));
    if (current !== undefined) return samePayload(current.operation, operation) ? "duplicate" : "conflict";
    this.sessions.push({ operation, chunks: [], state: "open", version: 1 });
    return "created";
  }

  async append(
    operation: Extract<PhotonPresentationOperation, { name: "message.text.stream" }>,
    expectedVersion: number,
    chunk: string,
  ): Promise<TextStreamSessionRecord | undefined> {
    const index = this.sessions.findIndex((session) => sameOperation(session.operation, operation));
    const current = this.sessions[index];
    if (
      current === undefined ||
      current.state !== "open" ||
      current.version !== expectedVersion ||
      chunk.length === 0 ||
      !samePayload(current.operation, operation)
    )
      return undefined;
    const next = { ...current, chunks: [...current.chunks, chunk], version: current.version + 1 };
    this.sessions[index] = next;
    return next;
  }

  async finalize(
    operation: Extract<PhotonPresentationOperation, { name: "message.text.stream" }>,
    expectedVersion: number,
  ): Promise<TextStreamSessionRecord | undefined> {
    const index = this.sessions.findIndex((session) => sameOperation(session.operation, operation));
    const current = this.sessions[index];
    if (
      current === undefined ||
      current.state !== "open" ||
      current.version !== expectedVersion ||
      current.chunks.length === 0 ||
      !samePayload(current.operation, operation)
    )
      return undefined;
    const next = { ...current, state: "finalized" as const, version: current.version + 1 };
    this.sessions[index] = next;
    return next;
  }

  async read(
    operation: Extract<PhotonPresentationOperation, { name: "message.text.stream" }>,
  ): Promise<TextStreamSessionRecord | undefined> {
    return this.sessions.find((session) => sameOperation(session.operation, operation));
  }
}

export class FakeMessageBindingStore implements MessageBindingStorePort {
  readonly bindings: MessageBinding[] = [];

  async bind(binding: MessageBinding): Promise<"bound" | "duplicate" | "conflict"> {
    const incomingParts = binding.providerMessage.parts.map((part) =>
      JSON.stringify([
        binding.providerMessage.conversation.provider,
        binding.providerMessage.conversation.installationId,
        binding.providerMessage.conversation.lineId,
        binding.providerMessage.conversation.conversationId,
        part.messageId,
        part.partIndex,
      ]),
    );
    if (new Set(incomingParts).size !== incomingParts.length) return "conflict";
    const overlapping = [
      ...new Set(
        binding.providerMessage.parts
          .map((identity) => ({ ...binding.providerMessage.conversation, ...identity }))
          .flatMap((reference) => this.bindings.filter((candidate) => this.bindingContains(candidate, reference))),
      ),
    ];
    if (overlapping.length === 0) {
      this.bindings.push(binding);
      return "bound";
    }
    return overlapping.length === 1 && sameJson(overlapping[0], binding) ? "duplicate" : "conflict";
  }

  async findByProviderPart(reference: MessagePartReference): Promise<MessageBinding | undefined> {
    return this.bindings.find((binding) => this.bindingContains(binding, reference));
  }

  async findByQmEntry(qmSessionId: string, qmEntrySequence: number): Promise<readonly MessageBinding[]> {
    return this.bindings.filter(
      (binding) => binding.qmSessionId === qmSessionId && binding.qmEntrySequence === qmEntrySequence,
    );
  }

  private bindingContains(binding: MessageBinding, reference: MessagePartReference): boolean {
    return (
      sameConversation(binding.providerMessage.conversation, reference) &&
      binding.providerMessage.parts.some(
        (identity) => identity.messageId === reference.messageId && identity.partIndex === reference.partIndex,
      )
    );
  }
}

export class FakePollReferenceStore implements PollReferenceStorePort {
  readonly references: PollReference[] = [];

  async put(reference: PollReference): Promise<"stored" | "duplicate" | "conflict"> {
    const current = await this.read(reference.conversation, reference.pollMessageGuid);
    if (current !== undefined) return sameJson(current, reference) ? "duplicate" : "conflict";
    if (reference.version !== 1 || !validPollReference(reference)) return "conflict";
    this.references.push(reference);
    return "stored";
  }

  async replace(reference: PollReference, expectedVersion: number): Promise<boolean> {
    const index = this.references.findIndex(
      (candidate) =>
        sameConversation(candidate.conversation, reference.conversation) &&
        candidate.pollMessageGuid === reference.pollMessageGuid,
    );
    const current = this.references[index];
    if (
      current?.version !== expectedVersion ||
      reference.version !== expectedVersion + 1 ||
      !validPollReference(reference)
    )
      return false;
    this.references[index] = reference;
    return true;
  }

  async read(conversation: ConversationReference, pollMessageGuid: string): Promise<PollReference | undefined> {
    return this.references.find(
      (reference) =>
        sameConversation(reference.conversation, conversation) && reference.pollMessageGuid === pollMessageGuid,
    );
  }
}

function validPollReference(reference: PollReference): boolean {
  return (
    reference.pollMessageGuid.trim().length > 0 &&
    reference.optionIdentifiers.length > 0 &&
    reference.optionIdentifiers.every((identifier) => identifier.trim().length > 0) &&
    new Set(reference.optionIdentifiers).size === reference.optionIdentifiers.length
  );
}

export class FakePublicCardHandleStore implements PublicCardHandleStorePort {
  readonly handles: PublicCardHandle[] = [];

  async put(handle: PublicCardHandle): Promise<"stored" | "duplicate" | "conflict"> {
    const current = await this.read(handle.conversation, handle.cardId);
    if (current !== undefined) return sameJson(current, handle) ? "duplicate" : "conflict";
    if (handle.version !== 1 || !validPublicCardHandle(handle)) return "conflict";
    this.handles.push(handle);
    return "stored";
  }

  async replace(handle: PublicCardHandle, expectedVersion: number): Promise<boolean> {
    const index = this.handles.findIndex(
      (candidate) =>
        sameConversation(candidate.conversation, handle.conversation) && candidate.cardId === handle.cardId,
    );
    const current = this.handles[index];
    if (
      current?.version !== expectedVersion ||
      handle.version !== expectedVersion + 1 ||
      !validPublicCardHandle(handle) ||
      handle.handle.session.sessionId !== current.handle.session.sessionId ||
      handle.handle.session.targetMessageGuid !== current.handle.session.targetMessageGuid
    )
      return false;
    this.handles[index] = handle;
    return true;
  }

  async read(conversation: ConversationReference, cardId: string): Promise<PublicCardHandle | undefined> {
    return this.handles.find(
      (handle) => sameConversation(handle.conversation, conversation) && handle.cardId === cardId,
    );
  }
}

function validPublicCardHandle(record: PublicCardHandle): boolean {
  const { conversation, handle } = record;
  if (handle.cardId !== record.cardId || handle.provider !== conversation.provider) return false;
  if (handle.session.chatGuid !== conversation.conversationId) return false;
  return (
    handle.provider !== "spectrum-imessage" ||
    (sameConversation(handle.target, conversation) && handle.session.targetMessageGuid === handle.target.messageId)
  );
}

function preservesConfirmedParts(
  current: DeliveryOperationRecord,
  evidenceParts: readonly ConfirmedMessagePart[],
): boolean {
  return current.parts
    .filter((part) => part.state === "confirmed")
    .every(
      (part) =>
        part.providerPart !== undefined &&
        evidenceParts.some(
          (candidate) => candidate.logicalPartIndex === part.partIndex && samePart(candidate.part, part.providerPart!),
        ),
    );
}

export class FakeDeliveryOperationStore implements DeliveryOperationStorePort {
  readonly operations: DeliveryOperationRecord[] = [];

  async reserve(operation: PhotonPresentationOperation): Promise<"reserved" | "duplicate" | "conflict"> {
    const current = this.operations.find((candidate) => sameOperation(candidate.operation, operation));
    if (current !== undefined) return samePayload(current.operation, operation) ? "duplicate" : "conflict";
    const parts = Array.from({ length: plannedPartCount(operation) }, (_, partIndex) => ({
      partId: JSON.stringify([
        operation.conversation.provider,
        operation.conversation.installationId,
        operation.conversation.lineId,
        operation.conversation.conversationId,
        operation.idempotencyKey,
        partIndex,
      ]),
      partIndex,
      state: "reserved" as const,
      dispatchFence: 0,
    }));
    this.operations.push({
      operation,
      attempts: [{ operationId: operation.operationId, attemptId: operation.attemptId }],
      parts,
      state: "reserved",
      dispatchFence: 0,
      version: 1,
    });
    return "reserved";
  }

  async markDispatched(
    operation: PhotonPresentationOperation,
    expectedVersion: number,
  ): Promise<DeliveryOperationRecord | undefined> {
    const index = this.operations.findIndex((candidate) => sameOperation(candidate.operation, operation));
    const current = this.operations[index];
    if (
      current === undefined ||
      current.state !== "reserved" ||
      current.version !== expectedVersion ||
      !samePayload(current.operation, operation)
    )
      return undefined;
    const dispatchFence = current.dispatchFence + 1;
    const dispatched = {
      ...current,
      operation,
      state: "dispatched" as const,
      dispatchFence,
      parts: current.parts.map((part) =>
        part.state === "confirmed" ? part : { ...part, state: "dispatched" as const, dispatchFence },
      ),
      version: current.version + 1,
    };
    this.operations[index] = dispatched;
    return dispatched;
  }

  async retry(
    operation: PhotonPresentationOperation,
    expectedVersion: number,
  ): Promise<DeliveryOperationRecord | undefined> {
    const index = this.operations.findIndex((candidate) => sameOperation(candidate.operation, operation));
    const current = this.operations[index];
    if (
      current === undefined ||
      current.state !== "failed" ||
      current.version !== expectedVersion ||
      current.outcome?.kind !== "failed" ||
      !current.outcome.retryable ||
      current.attempts.some(
        (attempt) => attempt.operationId === operation.operationId || attempt.attemptId === operation.attemptId,
      ) ||
      !samePayload(current.operation, operation)
    )
      return undefined;
    const { outcome: _outcome, ...retryableRecord } = current;
    const reserved = {
      ...retryableRecord,
      operation,
      attempts: [...current.attempts, { operationId: operation.operationId, attemptId: operation.attemptId }],
      state: "reserved" as const,
      parts: current.parts.map((part) => {
        if (part.state === "confirmed") return part;
        const { providerPart: _providerPart, ...retryablePart } = part;
        return { ...retryablePart, state: "reserved" as const };
      }),
      version: current.version + 1,
    };
    this.operations[index] = reserved;
    return reserved;
  }

  async complete(
    operation: PhotonPresentationOperation,
    dispatchFence: number,
    outcome: PhotonOperationOutcome,
  ): Promise<boolean> {
    const index = this.operations.findIndex((candidate) => sameOperation(candidate.operation, operation));
    const current = this.operations[index];
    if (
      current === undefined ||
      current.state !== "dispatched" ||
      current.dispatchFence !== dispatchFence ||
      !sameOperationReference(current.operation, operation) ||
      !sameOperationReference(current.operation, outcome.operation) ||
      !operationReceiptMatches(operation, outcome)
    )
      return false;
    if (outcome.kind === "confirmed-message" && outcome.confirmedParts.length !== current.parts.length) return false;
    if (outcome.kind === "confirmed-no-message" && current.parts.length !== 0) return false;
    const state =
      outcome.kind === "confirmed-message" || outcome.kind === "confirmed-no-message" ? "confirmed" : outcome.kind;
    const confirmed =
      outcome.kind === "confirmed-no-message" || outcome.kind === "unsupported" ? [] : outcome.confirmedParts;
    if (!preservesConfirmedParts(current, confirmed)) return false;
    if (confirmed.some((part) => part.logicalPartIndex >= current.parts.length)) return false;
    const parts = current.parts.map((part) => {
      const expectedProviderPart =
        outcome.kind === "confirmed-message"
          ? outcome.message.parts[part.partIndex]
          : confirmed.find((candidate) => candidate.logicalPartIndex === part.partIndex)?.part;
      const providerPart =
        expectedProviderPart === undefined
          ? undefined
          : confirmed.find(
              (candidate) =>
                candidate.logicalPartIndex === part.partIndex &&
                samePart(candidate.part, { ...outcome.operation.conversation, ...expectedProviderPart }),
            )?.part;
      if (providerPart !== undefined) return { ...part, state: "confirmed" as const, providerPart };
      if (part.state === "confirmed") return part;
      if (outcome.kind === "unsupported") return { ...part, state: "unsupported" as const };
      if (outcome.kind === "ambiguous") return { ...part, state: "ambiguous" as const };
      if (outcome.kind === "failed") return { ...part, state: "failed" as const };
      return part;
    });
    this.operations[index] = { ...current, parts, state, outcome, version: current.version + 1 };
    return true;
  }

  async reconcile(evidence: PhotonReconciliationEvidence, expectedVersion: number): Promise<boolean> {
    try {
      parsePhotonReconciliationEvidence(evidence);
    } catch {
      return false;
    }
    const index = this.operations.findIndex((candidate) =>
      sameOperationReference(candidate.operation, evidence.operation),
    );
    const current = this.operations[index];
    if (
      current === undefined ||
      current.state !== "ambiguous" ||
      current.version !== expectedVersion ||
      !sameOperationReference(evidence.operation, evidence.outcome.operation) ||
      !operationReceiptMatches(current.operation, evidence.outcome)
    )
      return false;
    const evidenceParts = evidence.outcome.kind === "confirmed-no-message" ? [] : evidence.outcome.confirmedParts;
    if (evidence.outcome.kind === "confirmed-message") {
      const indexes = new Set(evidenceParts.map((part) => part.logicalPartIndex));
      if (
        evidenceParts.length !== current.parts.length ||
        indexes.size !== current.parts.length ||
        current.parts.some((part) => !indexes.has(part.partIndex))
      )
        return false;
    }
    if (evidence.outcome.kind === "confirmed-no-message" && current.parts.length !== 0) return false;
    if (!preservesConfirmedParts(current, evidenceParts)) return false;
    const state = evidence.outcome.kind === "failed" ? "failed" : "confirmed";
    if (evidenceParts.some((part) => part.logicalPartIndex >= current.parts.length)) return false;
    const parts = current.parts.map((part) => {
      const providerPart = evidenceParts.find((candidate) => candidate.logicalPartIndex === part.partIndex)?.part;
      if (providerPart !== undefined) return { ...part, state: "confirmed" as const, providerPart };
      return evidence.outcome.kind === "failed" ? { ...part, state: "failed" as const } : part;
    });
    this.operations[index] = { ...current, parts, state, outcome: evidence.outcome, version: current.version + 1 };
    return true;
  }

  async read(operation: PhotonPresentationOperation): Promise<DeliveryOperationRecord | undefined> {
    return this.operations.find((candidate) => sameOperation(candidate.operation, operation));
  }
}

export class FakeActionBindingStore implements ActionBindingStorePort {
  readonly bindings: ActionBinding[] = [];
  readonly consumed = new Set<string>();

  private key(conversation: ConversationReference, bindingId: string): string {
    return JSON.stringify([
      conversation.provider,
      conversation.installationId,
      conversation.lineId,
      conversation.conversationId,
      bindingId,
    ]);
  }

  async create(binding: ActionBinding): Promise<"created" | "duplicate" | "conflict"> {
    const current = this.bindings.find(
      (candidate) =>
        candidate.bindingId === binding.bindingId && sameConversation(candidate.conversation, binding.conversation),
    );
    if (current !== undefined) return sameJson(current, binding) ? "duplicate" : "conflict";
    this.bindings.push(binding);
    return "created";
  }

  async consume(request: ActionBindingConsumption): Promise<ActionBinding | undefined> {
    const key = this.key(request.conversation, request.bindingId);
    const binding = this.bindings.find(
      (candidate) =>
        candidate.bindingId === request.bindingId && sameConversation(candidate.conversation, request.conversation),
    );
    const parsedNow = Date.parse(request.now);
    if (
      binding === undefined ||
      this.consumed.has(key) ||
      binding.actor.actorId !== request.actor.actorId ||
      binding.actor.kind !== request.actor.kind ||
      binding.actor.canonicalIdentityId !== request.actor.canonicalIdentityId ||
      binding.actor.providerAddress !== request.actor.providerAddress ||
      binding.resource.resourceType !== request.resourceType ||
      binding.resource.resourceId !== request.resourceId ||
      binding.resourceRevision !== request.resourceRevision ||
      binding.allowedAction !== request.allowedAction ||
      binding.session.sessionId !== request.sessionId ||
      !sameConversation(binding.conversation, request.conversation) ||
      !Number.isFinite(parsedNow) ||
      new Date(parsedNow).toISOString() !== request.now ||
      Date.parse(binding.expiresAt) <= parsedNow
    )
      return undefined;
    this.consumed.add(key);
    return binding;
  }

  async read(conversation: ConversationReference, bindingId: string): Promise<ActionBinding | undefined> {
    return this.bindings.find(
      (candidate) => candidate.bindingId === bindingId && sameConversation(candidate.conversation, conversation),
    );
  }
}

export function fakeSpectrumProvider(outcome: PhotonOperationOutcome): SpectrumProviderClientPort {
  return {
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async resolveConversation(line: LineReference, participantIds: readonly string[]): Promise<ConversationReference> {
      return { ...line, conversationId: JSON.stringify(participantIds) };
    },
    async deliver(): Promise<PhotonOperationOutcome> {
      return outcome;
    },
    async streamText(): Promise<PhotonOperationOutcome> {
      return outcome;
    },
    async fetchAttachment(): Promise<Uint8Array> {
      return new Uint8Array([1, 2, 3]);
    },
  };
}

export function connectedStatus(index: 0 | 1): InstallationDisplayStatus {
  return {
    state: "connected",
    installationId: installations[index].installationId,
    projectId: installations[index].projectId!,
    lines: [{ lineId: lines[index].lineId, maskedAddress: lines[index].maskedAddress }],
  };
}
