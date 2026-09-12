import {
  PHOTON_PROVIDER_NAMES,
  assertJsonSafe,
  parseActionBinding,
  parseInstallationReference,
  parseNormalizedPhotonInput,
  parsePhotonOperationOutcome,
  parsePhotonPresentationOperation,
  projectInstallationForDashboard,
  type ConversationReference,
  type MessagePartReference,
  type PhotonOperationOutcome,
  type PhotonPresentationOperation,
  type ProviderScope,
} from "./photon-contract.ts";
import type {
  ActionBindingStorePort,
  AttachmentRecord,
  ChatSessionBinding,
  ContiguousCheckpoint,
  DeliveryOperationRecord,
  EventReceipt,
  InstallationRecord,
  MessageBinding,
  PollReference,
  PublicCardHandle,
  TextStreamSessionRecord,
  VerifiedAddressChallenge,
} from "../../photon/src/ports.ts";

export const PHOTON_STATE_RECORD_VERSION = 1;

export type PhotonStateRecordKind =
  | "installation"
  | "verified-address-challenge"
  | "chat-session-binding"
  | "message-binding"
  | "attachment"
  | "event-receipt"
  | "checkpoint"
  | "delivery-operation"
  | "text-stream-session"
  | "poll-reference"
  | "card-handle"
  | "action-binding";

export interface SerializedPhotonStateRecord<T = unknown> {
  kind: PhotonStateRecordKind;
  recordVersion: typeof PHOTON_STATE_RECORD_VERSION;
  value: T;
}

type PhotonStateRecordValues = {
  installation: InstallationRecord;
  "verified-address-challenge": VerifiedAddressChallenge;
  "chat-session-binding": ChatSessionBinding;
  "message-binding": MessageBinding;
  attachment: AttachmentRecord;
  "event-receipt": EventReceipt;
  checkpoint: ContiguousCheckpoint;
  "delivery-operation": DeliveryOperationRecord;
  "text-stream-session": TextStreamSessionRecord;
  "poll-reference": PollReference;
  "card-handle": PublicCardHandle;
  "action-binding": Parameters<ActionBindingStorePort["create"]>[0];
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new TypeError(`${label} contains unsupported fields: ${unexpected.join(",")}`);
}

function string(value: Record<string, unknown>, field: string, label: string): string {
  const current = value[field];
  if (typeof current !== "string" || current.trim().length === 0) {
    throw new TypeError(`${label}.${field} must be a non-empty string`);
  }
  return current;
}

function optionalString(value: Record<string, unknown>, field: string, label: string): string | undefined {
  const current = value[field];
  if (current === undefined) return undefined;
  return string(value, field, label);
}

function integer(value: Record<string, unknown>, field: string, minimum: number, label: string): number {
  const current = value[field];
  if (typeof current !== "number" || !Number.isSafeInteger(current) || current < minimum) {
    throw new TypeError(`${label}.${field} must be a safe integer greater than or equal to ${minimum}`);
  }
  return current;
}

function timestamp(value: Record<string, unknown>, field: string, label: string): string {
  const current = string(value, field, label);
  const milliseconds = Date.parse(current);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== current) {
    throw new TypeError(`${label}.${field} must be a canonical ISO timestamp`);
  }
  return current;
}

function optionalTimestamp(value: Record<string, unknown>, field: string, label: string): string | undefined {
  if (value[field] === undefined) return undefined;
  return timestamp(value, field, label);
}

export function canonicalSequence(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new TypeError(`${label} must be a canonical non-negative safe integer string`);
  }
  return value;
}

function optionalCanonicalSequence(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : canonicalSequence(value, label);
}

function providerScope(value: unknown, label: string): ProviderScope {
  const input = object(value, label);
  const provider = string(input, "provider", label);
  if (!(PHOTON_PROVIDER_NAMES as readonly string[]).includes(provider))
    throw new TypeError(`${label}.provider is unsupported`);
  string(input, "installationId", label);
  return value as ProviderScope;
}

export function validateConversationReference(value: unknown, label = "conversation"): ConversationReference {
  const input = object(value, label);
  keys(input, ["provider", "installationId", "projectId", "lineId", "maskedAddress", "conversationId"], label);
  providerScope(input, label);
  optionalString(input, "projectId", label);
  string(input, "lineId", label);
  optionalString(input, "maskedAddress", label);
  string(input, "conversationId", label);
  return value as ConversationReference;
}

