export const PHOTON_PROVIDER_NAMES = ["spectrum-imessage", "advanced-imessage"] as const;
export const PHOTON_EVENT_DIRECTIONS = ["inbound", "outbound", "system"] as const;
export const PHOTON_EVENT_FAMILIES = [
  "message",
  "delivery",
  "read",
  "reaction",
  "interaction",
  "conversation",
  "membership",
  "poll",
  "lifecycle",
] as const;
export const QM_CHANNEL_OPERATIONS = [
  "turn.start",
  "turn.steer",
  "turn.resume",
  "approval.resolve",
  "run.signal",
  "session.share",
  "session.rename",
  "session.fork",
  "loop.fire",
  "loop.item.act",
  "cron.run",
  "reach.send",
] as const;
export const PHOTON_PRESENTATION_OPERATIONS = [
  "message.text",
  "message.multipart",
  "message.attachment",
  "message.voice",
  "message.contact",
  "message.poll",
  "message.app",
  "message.react",
  "message.edit",
  "message.unsend",
  "conversation.typing",
  "conversation.read",
  "conversation.rename",
  "conversation.avatar",
  "conversation.membership",
  "view.mount",
] as const;
export const PHOTON_INSTALLATION_STATES = [
  "not-started",
  "awaiting-authorization",
  "provisioning",
  "connected",
  "needs-owner-rebind",
  "needs-credential-repair",
  "failed",
] as const;

export type PhotonProviderName = (typeof PHOTON_PROVIDER_NAMES)[number];
export type ProviderEventDirection = (typeof PHOTON_EVENT_DIRECTIONS)[number];
export type ProviderEventFamily = (typeof PHOTON_EVENT_FAMILIES)[number];
export type QmChannelOperationName = (typeof QM_CHANNEL_OPERATIONS)[number];
export type PhotonPresentationOperationName = (typeof PHOTON_PRESENTATION_OPERATIONS)[number];
export type PhotonInstallationState = (typeof PHOTON_INSTALLATION_STATES)[number];

export interface InstallationReference {
  installationId: string;
  projectId: string;
}

export interface LineReference {
  installation: InstallationReference;
  lineId: string;
  maskedAddress?: string;
}

export interface ConversationReference {
  provider: PhotonProviderName;
  conversationId: string;
  line: LineReference;
}

export interface MessagePartIdentity {
  messageId: string;
  partIndex: number;
}

export interface MessageReference {
  conversation: ConversationReference;
  messageId: string;
  parts: readonly MessagePartIdentity[];
}

export interface ProviderActorReference {
  actorId: string;
  kind: "human" | "agent" | "system";
  canonicalIdentityId?: string;
  providerAddress?: string;
}

export interface ProviderEventIdentity {
  eventId: string;
  provider: PhotonProviderName;
  installation: InstallationReference;
  sequence: string;
  occurredAt: string;
  direction: ProviderEventDirection;
  actor: ProviderActorReference;
  family: ProviderEventFamily;
}

export interface AttachmentReference {
  attachmentId: string;
  providerReference: string;
  fileName?: string;
  mediaType?: string;
  byteLength?: number;
}

export interface ReplyReference {
  conversationId: string;
  messagePart: MessagePartIdentity;
}

export interface NormalizedPhotonInput {
  event: ProviderEventIdentity;
  conversation: ConversationReference;
  text?: string;
  attachments: readonly AttachmentReference[];
  replyTo?: ReplyReference;
}

export interface QmAuthorizationProof {
  actorId: string;
  capabilityId: string;
  resourceRevision: string;
  checkedAt: string;
  decision: "allowed";
}

export interface CheckedQmChannelOperation {
  operationId: string;
  name: QmChannelOperationName;
  actorId: string;
  sessionId?: string;
  idempotencyKey: string;
  authorization: QmAuthorizationProof;
  input: Readonly<Record<string, unknown>>;
}

export interface PhotonPresentationOperation {
  operationId: string;
  name: PhotonPresentationOperationName;
  conversation: ConversationReference;
  idempotencyKey: string;
  input: Readonly<Record<string, unknown>>;
}

export type PhotonOperationOutcome =
  | {
      kind: "confirmed-message";
      operationId: string;
      message: MessageReference;
    }
  | {
      kind: "confirmed-no-message";
      operationId: string;
    }
  | {
      kind: "unsupported";
      operationId: string;
      capability: string;
      reason: string;
    }
  | {
      kind: "failed";
      operationId: string;
      code: string;
      retryable: boolean;
    }
  | {
      kind: "ambiguous";
      operationId: string;
      reconciliationKey: string;
    };

export interface ActionBinding {
  bindingId: string;
  actor: ProviderActorReference;
  resource: {
    resourceType: string;
    resourceId: string;
  };
  resourceRevision: string;
  allowedAction: QmChannelOperationName;
  expiresAt: string;
  session: {
    sessionId: string;
  };
  conversation: ConversationReference;
}