export function sameProviderScope(left: ProviderScope, right: ProviderScope): boolean {
  return left.provider === right.provider && left.installationId === right.installationId;
}

export function sameConversation(left: ConversationReference, right: ConversationReference): boolean {
  return sameProviderScope(left, right) && left.lineId === right.lineId && left.conversationId === right.conversationId;
}

export function samePart(left: MessagePartReference, right: MessagePartReference): boolean {
  return sameConversation(left, right) && left.messageId === right.messageId && left.partIndex === right.partIndex;
}

export function canonicalJson(value: unknown): string {
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

export function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function jsonbSafe(value: unknown, label: string): void {
  if (typeof value === "string") {
    if (value.includes("\u0000")) throw new TypeError(`${label} contains a NUL character`);
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${label} contains an unpaired surrogate`);
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new TypeError(`${label} contains an unpaired surrogate`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => jsonbSafe(item, `${label}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      jsonbSafe(key, `${label}.key`);
      jsonbSafe(item, `${label}.${key}`);
    }
  }
}

function validateInstallationRecord(value: unknown): InstallationRecord {
  assertJsonSafe(value, "installationRecord");
  const input = object(value, "installationRecord");
  keys(input, ["installation", "status", "ownerRevision", "version"], "installationRecord");
  const installation = parseInstallationReference(input.installation);
  const status = object(input.status, "installationRecord.status");
  keys(
    status,
    [
      "state",
      "installationId",
      "projectId",
      "lines",
      "userCode",
      "verificationUrl",
      "expiresAt",
      "safeCode",
      "management",
      "managementOrigin",
      "runtime",
    ],
    "installationRecord.status",
  );
  if (
    ![
      "not-started",
      "awaiting-authorization",
      "provisioning",
      "needs-owner-rebind",
      "needs-credential-repair",
      "connected",
      "failed",
    ].includes(status.state as string)
  ) {
    throw new TypeError("installation status state is unsupported");
  }
  if (status.installationId !== installation.installationId)
    throw new TypeError("installation record identity mismatch");
  if (status.management !== undefined) {
    const management = object(status.management, "installationRecord.status.management");
    keys(management, ["credentialPath"], "installationRecord.status.management");
    string(management, "credentialPath", "installationRecord.status.management");
  }
  if (status.runtime !== undefined) {
    const runtime = object(status.runtime, "installationRecord.status.runtime");
    keys(runtime, ["credentialCiphertext"], "installationRecord.status.runtime");
    string(runtime, "credentialCiphertext", "installationRecord.status.runtime");
  }
  optionalString(status, "managementOrigin", "installationRecord.status");
  const display = projectInstallationForDashboard(input.status as never);
  if (display.state !== status.state) throw new TypeError("installation status state is unsupported");
  const normalizedStatus = {
    ...display,
    ...(status.management === undefined ? {} : { management: status.management }),
    ...(status.managementOrigin === undefined ? {} : { managementOrigin: status.managementOrigin }),
    ...(status.runtime === undefined ? {} : { runtime: status.runtime }),
  };
  if (!sameJson(status, normalizedStatus))
    throw new TypeError("installation status contains state-incompatible fields");
  if (display.state === "connected" && installation.projectId !== display.projectId) {
    throw new TypeError("connected installation project mismatch");
  }
  string(input, "ownerRevision", "installationRecord");
  integer(input, "version", 1, "installationRecord");
  return value as unknown as InstallationRecord;
}

function validateChallenge(value: unknown): VerifiedAddressChallenge {
  assertJsonSafe(value, "verifiedAddressChallenge");
  const input = object(value, "verifiedAddressChallenge");
  keys(
    input,
    ["challengeId", "installationId", "addressCiphertext", "expiresAt", "verifiedAt", "version"],
    "verifiedAddressChallenge",
  );
  string(input, "challengeId", "verifiedAddressChallenge");
  string(input, "installationId", "verifiedAddressChallenge");
  string(input, "addressCiphertext", "verifiedAddressChallenge");
  timestamp(input, "expiresAt", "verifiedAddressChallenge");
  optionalTimestamp(input, "verifiedAt", "verifiedAddressChallenge");
  integer(input, "version", 1, "verifiedAddressChallenge");
  return value as unknown as VerifiedAddressChallenge;
}

function validateChatBinding(value: unknown): ChatSessionBinding {
  assertJsonSafe(value, "chatSessionBinding");
  const input = object(value, "chatSessionBinding");
  keys(input, ["conversation", "qmSessionId", "resourceRevision"], "chatSessionBinding");
  validateConversationReference(input.conversation, "chatSessionBinding.conversation");
  string(input, "qmSessionId", "chatSessionBinding");
  string(input, "resourceRevision", "chatSessionBinding");
  return value as unknown as ChatSessionBinding;
}

function validateMessagePartIdentity(value: unknown, label: string): { messageId: string; partIndex: number } {
  const input = object(value, label);
  keys(input, ["messageId", "partIndex"], label);
  string(input, "messageId", label);
  integer(input, "partIndex", 0, label);
  return value as { messageId: string; partIndex: number };
}

function validateMessagePartReference(value: unknown, label: string): MessagePartReference {
  const input = object(value, label);
  keys(
    input,
    ["provider", "installationId", "projectId", "lineId", "maskedAddress", "conversationId", "messageId", "partIndex"],
    label,
  );
  validateConversationReference(
    {
      provider: input.provider,
      installationId: input.installationId,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      lineId: input.lineId,
      ...(input.maskedAddress !== undefined ? { maskedAddress: input.maskedAddress } : {}),
      conversationId: input.conversationId,
    },
    label,
  );
  string(input, "messageId", label);
  integer(input, "partIndex", 0, label);
  return value as MessagePartReference;
}

function validateMessageBinding(value: unknown): MessageBinding {
  assertJsonSafe(value, "messageBinding");
  const input = object(value, "messageBinding");
  keys(input, ["providerMessage", "qmSessionId", "qmEntrySequence", "resourceRevision"], "messageBinding");
  const message = object(input.providerMessage, "messageBinding.providerMessage");
  keys(message, ["conversation", "messageId", "parts"], "messageBinding.providerMessage");
  validateConversationReference(message.conversation, "messageBinding.providerMessage.conversation");
  string(message, "messageId", "messageBinding.providerMessage");
  if (!Array.isArray(message.parts) || message.parts.length === 0) {
    throw new TypeError("messageBinding.providerMessage.parts must be a non-empty array");
  }
  const identities = message.parts.map((part, index) =>
    validateMessagePartIdentity(part, `messageBinding.providerMessage.parts[${index}]`),
  );
  if (new Set(identities.map((part) => `${part.messageId}\u0000${part.partIndex}`)).size !== identities.length) {
    throw new TypeError("messageBinding.providerMessage.parts must be unique");
  }
  string(input, "qmSessionId", "messageBinding");
  integer(input, "qmEntrySequence", 0, "messageBinding");
  string(input, "resourceRevision", "messageBinding");
  return value as unknown as MessageBinding;
}

function validateAttachment(value: unknown): AttachmentRecord {
  assertJsonSafe(value, "attachmentRecord");
  const input = object(value, "attachmentRecord");
  keys(input, ["reference", "storageReference", "state"], "attachmentRecord");
  const reference = object(input.reference, "attachmentRecord.reference");
  keys(
    reference,
    [
      "provider",
      "installationId",
      "projectId",
      "lineId",
      "maskedAddress",
      "conversationId",
      "messageId",
      "partIndex",
      "attachmentId",
      "providerReference",
      "fileName",
      "mediaType",
      "byteLength",
    ],
    "attachmentRecord.reference",
  );
  validateMessagePartReference(
    Object.fromEntries(
      Object.entries(reference).filter(([key]) =>
        [
          "provider",
          "installationId",
          "projectId",
          "lineId",
          "maskedAddress",
          "conversationId",
          "messageId",
          "partIndex",
        ].includes(key),
      ),
    ),
    "attachmentRecord.reference",
  );
  string(reference, "attachmentId", "attachmentRecord.reference");
  string(reference, "providerReference", "attachmentRecord.reference");
  optionalString(reference, "fileName", "attachmentRecord.reference");
  optionalString(reference, "mediaType", "attachmentRecord.reference");
  if (reference.byteLength !== undefined) integer(reference, "byteLength", 0, "attachmentRecord.reference");
  string(input, "storageReference", "attachmentRecord");
  if (input.state !== "available" && input.state !== "released")
    throw new TypeError("attachmentRecord.state is unsupported");
  return value as unknown as AttachmentRecord;
}