export type InstallationDisplayStatus =
  | {
      state: "not-started";
      installationId: string;
    }
  | {
      state: "awaiting-authorization";
      installationId: string;
      userCode: string;
      verificationUrl: string;
      expiresAt: string;
    }
  | {
      state: "provisioning" | "needs-owner-rebind" | "needs-credential-repair";
      installationId: string;
    }
  | {
      state: "connected";
      installationId: string;
      projectId: string;
      lines: readonly Pick<LineReference, "lineId" | "maskedAddress">[];
    }
  | {
      state: "failed";
      installationId: string;
      safeCode: string;
    };

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0)
    throw new TypeError(`${label}.${key} must be a non-empty string`);
  return field;
}

function optionalString(value: Record<string, unknown>, key: string, label: string): void {
  const field = value[key];
  if (field !== undefined && (typeof field !== "string" || field.length === 0)) {
    throw new TypeError(`${label}.${key} must be a non-empty string when present`);
  }
}

function isoTimestamp(value: Record<string, unknown>, key: string, label: string): void {
  const field = stringField(value, key, label);
  if (!Number.isFinite(Date.parse(field))) throw new TypeError(`${label}.${key} must be an ISO timestamp`);
}

function member<T extends readonly string[]>(value: unknown, values: T, label: string): asserts value is T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${label} is unsupported`);
}

function installationReference(value: unknown, label: string): asserts value is InstallationReference {
  const input = record(value, label);
  stringField(input, "installationId", label);
  stringField(input, "projectId", label);
}

function lineReference(value: unknown, label: string): asserts value is LineReference {
  const input = record(value, label);
  installationReference(input.installation, `${label}.installation`);
  stringField(input, "lineId", label);
  optionalString(input, "maskedAddress", label);
}

function conversationReference(value: unknown, label: string): asserts value is ConversationReference {
  const input = record(value, label);
  member(input.provider, PHOTON_PROVIDER_NAMES, `${label}.provider`);
  stringField(input, "conversationId", label);
  lineReference(input.line, `${label}.line`);
}

function messagePartIdentity(value: unknown, label: string): asserts value is MessagePartIdentity {
  const input = record(value, label);
  stringField(input, "messageId", label);
  if (!Number.isInteger(input.partIndex) || (input.partIndex as number) < 0) {
    throw new TypeError(`${label}.partIndex must be a non-negative integer`);
  }
}

function messageReference(value: unknown, label: string): asserts value is MessageReference {
  const input = record(value, label);
  conversationReference(input.conversation, `${label}.conversation`);
  stringField(input, "messageId", label);
  if (!Array.isArray(input.parts) || input.parts.length === 0) throw new TypeError(`${label}.parts must be non-empty`);
  input.parts.forEach((part, index) => messagePartIdentity(part, `${label}.parts[${index}]`));
}

function actorReference(value: unknown, label: string): asserts value is ProviderActorReference {
  const input = record(value, label);
  stringField(input, "actorId", label);
  member(input.kind, ["human", "agent", "system"] as const, `${label}.kind`);
  optionalString(input, "canonicalIdentityId", label);
  optionalString(input, "providerAddress", label);
}

function providerEventIdentity(value: unknown, label: string): asserts value is ProviderEventIdentity {
  const input = record(value, label);
  stringField(input, "eventId", label);
  member(input.provider, PHOTON_PROVIDER_NAMES, `${label}.provider`);
  installationReference(input.installation, `${label}.installation`);
  stringField(input, "sequence", label);
  isoTimestamp(input, "occurredAt", label);
  member(input.direction, PHOTON_EVENT_DIRECTIONS, `${label}.direction`);
  actorReference(input.actor, `${label}.actor`);
  member(input.family, PHOTON_EVENT_FAMILIES, `${label}.family`);
}

export function parseNormalizedPhotonInput(value: unknown): NormalizedPhotonInput {
  const input = record(value, "normalizedInput");
  providerEventIdentity(input.event, "normalizedInput.event");
  conversationReference(input.conversation, "normalizedInput.conversation");
  optionalString(input, "text", "normalizedInput");
  if (!Array.isArray(input.attachments)) throw new TypeError("normalizedInput.attachments must be an array");
  input.attachments.forEach((attachment, index) => {
    const current = record(attachment, `normalizedInput.attachments[${index}]`);
    stringField(current, "attachmentId", `normalizedInput.attachments[${index}]`);
    stringField(current, "providerReference", `normalizedInput.attachments[${index}]`);
    optionalString(current, "fileName", `normalizedInput.attachments[${index}]`);
    optionalString(current, "mediaType", `normalizedInput.attachments[${index}]`);
    if (
      current.byteLength !== undefined &&
      (!Number.isSafeInteger(current.byteLength) || (current.byteLength as number) < 0)
    ) {
      throw new TypeError(`normalizedInput.attachments[${index}].byteLength must be a non-negative safe integer`);
    }
  });
  if (input.replyTo !== undefined) {
    const reply = record(input.replyTo, "normalizedInput.replyTo");
    stringField(reply, "conversationId", "normalizedInput.replyTo");
    messagePartIdentity(reply.messagePart, "normalizedInput.replyTo.messagePart");
  }
  if (input.text === undefined && input.attachments.length === 0) {
    throw new TypeError("normalizedInput must contain text or attachments");
  }
  return value as NormalizedPhotonInput;
}

export function parseCheckedQmChannelOperation(value: unknown): CheckedQmChannelOperation {
  const input = record(value, "checkedOperation");
  stringField(input, "operationId", "checkedOperation");
  member(input.name, QM_CHANNEL_OPERATIONS, "checkedOperation.name");
  stringField(input, "actorId", "checkedOperation");
  optionalString(input, "sessionId", "checkedOperation");
  stringField(input, "idempotencyKey", "checkedOperation");
  record(input.input, "checkedOperation.input");
  const authorization = record(input.authorization, "checkedOperation.authorization");
  stringField(authorization, "actorId", "checkedOperation.authorization");
  stringField(authorization, "capabilityId", "checkedOperation.authorization");
  stringField(authorization, "resourceRevision", "checkedOperation.authorization");
  isoTimestamp(authorization, "checkedAt", "checkedOperation.authorization");
  if (authorization.decision !== "allowed")
    throw new TypeError("checkedOperation.authorization.decision must be allowed");
  if (authorization.actorId !== input.actorId)
    throw new TypeError("checkedOperation actor does not match authorization actor");
  return value as CheckedQmChannelOperation;
}

export function parsePhotonPresentationOperation(value: unknown): PhotonPresentationOperation {
  const input = record(value, "presentationOperation");
  stringField(input, "operationId", "presentationOperation");
  member(input.name, PHOTON_PRESENTATION_OPERATIONS, "presentationOperation.name");
  conversationReference(input.conversation, "presentationOperation.conversation");
  stringField(input, "idempotencyKey", "presentationOperation");
  record(input.input, "presentationOperation.input");
  return value as PhotonPresentationOperation;
}

export function parsePhotonOperationOutcome(value: unknown): PhotonOperationOutcome {
  const input = record(value, "operationOutcome");
  stringField(input, "operationId", "operationOutcome");
  member(
    input.kind,
    ["confirmed-message", "confirmed-no-message", "unsupported", "failed", "ambiguous"] as const,
    "operationOutcome.kind",
  );
  if (input.kind === "confirmed-message") messageReference(input.message, "operationOutcome.message");
  if (input.kind === "unsupported") {
    stringField(input, "capability", "operationOutcome");
    stringField(input, "reason", "operationOutcome");
  }
  if (input.kind === "failed") {
    stringField(input, "code", "operationOutcome");
    if (typeof input.retryable !== "boolean") throw new TypeError("operationOutcome.retryable must be boolean");
  }
  if (input.kind === "ambiguous") stringField(input, "reconciliationKey", "operationOutcome");
  return value as PhotonOperationOutcome;
}

export function parseActionBinding(value: unknown): ActionBinding {
  const input = record(value, "actionBinding");
  stringField(input, "bindingId", "actionBinding");
  actorReference(input.actor, "actionBinding.actor");
  const resource = record(input.resource, "actionBinding.resource");
  stringField(resource, "resourceType", "actionBinding.resource");
  stringField(resource, "resourceId", "actionBinding.resource");
  stringField(input, "resourceRevision", "actionBinding");
  member(input.allowedAction, QM_CHANNEL_OPERATIONS, "actionBinding.allowedAction");
  isoTimestamp(input, "expiresAt", "actionBinding");
  const session = record(input.session, "actionBinding.session");
  stringField(session, "sessionId", "actionBinding.session");
  conversationReference(input.conversation, "actionBinding.conversation");
  return value as ActionBinding;
}

export function parseInstallationDisplayStatus(value: unknown): InstallationDisplayStatus {
  const input = record(value, "installationStatus");
  member(input.state, PHOTON_INSTALLATION_STATES, "installationStatus.state");
  stringField(input, "installationId", "installationStatus");
  if (input.state === "awaiting-authorization") {
    stringField(input, "userCode", "installationStatus");
    const verificationUrl = stringField(input, "verificationUrl", "installationStatus");
    const parsed = new URL(verificationUrl);
    if (parsed.protocol !== "https:") throw new TypeError("installationStatus.verificationUrl must use https");
    isoTimestamp(input, "expiresAt", "installationStatus");
  }
  if (input.state === "connected") {
    stringField(input, "projectId", "installationStatus");
    if (!Array.isArray(input.lines)) throw new TypeError("installationStatus.lines must be an array");
    input.lines.forEach((line, index) => {
      const current = record(line, `installationStatus.lines[${index}]`);
      stringField(current, "lineId", `installationStatus.lines[${index}]`);
      optionalString(current, "maskedAddress", `installationStatus.lines[${index}]`);
    });
  }
  if (input.state === "failed") stringField(input, "safeCode", "installationStatus");
  return value as InstallationDisplayStatus;
}