function validateReceiptClaim(value: unknown, label: string): void {
  const input = object(value, label);
  keys(input, ["claimId", "fence", "leaseExpiresAt"], label);
  string(input, "claimId", label);
  integer(input, "fence", 1, label);
  timestamp(input, "leaseExpiresAt", label);
}

function validateEventReceipt(value: unknown): EventReceipt {
  assertJsonSafe(value, "eventReceipt");
  const input = object(value, "eventReceipt");
  keys(
    input,
    ["key", "sequence", "capturedAt", "payload", "state", "claim", "checkpoint", "rejectionCode"],
    "eventReceipt",
  );
  const key = object(input.key, "eventReceipt.key");
  keys(key, ["provider", "installationId", "eventId", "lineId"], "eventReceipt.key");
  providerScope(key, "eventReceipt.key");
  string(key, "eventId", "eventReceipt.key");
  optionalString(key, "lineId", "eventReceipt.key");
  const sequence = optionalCanonicalSequence(input.sequence, "eventReceipt.sequence");
  timestamp(input, "capturedAt", "eventReceipt");
  const payload = object(input.payload, "eventReceipt.payload");
  if (payload.kind === "envelope") {
    keys(payload, ["kind", "envelope"], "eventReceipt.payload");
    const envelope = parseNormalizedPhotonInput(payload.envelope);
    if (
      envelope.event.provider !== key.provider ||
      envelope.event.installationId !== key.installationId ||
      envelope.event.eventId !== key.eventId ||
      envelope.event.lineId !== key.lineId ||
      envelope.event.sequence !== sequence
    ) {
      throw new TypeError("event receipt envelope identity mismatch");
    }
  } else if (payload.kind === "reference") {
    keys(payload, ["kind", "reference", "payloadSha256"], "eventReceipt.payload");
    string(payload, "reference", "eventReceipt.payload");
    const hash = string(payload, "payloadSha256", "eventReceipt.payload");
    if (!/^[a-f0-9]{64}$/u.test(hash))
      throw new TypeError("eventReceipt.payload.payloadSha256 must be lowercase SHA-256");
  } else throw new TypeError("eventReceipt.payload.kind is unsupported");
  if (!["captured", "processing", "checkpointed", "rejected"].includes(input.state as string)) {
    throw new TypeError("eventReceipt.state is unsupported");
  }
  if (input.claim !== undefined) validateReceiptClaim(input.claim, "eventReceipt.claim");
  if (input.state === "processing" && input.claim === undefined)
    throw new TypeError("processing receipt requires a claim");
  if (input.state === "captured" && input.claim !== undefined)
    throw new TypeError("captured receipt cannot have a claim");
  const checkpoint = optionalCanonicalSequence(input.checkpoint, "eventReceipt.checkpoint");
  if (checkpoint !== undefined && checkpoint !== sequence) throw new TypeError("event receipt checkpoint mismatch");
  if (
    (input.state === "checkpointed" || input.state === "rejected") &&
    sequence !== undefined &&
    checkpoint === undefined
  ) {
    throw new TypeError("terminal sequenced receipt requires its checkpoint");
  }
  if (input.state === "rejected") string(input, "rejectionCode", "eventReceipt");
  else if (input.rejectionCode !== undefined) throw new TypeError("only rejected receipts carry rejectionCode");
  return value as unknown as EventReceipt;
}

function validateCheckpoint(value: unknown): ContiguousCheckpoint {
  assertJsonSafe(value, "contiguousCheckpoint");
  const input = object(value, "contiguousCheckpoint");
  keys(input, ["scope", "sequence", "version"], "contiguousCheckpoint");
  const scope = object(input.scope, "contiguousCheckpoint.scope");
  keys(scope, ["provider", "installationId", "lineId"], "contiguousCheckpoint.scope");
  providerScope(scope, "contiguousCheckpoint.scope");
  string(scope, "lineId", "contiguousCheckpoint.scope");
  canonicalSequence(input.sequence, "contiguousCheckpoint.sequence");
  integer(input, "version", 1, "contiguousCheckpoint");
  return value as unknown as ContiguousCheckpoint;
}

export function sameOperation(left: PhotonPresentationOperation, right: PhotonPresentationOperation): boolean {
  return sameConversation(left.conversation, right.conversation) && left.idempotencyKey === right.idempotencyKey;
}

export function sameOperationPayload(left: PhotonPresentationOperation, right: PhotonPresentationOperation): boolean {
  return left.name === right.name && sameJson(left.input, right.input);
}

export function sameOperationReference(
  left: PhotonPresentationOperation | PhotonOperationOutcome["operation"],
  right: PhotonPresentationOperation | PhotonOperationOutcome["operation"],
): boolean {
  return (
    left.operationId === right.operationId &&
    left.name === right.name &&
    left.idempotencyKey === right.idempotencyKey &&
    sameConversation(left.conversation, right.conversation)
  );
}

export function plannedPartCount(operation: PhotonPresentationOperation): number {
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

export function operationReceiptMatches(
  operation: PhotonPresentationOperation,
  outcome: PhotonOperationOutcome,
): boolean {
  if (outcome.kind !== "confirmed-message" && outcome.kind !== "confirmed-no-message") return true;
  const receipt = outcome.providerReceipt;
  if (operation.conversation.provider === "advanced-imessage" && operation.name === "message.poll.create") {
    return (
      outcome.kind === "confirmed-message" &&
      receipt?.receiptType === "poll" &&
      receipt.pollMessageGuid === outcome.message.messageId &&
      receipt.optionIdentifiers.length === operation.input.options.length
    );
  }
  if (
    operation.conversation.provider === "advanced-imessage" &&
    (operation.name === "message.poll.vote" ||
      operation.name === "message.poll.unvote" ||
      operation.name === "message.poll.add-option")
  )
    return receipt?.receiptType === "poll" && receipt.pollMessageGuid === operation.input.pollMessageGuid;
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
    return (
      receipt.session.chatGuid === operation.conversation.conversationId &&
      receipt.session.sessionId === operation.input.handle.session.sessionId &&
      receipt.session.targetMessageGuid === operation.input.handle.session.targetMessageGuid &&
      (outcome.kind !== "confirmed-message" || receipt.session.messageGuid === outcome.message.messageId)
    );
  }
  if (
    operation.conversation.provider === "advanced-imessage" &&
    (operation.name === "conversation.rename" ||
      operation.name === "conversation.membership.add" ||
      operation.name === "conversation.membership.remove")
  ) {
    if (receipt?.receiptType !== "chat" || receipt.chatGuid !== operation.conversation.conversationId) return false;
    if (operation.name === "conversation.rename") return receipt.displayName === operation.input.title;
    if (operation.name === "conversation.membership.add") {
      return operation.input.participantIds.every((participantId) => receipt.participantIds.includes(participantId));
    }
    return operation.input.participantIds.every((participantId) => !receipt.participantIds.includes(participantId));
  }
  return receipt === undefined;
}

function validateDeliveryOperation(value: unknown): DeliveryOperationRecord {
  assertJsonSafe(value, "deliveryOperationRecord");
  const input = object(value, "deliveryOperationRecord");
  keys(
    input,
    ["operation", "attempts", "parts", "state", "dispatchFence", "outcome", "version"],
    "deliveryOperationRecord",
  );
  const operation = parsePhotonPresentationOperation(input.operation);
  if (!Array.isArray(input.attempts) || input.attempts.length === 0)
    throw new TypeError("delivery operation requires attempts");
  const attempts = input.attempts.map((value, index) => {
    const attempt = object(value, `deliveryOperationRecord.attempts[${index}]`);
    keys(attempt, ["operationId", "attemptId"], `deliveryOperationRecord.attempts[${index}]`);
    return {
      operationId: string(attempt, "operationId", `deliveryOperationRecord.attempts[${index}]`),
      attemptId: string(attempt, "attemptId", `deliveryOperationRecord.attempts[${index}]`),
    };
  });
  if (new Set(attempts.map((attempt) => attempt.operationId)).size !== attempts.length)
    throw new TypeError("delivery operation IDs must be unique");
  if (new Set(attempts.map((attempt) => attempt.attemptId)).size !== attempts.length)
    throw new TypeError("delivery attempt IDs must be unique");
  if (
    !attempts.some(
      (attempt) => attempt.operationId === operation.operationId && attempt.attemptId === operation.attemptId,
    )
  ) {
    throw new TypeError("current delivery attempt is not retained");
  }
  if (!Array.isArray(input.parts) || input.parts.length !== plannedPartCount(operation))
    throw new TypeError("delivery part count mismatch");
  input.parts.forEach((value, index) => {
    const part = object(value, `deliveryOperationRecord.parts[${index}]`);
    keys(
      part,
      ["partId", "partIndex", "state", "dispatchFence", "providerPart"],
      `deliveryOperationRecord.parts[${index}]`,
    );
    string(part, "partId", `deliveryOperationRecord.parts[${index}]`);
    if (integer(part, "partIndex", 0, `deliveryOperationRecord.parts[${index}]`) !== index)
      throw new TypeError("delivery parts must be contiguous");
    if (!["reserved", "dispatched", "confirmed", "unsupported", "ambiguous", "failed"].includes(part.state as string)) {
      throw new TypeError("delivery part state is unsupported");
    }
    integer(part, "dispatchFence", 0, `deliveryOperationRecord.parts[${index}]`);
    if (part.providerPart !== undefined) {
      const reference = validateMessagePartReference(
        part.providerPart,
        `deliveryOperationRecord.parts[${index}].providerPart`,
      );
      if (!sameConversation(reference, operation.conversation) || part.state !== "confirmed")
        throw new TypeError("delivery provider part mismatch");
    } else if (part.state === "confirmed") throw new TypeError("confirmed delivery part requires provider identity");
  });
  if (!["reserved", "dispatched", "confirmed", "unsupported", "ambiguous", "failed"].includes(input.state as string)) {
    throw new TypeError("delivery operation state is unsupported");
  }
  integer(input, "dispatchFence", 0, "deliveryOperationRecord");
  integer(input, "version", 1, "deliveryOperationRecord");
  if (input.outcome === undefined) {
    if (input.state !== "reserved" && input.state !== "dispatched")
      throw new TypeError("terminal delivery operation requires outcome");
  } else {
    const outcome = parsePhotonOperationOutcome(input.outcome);
    if (!sameOperationReference(operation, outcome.operation) || !operationReceiptMatches(operation, outcome)) {
      throw new TypeError("delivery outcome mismatch");
    }
    const expectedState =
      outcome.kind === "confirmed-message" || outcome.kind === "confirmed-no-message" ? "confirmed" : outcome.kind;
    if (input.state !== expectedState) throw new TypeError("delivery state and outcome mismatch");
  }
  return value as unknown as DeliveryOperationRecord;
}

function validateStream(value: unknown): TextStreamSessionRecord {
  assertJsonSafe(value, "textStreamSessionRecord");
  const input = object(value, "textStreamSessionRecord");
  keys(input, ["operation", "chunks", "state", "version"], "textStreamSessionRecord");
  const operation = parsePhotonPresentationOperation(input.operation);
  if (operation.name !== "message.text.stream") throw new TypeError("text stream operation name mismatch");
  if (!Array.isArray(input.chunks) || input.chunks.some((chunk) => typeof chunk !== "string" || chunk.length === 0)) {
    throw new TypeError("text stream chunks must be non-empty strings");
  }
  if (input.state !== "open" && input.state !== "finalized") throw new TypeError("text stream state is unsupported");
  if (input.state === "finalized" && input.chunks.length === 0)
    throw new TypeError("finalized text stream must have chunks");
  const version = integer(input, "version", 1, "textStreamSessionRecord");
  if (version !== input.chunks.length + (input.state === "finalized" ? 2 : 1))
    throw new TypeError("text stream version mismatch");
  return value as unknown as TextStreamSessionRecord;
}

function validatePoll(value: unknown): PollReference {
  assertJsonSafe(value, "pollReference");
  const input = object(value, "pollReference");
  keys(input, ["conversation", "pollMessageGuid", "optionIdentifiers", "version"], "pollReference");
  validateConversationReference(input.conversation, "pollReference.conversation");
  string(input, "pollMessageGuid", "pollReference");
  if (!Array.isArray(input.optionIdentifiers) || input.optionIdentifiers.length === 0)
    throw new TypeError("poll option identifiers are required");
  const identifiers = input.optionIdentifiers.map((identifier, index) => {
    if (typeof identifier !== "string" || identifier.trim().length === 0)
      throw new TypeError(`pollReference.optionIdentifiers[${index}] is invalid`);
    return identifier;
  });
  if (new Set(identifiers).size !== identifiers.length) throw new TypeError("poll option identifiers must be unique");
  integer(input, "version", 1, "pollReference");
  return value as unknown as PollReference;
}

function validateCard(value: unknown): PublicCardHandle {
  assertJsonSafe(value, "publicCardHandle");
  const input = object(value, "publicCardHandle");
  keys(input, ["conversation", "cardId", "handle", "version"], "publicCardHandle");
  const conversation = validateConversationReference(input.conversation, "publicCardHandle.conversation");
  const cardId = string(input, "cardId", "publicCardHandle");
  const handle = object(input.handle, "publicCardHandle.handle");
  if (handle.provider !== conversation.provider || handle.cardId !== cardId)
    throw new TypeError("card handle identity mismatch");
  const session = object(handle.session, "publicCardHandle.handle.session");
  keys(session, ["chatGuid", "messageGuid", "sessionId", "targetMessageGuid"], "publicCardHandle.handle.session");
  if (string(session, "chatGuid", "publicCardHandle.handle.session") !== conversation.conversationId)
    throw new TypeError("card chat mismatch");
  string(session, "messageGuid", "publicCardHandle.handle.session");
  string(session, "sessionId", "publicCardHandle.handle.session");
  string(session, "targetMessageGuid", "publicCardHandle.handle.session");
  string(handle, "revision", "publicCardHandle.handle");
  if (handle.provider === "spectrum-imessage") {
    keys(handle, ["provider", "cardId", "target", "session", "revision"], "publicCardHandle.handle");
    const target = object(handle.target, "publicCardHandle.handle.target");
    const targetConversation = validateConversationReference(
      Object.fromEntries(Object.entries(target).filter(([key]) => key !== "messageId" && key !== "partIndex")),
      "publicCardHandle.handle.target",
    );
    if (!sameConversation(targetConversation, conversation)) throw new TypeError("card target conversation mismatch");
    if (string(target, "messageId", "publicCardHandle.handle.target") !== session.targetMessageGuid)
      throw new TypeError("card target message mismatch");
    if (target.partIndex !== undefined) integer(target, "partIndex", 0, "publicCardHandle.handle.target");
  } else if (handle.provider === "advanced-imessage") {
    keys(handle, ["provider", "cardId", "session", "revision"], "publicCardHandle.handle");
  } else throw new TypeError("card handle provider is unsupported");
  integer(input, "version", 1, "publicCardHandle");
  return value as unknown as PublicCardHandle;
}

function validateAction(value: unknown): Parameters<ActionBindingStorePort["create"]>[0] {
  return parseActionBinding(value);
}

const validators: {
  [Kind in PhotonStateRecordKind]: (value: unknown) => PhotonStateRecordValues[Kind];
} = {
  installation: validateInstallationRecord,
  "verified-address-challenge": validateChallenge,
  "chat-session-binding": validateChatBinding,
  "message-binding": validateMessageBinding,
  attachment: validateAttachment,
  "event-receipt": validateEventReceipt,
  checkpoint: validateCheckpoint,
  "delivery-operation": validateDeliveryOperation,
  "text-stream-session": validateStream,
  "poll-reference": validatePoll,
  "card-handle": validateCard,
  "action-binding": validateAction,
};

export function serializePhotonStateRecord<Kind extends PhotonStateRecordKind>(
  kind: Kind,
  value: PhotonStateRecordValues[Kind],
): SerializedPhotonStateRecord<PhotonStateRecordValues[Kind]> {
  const validated = validators[kind](value);
  jsonbSafe(validated, kind);
  return { kind, recordVersion: PHOTON_STATE_RECORD_VERSION, value: validated };
}

export function parsePhotonStateRecord<Kind extends PhotonStateRecordKind>(
  kind: Kind,
  value: unknown,
): PhotonStateRecordValues[Kind] {
  const envelope = object(value, `${kind}Envelope`);
  keys(envelope, ["kind", "recordVersion", "value"], `${kind}Envelope`);
  if (envelope.kind !== kind) throw new TypeError(`${kind} record kind mismatch`);
  if (envelope.recordVersion !== PHOTON_STATE_RECORD_VERSION)
    throw new TypeError(`${kind} record version is unsupported`);
  const validated = validators[kind](envelope.value);
  jsonbSafe(validated, kind);
  return validated;
}
