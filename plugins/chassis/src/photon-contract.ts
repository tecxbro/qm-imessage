export const PHOTON_PROVIDER_NAMES = ["spectrum-imessage", "advanced-imessage"] as const;
export const PHOTON_EVENT_DIRECTIONS = ["inbound", "outbound", "system"] as const;
export const PHOTON_EVENT_KINDS = [
  "message",
  "edit",
  "unsend",
  "reaction",
  "read",
  "delivery",
  "poll",
  "group",
  "membership",
  "lifecycle",
  "unknown",
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
  "message.markdown",
  "message.text.stream",
  "message.link",
  "message.multipart",
  "message.attachment",
  "message.voice",
  "message.contact",
  "message.poll.create",
  "message.poll.vote",
  "message.poll.unvote",
  "message.poll.add-option",
  "message.app.send",
  "message.app.update",
  "message.react",
  "message.edit",
  "message.unsend",
  "conversation.typing",
  "conversation.read",
  "conversation.rename",
  "conversation.avatar.set",
  "conversation.avatar.clear",
  "conversation.membership.add",
  "conversation.membership.remove",
  "conversation.membership.leave",
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
export type ProviderEventKind = (typeof PHOTON_EVENT_KINDS)[number];
export type QmChannelOperationName = (typeof QM_CHANNEL_OPERATIONS)[number];
export type PhotonPresentationOperationName = (typeof PHOTON_PRESENTATION_OPERATIONS)[number];
export type PhotonInstallationState = (typeof PHOTON_INSTALLATION_STATES)[number];
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export const PHOTON_MESSAGE_EFFECTS = [
  "com.apple.MobileSMS.expressivesend.impact",
  "com.apple.MobileSMS.expressivesend.loud",
  "com.apple.MobileSMS.expressivesend.gentle",
  "com.apple.MobileSMS.expressivesend.invisibleink",
  "com.apple.messages.effect.CKConfettiEffect",
  "com.apple.messages.effect.CKFireworksEffect",
  "com.apple.messages.effect.CKBalloonEffect",
  "com.apple.messages.effect.CKHeartEffect",
  "com.apple.messages.effect.CKLasersEffect",
  "com.apple.messages.effect.CKHappyBirthdayEffect",
  "com.apple.messages.effect.CKSparklesEffect",
  "com.apple.messages.effect.CKSpotlightEffect",
  "com.apple.messages.effect.CKEchoEffect",
] as const;

export type PhotonMessageEffect = (typeof PHOTON_MESSAGE_EFFECTS)[number];

export interface InstallationReference {
  installationId: string;
  projectId?: string;
}

export interface ProviderScope {
  provider: PhotonProviderName;
  installationId: string;
}

export interface LineReference extends ProviderScope {
  projectId?: string;
  lineId: string;
  maskedAddress?: string;
}

export interface ConversationReference extends LineReference {
  conversationId: string;
}

export interface MessagePartIdentity {
  messageId: string;
  partIndex: number;
}

export interface MessagePartReference extends ConversationReference, MessagePartIdentity {}

export interface MessageTargetReference extends ConversationReference {
  messageId: string;
  partIndex?: number;
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

export interface ProviderEventIdentity extends ProviderScope {
  eventId: string;
  lineId?: string;
  sequence?: string;
  occurredAt: string;
  direction: ProviderEventDirection;
}

export interface OutboundAttachmentReference {
  attachmentId: string;
  providerReference: string;
  fileName?: string;
  mediaType?: string;
  byteLength?: number;
}

export interface AttachmentReference extends MessagePartReference, OutboundAttachmentReference {}

export type ReplyReference = MessagePartReference;

export type PhotonAppCardSpec =
  | {
      provider: "spectrum-imessage";
      cardId: string;
      url: string;
      live?: boolean;
    }
  | {
      provider: "advanced-imessage";
      cardId: string;
      appName: string;
      appStoreId?: number;
      extensionBundleId: string;
      layout: {
        caption?: string;
        image?: OutboundAttachmentReference;
        imageSubtitle?: string;
        imageTitle?: string;
        subcaption?: string;
        summary?: string;
        trailingCaption?: string;
        trailingSubcaption?: string;
      };
      live?: boolean;
      teamId: string;
      url: string;
    };

export interface PhotonAppCardSession {
  chatGuid: string;
  messageGuid: string;
  sessionId: string;
  targetMessageGuid: string;
}

export type PhotonAppCardHandle =
  | {
      provider: "spectrum-imessage";
      cardId: string;
      target: MessageTargetReference;
      session: PhotonAppCardSession;
      revision: string;
    }
  | {
      provider: "advanced-imessage";
      cardId: string;
      session: PhotonAppCardSession;
      revision: string;
    };

export interface PhotonInboundTextFormat {
  type: string;
  start: number;
  length: number;
  effectName?: string;
}

export interface PhotonInboundMention {
  address: string;
  start: number;
  length: number;
}

export interface PhotonInboundAttachmentInfo {
  companionKind?: "live-photo-video" | "unknown";
  fileName: string;
  guid: string;
  isHidden: boolean;
  isOutgoing: boolean;
  isSticker: boolean;
  mimeType: string;
  originalGuid?: string;
  totalBytes: number;
  transferState: "pending" | "transferring" | "failed" | "finished" | "unknown";
  uti: string;
}

export interface PhotonInboundMiniAppContent {
  extensionBundleId: string;
  teamId: string;
  live: boolean;
  appName?: string;
  appStoreId?: number;
  sessionId?: string;
  url?: string;
  layout?: {
    caption?: string;
    imageSubtitle?: string;
    imageTitle?: string;
    subcaption?: string;
    summary?: string;
    trailingCaption?: string;
    trailingSubcaption?: string;
  };
}

export interface PhotonInboundEditContent {
  attachments: readonly PhotonInboundAttachmentInfo[];
  formatting: readonly PhotonInboundTextFormat[];
  mentions: readonly PhotonInboundMention[];
  text?: string;
  balloonBundleId?: string;
  expressiveSendStyleId?: string;
  miniApp?: PhotonInboundMiniAppContent;
}

export type PhotonEditableContent =
  { kind: "text"; text: string } | { kind: "markdown"; markdown: string } | { kind: "app"; app: PhotonAppCardSpec };

export type PhotonMultipartPart =
  | { kind: "text"; text: string }
  | { kind: "markdown"; markdown: string }
  | { kind: "attachment"; attachment: OutboundAttachmentReference }
  | { kind: "link"; url: string; preview: boolean };

export type PhotonReaction =
  { kind: "love" | "like" | "dislike" | "laugh" | "emphasize" | "question" } | { kind: "emoji"; emoji: string };

export type OrderedMessageContent =
  { kind: "text"; part: MessagePartIdentity; text: string } | { kind: "attachment"; attachment: AttachmentReference };

interface ScopedProviderEvent {
  event: ProviderEventIdentity;
  kind: ProviderEventKind;
}

interface ConversationProviderEvent extends ScopedProviderEvent {
  conversation: ConversationReference;
}

export type ObservationTarget =
  { kind: "message"; message: MessageTargetReference } | { kind: "conversation"; conversation: ConversationReference };

export interface PhotonPollState {
  readonly chatGuid: string;
  readonly pollMessageGuid: string;
  readonly title: string;
  readonly options: readonly { optionIdentifier: string; text: string; creatorHandle?: string }[];
  readonly votes: readonly {
    optionIdentifier: string;
    participant: { address: string; country?: string; service: "iMessage" | "SMS" | "RCS" | "unknown" };
  }[];
}

export type NormalizedPhotonInput =
  | (ConversationProviderEvent & {
      kind: "message";
      actor: ProviderActorReference & { kind: "human" };
      message: MessageReference;
      content: readonly OrderedMessageContent[];
      replyTo?: ReplyReference;
    })
  | (ConversationProviderEvent & {
      kind: "edit";
      actor?: ProviderActorReference;
      target: MessageTargetReference;
      content: PhotonInboundEditContent;
    })
  | (ConversationProviderEvent & {
      kind: "unsend";
      actor?: ProviderActorReference;
      target: MessageTargetReference;
    })
  | (ConversationProviderEvent & {
      kind: "reaction";
      actor: ProviderActorReference;
      target: MessageTargetReference;
      reaction: { action: "add" | "remove"; value: string };
    })
  | (ScopedProviderEvent & {
      kind: "read" | "delivery";
      actor?: ProviderActorReference;
      target: ObservationTarget;
    })
  | (ConversationProviderEvent & {
      kind: "poll";
      actor?: ProviderActorReference;
      pollMessageGuid: string;
      action: "created" | "option-added";
      title: string;
      options: readonly { optionIdentifier: string; text: string; creatorId?: string }[];
    })
  | (ConversationProviderEvent & {
      kind: "poll";
      actor?: ProviderActorReference;
      pollMessageGuid: string;
      action: "voted" | "unvoted";
      optionIdentifier: string;
    })
  | (ConversationProviderEvent & {
      kind: "group";
      actor?: ProviderActorReference;
      action: "renamed";
      displayName: string;
    })
  | (ConversationProviderEvent & {
      kind: "group";
      actor?: ProviderActorReference;
      action: "avatar-set" | "avatar-cleared";
    })
  | (ConversationProviderEvent & {
      kind: "membership";
      actor?: ProviderActorReference;
      action: "added" | "removed" | "left";
      memberIds: readonly string[];
    })
  | (ScopedProviderEvent & {
      kind: "lifecycle";
      action: "connected" | "disconnected" | "reconnecting" | "stopped";
      detail?: JsonObject;
    })
  | (ScopedProviderEvent & {
      kind: "lifecycle";
      action: "catchup-complete";
      headSequence: string;
    })
  | (ScopedProviderEvent & {
      kind: "unknown";
      rawType: string;
      reason: string;
      conversation?: ConversationReference;
      actor?: ProviderActorReference;
      payload?: JsonObject;
    });

export type QmChannelOperationInput = {
  "turn.start": {
    source: "photon";
    request: Extract<NormalizedPhotonInput, { kind: "message" }>;
    redeliveryKey: string;
  };
  "turn.steer": { runId: string; text: string };
  "turn.resume": { sessionId: string };
  "approval.resolve": { bindingId: string; decision: "approve" | "deny" };
  "run.signal": { runId: string; signal: "abort" | "steer"; text?: string };
  "session.share": { sessionId: string };
  "session.rename": { sessionId: string; title: string };
  "session.fork": { sessionId: string };
  "loop.fire": { loopId: string };
  "loop.item.act": { loopId: string; itemId: string; action: string };
  "cron.run": { cronId: string };
  "reach.send": {
    destination:
      | { kind: "principal"; principalId: string }
      | { kind: "channel"; channelId: string }
      | { kind: "group"; participantIds: readonly string[] };
    content: { text?: string; attachments?: readonly OutboundAttachmentReference[] };
  };
};

export type PhotonPresentationOperationInput = {
  "message.text": { text: string; replyTo?: ReplyReference; effect?: PhotonMessageEffect; enableLinkPreview?: boolean };
  "message.markdown": {
    markdown: string;
    replyTo?: ReplyReference;
    effect?: PhotonMessageEffect;
    enableLinkPreview?: boolean;
  };
  "message.text.stream": {
    format: "plain" | "markdown";
    replyTo?: ReplyReference;
    effect?: PhotonMessageEffect;
  };
  "message.link": { url: string; preview: boolean; replyTo?: ReplyReference };
  "message.multipart": {
    parts: readonly PhotonMultipartPart[];
    replyTo?: ReplyReference;
    effect?: PhotonMessageEffect;
  };
  "message.attachment": {
    attachment: OutboundAttachmentReference;
    replyTo?: ReplyReference;
    effect?: PhotonMessageEffect;
  };
  "message.voice": { attachment: OutboundAttachmentReference };
  "message.contact": { vcard: string };
  "message.poll.create": { title: string; options: readonly string[] };
  "message.poll.vote": { pollMessageGuid: string; optionIdentifier: string };
  "message.poll.unvote": { pollMessageGuid: string };
  "message.poll.add-option": { pollMessageGuid: string; text: string };
  "message.app.send": { app: PhotonAppCardSpec };
  "message.app.update": { handle: PhotonAppCardHandle; app: PhotonAppCardSpec };
  "message.react": { target: MessageTargetReference; action: "add" | "remove"; reaction: PhotonReaction };
  "message.edit": { target: MessageTargetReference; content: PhotonEditableContent };
  "message.unsend": { target: MessageTargetReference };
  "conversation.typing": { active: boolean };
  "conversation.read": { target?: MessageTargetReference };
  "conversation.rename": { title: string };
  "conversation.avatar.set": { attachment: OutboundAttachmentReference };
  "conversation.avatar.clear": Record<string, never>;
  "conversation.membership.add": { participantIds: readonly string[] };
  "conversation.membership.remove": { participantIds: readonly string[] };
  "conversation.membership.leave": Record<string, never>;
};

type NamedOperation<Inputs extends Record<string, unknown>, Name extends keyof Inputs & string> = {
  operationId: string;
  name: Name;
  actorId: string;
  sessionId?: string;
  idempotencyKey: string;
  input: Inputs[Name];
};

export type QmChannelOperationRequest = {
  [Name in QmChannelOperationName]: NamedOperation<QmChannelOperationInput, Name>;
}[QmChannelOperationName];

export interface QmAuthorizationProof {
  actorId: string;
  capabilityId: string;
  resourceRevision: string;
  checkedAt: string;
  decision: "allowed";
}

export type CheckedQmChannelOperation = QmChannelOperationRequest & { authorization: QmAuthorizationProof };

type PresentationOperation<Name extends PhotonPresentationOperationName> = {
  operationId: string;
  attemptId: string;
  name: Name;
  conversation: ConversationReference;
  idempotencyKey: string;
  input: PhotonPresentationOperationInput[Name];
};

export type PhotonPresentationOperation = {
  [Name in PhotonPresentationOperationName]: PresentationOperation<Name>;
}[PhotonPresentationOperationName];

export interface PhotonOperationReference {
  operationId: string;
  name: PhotonPresentationOperationName;
  conversation: ConversationReference;
  idempotencyKey: string;
}

export interface ConfirmedMessagePart {
  logicalPartIndex: number;
  part: MessagePartReference;
  providerReceipt?: { providerMessageId: string; providerPartIndex: number };
}

export type PhotonProviderReceipt =
  | { receiptType: "poll"; pollMessageGuid: string; optionIdentifiers: readonly string[] }
  | { receiptType: "chat"; chatGuid: string; participantIds: readonly string[]; displayName?: string }
  | { receiptType: "app-card"; session: PhotonAppCardSession };

export type PhotonOperationOutcome =
  | {
      kind: "confirmed-message";
      operation: PhotonOperationReference;
      message: MessageReference;
      confirmedParts: readonly ConfirmedMessagePart[];
      providerReceipt?: PhotonProviderReceipt;
    }
  | {
      kind: "confirmed-no-message";
      operation: PhotonOperationReference;
      providerReceipt?: PhotonProviderReceipt;
    }
  | {
      kind: "unsupported";
      operation: PhotonOperationReference;
      capability: string;
      reason: string;
    }
  | {
      kind: "failed";
      operation: PhotonOperationReference;
      code: string;
      retryable: boolean;
      confirmedParts: readonly ConfirmedMessagePart[];
    }
  | {
      kind: "ambiguous";
      operation: PhotonOperationReference;
      reconciliationKey: string;
      confirmedParts: readonly ConfirmedMessagePart[];
    };

export interface PhotonReconciliationEvidence {
  operation: PhotonOperationReference;
  observedAt: string;
  source: string;
  outcome: Extract<PhotonOperationOutcome, { kind: "confirmed-message" | "confirmed-no-message" | "failed" }>;
}

export interface ActionBinding {
  bindingId: string;
  actor: ProviderActorReference;
  resource: { resourceType: string; resourceId: string };
  resourceRevision: string;
  allowedAction: QmChannelOperationName;
  expiresAt: string;
  session: { sessionId: string };
  conversation: ConversationReference;
}

export type InstallationDisplayStatus =
  | { state: "not-started"; installationId: string }
  | {
      state: "awaiting-authorization";
      installationId: string;
      userCode: string;
      verificationUrl: string;
      expiresAt: string;
    }
  | { state: "provisioning" | "needs-owner-rebind" | "needs-credential-repair"; installationId: string }
  | {
      state: "connected";
      installationId: string;
      projectId: string;
      lines: readonly Pick<LineReference, "lineId" | "maskedAddress">[];
    }
  | { state: "failed"; installationId: string; safeCode: string };

export type PrivateInstallationStatus = InstallationDisplayStatus & {
  management?: { accessToken?: string; credentialPath?: string };
  managementOrigin?: string;
  runtime?: { projectSecret?: string; credentialCiphertext?: string };
  deviceCode?: string;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (unexpected.length > 0) throw new TypeError(`${label} contains unsupported fields: ${unexpected.join(",")}`);
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

function sequenceString(value: Record<string, unknown>, key: string, label: string, optional = false): void {
  const field = value[key];
  if (optional && field === undefined) return;
  if (typeof field !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(field) || !Number.isSafeInteger(Number(field))) {
    throw new TypeError(`${label}.${key} must be a canonical non-negative safe integer string`);
  }
}

function isoTimestamp(value: Record<string, unknown>, key: string, label: string): void {
  const field = stringField(value, key, label);
  const parsed = Date.parse(field);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== field) {
    throw new TypeError(`${label}.${key} must be a canonical ISO timestamp`);
  }
}

function member<T extends readonly string[]>(value: unknown, values: T, label: string): asserts value is T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${label} is unsupported`);
}

export function assertJsonSafe(
  value: unknown,
  label = "value",
  seen = new WeakSet<object>(),
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain finite numbers`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${label} must be JSON-safe`);
  if (seen.has(value)) throw new TypeError(`${label} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must not contain sparse arrays`);
      assertJsonSafe(value[index], `${label}[${index}]`, seen);
    }
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must contain plain objects`);
  for (const [key, entry] of Object.entries(value)) assertJsonSafe(entry, `${label}.${key}`, seen);
  seen.delete(value);
}

function installationReference(value: unknown, label: string): asserts value is InstallationReference {
  const input = record(value, label);
  exactKeys(input, ["installationId", "projectId"], label);
  stringField(input, "installationId", label);
  optionalString(input, "projectId", label);
}

function providerScope(value: unknown, label: string): asserts value is ProviderScope {
  const input = record(value, label);
  member(input.provider, PHOTON_PROVIDER_NAMES, `${label}.provider`);
  stringField(input, "installationId", label);
}

function lineReference(value: unknown, label: string, extended = false): asserts value is LineReference {
  providerScope(value, label);
  const input = record(value, label);
  if (!extended) exactKeys(input, ["provider", "installationId", "projectId", "lineId", "maskedAddress"], label);
  optionalString(input, "projectId", label);
  stringField(input, "lineId", label);
  optionalString(input, "maskedAddress", label);
}

function conversationReference(
  value: unknown,
  label: string,
  extended = false,
): asserts value is ConversationReference {
  lineReference(value, label, true);
  const input = record(value, label);
  if (!extended)
    exactKeys(input, ["provider", "installationId", "projectId", "lineId", "maskedAddress", "conversationId"], label);
  stringField(input, "conversationId", label);
}

function messagePartIdentity(value: unknown, label: string, extended = false): asserts value is MessagePartIdentity {
  const input = record(value, label);
  if (!extended) exactKeys(input, ["messageId", "partIndex"], label);
  stringField(input, "messageId", label);
  if (!Number.isSafeInteger(input.partIndex) || (input.partIndex as number) < 0) {
    throw new TypeError(`${label}.partIndex must be a non-negative safe integer`);
  }
}

function messagePartReference(value: unknown, label: string): asserts value is MessagePartReference {
  conversationReference(value, label, true);
  messagePartIdentity(value, label, true);
  exactKeys(
    record(value, label),
    ["provider", "installationId", "projectId", "lineId", "maskedAddress", "conversationId", "messageId", "partIndex"],
    label,
  );
}

function messageTargetReference(value: unknown, label: string): asserts value is MessageTargetReference {
  conversationReference(value, label, true);
  const input = record(value, label);
  exactKeys(
    input,
    ["provider", "installationId", "projectId", "lineId", "maskedAddress", "conversationId", "messageId", "partIndex"],
    label,
  );
  stringField(input, "messageId", label);
  if (input.partIndex !== undefined && (!Number.isSafeInteger(input.partIndex) || (input.partIndex as number) < 0)) {
    throw new TypeError(`${label}.partIndex must be a non-negative safe integer when present`);
  }
}

function sameScope(left: ProviderScope, right: ProviderScope): boolean {
  return left.provider === right.provider && left.installationId === right.installationId;
}

function sameConversation(left: ConversationReference, right: ConversationReference): boolean {
  return sameScope(left, right) && left.lineId === right.lineId && left.conversationId === right.conversationId;
}

function requireConversationScope(
  event: ProviderEventIdentity,
  conversation: ConversationReference,
  label: string,
): void {
  if (!sameScope(event, conversation) || event.lineId !== conversation.lineId) {
    throw new TypeError(`${label} contradicts the event provider, installation, or line`);
  }
}

function requirePartScope(part: ConversationReference, conversation: ConversationReference, label: string): void {
  if (!sameConversation(part, conversation)) throw new TypeError(`${label} contradicts the event conversation`);
}

function messageReference(value: unknown, label: string): asserts value is MessageReference {
  const input = record(value, label);
  exactKeys(input, ["conversation", "messageId", "parts"], label);
  conversationReference(input.conversation, `${label}.conversation`);
  stringField(input, "messageId", label);
  if (!Array.isArray(input.parts) || input.parts.length === 0) throw new TypeError(`${label}.parts must be non-empty`);
  const identities = new Set<string>();
  input.parts.forEach((part, index) => {
    messagePartIdentity(part, `${label}.parts[${index}]`);
    const parsed = part as MessagePartIdentity;
    const identity = `${JSON.stringify(parsed.messageId)}:${parsed.partIndex}`;
    if (identities.has(identity)) throw new TypeError(`${label}.parts contains an overlapping identity`);
    identities.add(identity);
  });
}

function actorReference(value: unknown, label: string): asserts value is ProviderActorReference {
  const input = record(value, label);
  exactKeys(input, ["actorId", "kind", "canonicalIdentityId", "providerAddress"], label);
  stringField(input, "actorId", label);
  member(input.kind, ["human", "agent", "system"] as const, `${label}.kind`);
  optionalString(input, "canonicalIdentityId", label);
  optionalString(input, "providerAddress", label);
}

function providerEventIdentity(value: unknown, label: string): asserts value is ProviderEventIdentity {
  providerScope(value, label);
  const input = record(value, label);
  exactKeys(input, ["provider", "installationId", "eventId", "lineId", "sequence", "occurredAt", "direction"], label);
  stringField(input, "eventId", label);
  optionalString(input, "lineId", label);
  sequenceString(input, "sequence", label, true);
  isoTimestamp(input, "occurredAt", label);
  member(input.direction, PHOTON_EVENT_DIRECTIONS, `${label}.direction`);
}

function attachmentReference(value: unknown, label: string): asserts value is AttachmentReference {
  conversationReference(value, label, true);
  messagePartIdentity(value, label, true);
  const input = record(value, label);
  exactKeys(
    input,
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
    label,
  );
  stringField(input, "attachmentId", label);
  stringField(input, "providerReference", label);
  optionalString(input, "fileName", label);
  optionalString(input, "mediaType", label);
  if (input.byteLength !== undefined && (!Number.isSafeInteger(input.byteLength) || (input.byteLength as number) < 0)) {
    throw new TypeError(`${label}.byteLength must be a non-negative safe integer`);
  }
}

function outboundAttachmentReference(value: unknown, label: string): asserts value is OutboundAttachmentReference {
  const input = record(value, label);
  exactKeys(input, ["attachmentId", "providerReference", "fileName", "mediaType", "byteLength"], label);
  stringField(input, "attachmentId", label);
  stringField(input, "providerReference", label);
  optionalString(input, "fileName", label);
  optionalString(input, "mediaType", label);
  if (input.byteLength !== undefined && (!Number.isSafeInteger(input.byteLength) || (input.byteLength as number) < 0)) {
    throw new TypeError(`${label}.byteLength must be a non-negative safe integer`);
  }
}

function httpsUrl(value: Record<string, unknown>, key: string, label: string): void {
  const url = stringField(value, key, label);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`${label}.${key} must be an absolute https URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new TypeError(`${label}.${key} must be an absolute https URL without credentials`);
  }
}

function messageEffect(value: unknown, label: string): void {
  member(value, PHOTON_MESSAGE_EFFECTS, label);
}

function appCardSpec(value: unknown, label: string): void {
  const input = record(value, label);
  member(input.provider, PHOTON_PROVIDER_NAMES, `${label}.provider`);
  stringField(input, "cardId", label);
  httpsUrl(input, "url", label);
  if (input.live !== undefined && typeof input.live !== "boolean") throw new TypeError(`${label}.live must be boolean`);
  if (input.provider === "spectrum-imessage") {
    exactKeys(input, ["provider", "cardId", "url", "live"], label);
    return;
  }
  exactKeys(
    input,
    ["provider", "cardId", "appName", "appStoreId", "extensionBundleId", "layout", "live", "teamId", "url"],
    label,
  );
  stringField(input, "appName", label);
  if (
    input.appStoreId !== undefined &&
    (!Number.isSafeInteger(input.appStoreId) || (input.appStoreId as number) <= 0)
  ) {
    throw new TypeError(`${label}.appStoreId must be a positive safe integer`);
  }
  stringField(input, "extensionBundleId", label);
  if ((input.extensionBundleId as string).includes(":")) {
    throw new TypeError(`${label}.extensionBundleId cannot contain a colon`);
  }
  if (!/^[A-Z0-9]{10}$/u.test(stringField(input, "teamId", label))) {
    throw new TypeError(`${label}.teamId must be 10 uppercase alphanumeric characters`);
  }
  const layout = record(input.layout, `${label}.layout`);
  const layoutFields = [
    "caption",
    "image",
    "imageSubtitle",
    "imageTitle",
    "subcaption",
    "summary",
    "trailingCaption",
    "trailingSubcaption",
  ];
  exactKeys(layout, layoutFields, `${label}.layout`);
  for (const field of layoutFields.filter((field) => field !== "image")) {
    optionalString(layout, field, `${label}.layout`);
  }
  if (layout.image !== undefined) {
    outboundAttachmentReference(layout.image, `${label}.layout.image`);
    if ((layout.image as OutboundAttachmentReference).mediaType !== "image/jpeg") {
      throw new TypeError(`${label}.layout.image.mediaType must be image/jpeg`);
    }
  }
  if (
    !["caption", "image", "subcaption", "trailingCaption", "trailingSubcaption"].some(
      (field) => layout[field] !== undefined,
    )
  ) {
    throw new TypeError(`${label}.layout must contain visible content`);
  }
  if ((layout.image === undefined) !== (layout.imageTitle === undefined)) {
    throw new TypeError(`${label}.layout.image and imageTitle must be provided together`);
  }
  if (layout.imageSubtitle !== undefined && layout.image === undefined) {
    throw new TypeError(`${label}.layout.image is required with imageSubtitle`);
  }
}

function appCardHandle(value: unknown, label: string, conversation: ConversationReference): void {
  const input = record(value, label);
  member(input.provider, PHOTON_PROVIDER_NAMES, `${label}.provider`);
  stringField(input, "cardId", label);
  stringField(input, "revision", label);
  if (input.provider !== conversation.provider)
    throw new TypeError(`${label}.provider contradicts the operation provider`);
  if (input.provider === "spectrum-imessage") {
    exactKeys(input, ["provider", "cardId", "target", "session", "revision"], label);
    messageTargetReference(input.target, `${label}.target`);
    if (!sameConversation(input.target as MessageTargetReference, conversation)) {
      throw new TypeError(`${label}.target contradicts the operation conversation`);
    }
    appCardSession(input.session, `${label}.session`);
    if (
      (input.session as PhotonAppCardSession).targetMessageGuid !== (input.target as MessageTargetReference).messageId
    ) {
      throw new TypeError(`${label}.session.targetMessageGuid contradicts ${label}.target.messageId`);
    }
  } else {
    exactKeys(input, ["provider", "cardId", "session", "revision"], label);
    appCardSession(input.session, `${label}.session`);
  }
  if ((input.session as PhotonAppCardSession).chatGuid !== conversation.conversationId) {
    throw new TypeError(`${label}.session.chatGuid contradicts the operation conversation`);
  }
}

function appCardSession(value: unknown, label: string): void {
  const input = record(value, label);
  exactKeys(input, ["chatGuid", "messageGuid", "sessionId", "targetMessageGuid"], label);
  stringField(input, "chatGuid", label);
  stringField(input, "messageGuid", label);
  stringField(input, "sessionId", label);
  stringField(input, "targetMessageGuid", label);
}

function nonNegativeInteger(input: Record<string, unknown>, key: string, label: string): void {
  if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 0) {
    throw new TypeError(`${label}.${key} must be a non-negative safe integer`);
  }
}

function inboundEditContent(value: unknown, label: string): void {
  const input = record(value, label);
  exactKeys(
    input,
    ["attachments", "formatting", "mentions", "text", "balloonBundleId", "expressiveSendStyleId", "miniApp"],
    label,
  );
  if (!Array.isArray(input.attachments)) throw new TypeError(`${label}.attachments must be an array`);
  input.attachments.forEach((attachment, index) => {
    const item = record(attachment, `${label}.attachments[${index}]`);
    exactKeys(
      item,
      [
        "companionKind",
        "fileName",
        "guid",
        "isHidden",
        "isOutgoing",
        "isSticker",
        "mimeType",
        "originalGuid",
        "totalBytes",
        "transferState",
        "uti",
      ],
      `${label}.attachments[${index}]`,
    );
    if (item.companionKind !== undefined) {
      member(
        item.companionKind,
        ["live-photo-video", "unknown"] as const,
        `${label}.attachments[${index}].companionKind`,
      );
    }
    stringField(item, "fileName", `${label}.attachments[${index}]`);
    stringField(item, "guid", `${label}.attachments[${index}]`);
    for (const field of ["isHidden", "isOutgoing", "isSticker"]) {
      if (typeof item[field] !== "boolean") {
        throw new TypeError(`${label}.attachments[${index}].${field} must be boolean`);
      }
    }
    stringField(item, "mimeType", `${label}.attachments[${index}]`);
    optionalString(item, "originalGuid", `${label}.attachments[${index}]`);
    nonNegativeInteger(item, "totalBytes", `${label}.attachments[${index}]`);
    member(
      item.transferState,
      ["pending", "transferring", "failed", "finished", "unknown"] as const,
      `${label}.attachments[${index}].transferState`,
    );
    stringField(item, "uti", `${label}.attachments[${index}]`);
  });
  if (!Array.isArray(input.formatting)) throw new TypeError(`${label}.formatting must be an array`);
  input.formatting.forEach((format, index) => {
    const item = record(format, `${label}.formatting[${index}]`);
    exactKeys(item, ["type", "start", "length", "effectName"], `${label}.formatting[${index}]`);
    stringField(item, "type", `${label}.formatting[${index}]`);
    nonNegativeInteger(item, "start", `${label}.formatting[${index}]`);
    nonNegativeInteger(item, "length", `${label}.formatting[${index}]`);
    optionalString(item, "effectName", `${label}.formatting[${index}]`);
  });
  if (!Array.isArray(input.mentions)) throw new TypeError(`${label}.mentions must be an array`);
  input.mentions.forEach((mention, index) => {
    const item = record(mention, `${label}.mentions[${index}]`);
    exactKeys(item, ["address", "start", "length"], `${label}.mentions[${index}]`);
    stringField(item, "address", `${label}.mentions[${index}]`);
    nonNegativeInteger(item, "start", `${label}.mentions[${index}]`);
    nonNegativeInteger(item, "length", `${label}.mentions[${index}]`);
  });
  optionalString(input, "text", label);
  optionalString(input, "balloonBundleId", label);
  optionalString(input, "expressiveSendStyleId", label);
  if (input.miniApp !== undefined) inboundMiniAppContent(input.miniApp, `${label}.miniApp`);
}

function inboundMiniAppContent(value: unknown, label: string): void {
  const input = record(value, label);
  exactKeys(
    input,
    ["extensionBundleId", "teamId", "live", "appName", "appStoreId", "sessionId", "url", "layout"],
    label,
  );
  stringField(input, "extensionBundleId", label);
  stringField(input, "teamId", label);
  if (typeof input.live !== "boolean") throw new TypeError(`${label}.live must be boolean`);
  optionalString(input, "appName", label);
  if (
    input.appStoreId !== undefined &&
    (!Number.isSafeInteger(input.appStoreId) || (input.appStoreId as number) <= 0)
  ) {
    throw new TypeError(`${label}.appStoreId must be a positive safe integer`);
  }
  optionalString(input, "sessionId", label);
  optionalString(input, "url", label);
  if (input.layout !== undefined) {
    const layout = record(input.layout, `${label}.layout`);
    const fields = [
      "caption",
      "imageSubtitle",
      "imageTitle",
      "subcaption",
      "summary",
      "trailingCaption",
      "trailingSubcaption",
    ];
    exactKeys(layout, fields, `${label}.layout`);
    fields.forEach((field) => optionalString(layout, field, `${label}.layout`));
  }
}

function editableContent(value: unknown, label: string, conversation: ConversationReference): void {
  const input = record(value, label);
  member(input.kind, ["text", "markdown", "app"] as const, `${label}.kind`);
  if (input.kind === "text") {
    exactKeys(input, ["kind", "text"], label);
    stringField(input, "text", label);
  } else if (input.kind === "markdown") {
    exactKeys(input, ["kind", "markdown"], label);
    stringField(input, "markdown", label);
  } else {
    exactKeys(input, ["kind", "app"], label);
    appCardSpec(input.app, `${label}.app`);
    if ((input.app as PhotonAppCardSpec).provider !== conversation.provider) {
      throw new TypeError(`${label}.app.provider contradicts the operation provider`);
    }
  }
}

function multipartPart(value: unknown, label: string): void {
  const input = record(value, label);
  member(input.kind, ["text", "markdown", "attachment", "link"] as const, `${label}.kind`);
  if (input.kind === "text") {
    exactKeys(input, ["kind", "text"], label);
    stringField(input, "text", label);
  } else if (input.kind === "markdown") {
    exactKeys(input, ["kind", "markdown"], label);
    stringField(input, "markdown", label);
  } else if (input.kind === "attachment") {
    exactKeys(input, ["kind", "attachment"], label);
    outboundAttachmentReference(input.attachment, `${label}.attachment`);
  } else {
    exactKeys(input, ["kind", "url", "preview"], label);
    httpsUrl(input, "url", label);
    if (typeof input.preview !== "boolean") throw new TypeError(`${label}.preview must be boolean`);
  }
}

function reaction(value: unknown, label: string): void {
  const input = record(value, label);
  member(input.kind, ["love", "like", "dislike", "laugh", "emphasize", "question", "emoji"] as const, `${label}.kind`);
  if (input.kind === "emoji") {
    exactKeys(input, ["kind", "emoji"], label);
    if (typeof input.emoji !== "string" || input.emoji.trim().length === 0) {
      throw new TypeError(`${label}.emoji must be a non-blank string`);
    }
  } else exactKeys(input, ["kind"], label);
}

function orderedContent(
  value: unknown,
  label: string,
  conversation: ConversationReference,
  message: MessageReference,
): void {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  const declared = new Set(message.parts.map((part) => `${JSON.stringify(part.messageId)}:${part.partIndex}`));
  const represented = new Set();
  value.forEach((item, index) => {
    const current = record(item, `${label}[${index}]`);
    member(current.kind, ["text", "attachment"] as const, `${label}[${index}].kind`);
    let identity;
    if (current.kind === "text") {
      exactKeys(current, ["kind", "part", "text"], `${label}[${index}]`);
      messagePartIdentity(current.part, `${label}[${index}].part`);
      stringField(current, "text", `${label}[${index}]`);
      identity = current.part as MessagePartIdentity;
    } else {
      exactKeys(current, ["kind", "attachment"], `${label}[${index}]`);
      attachmentReference(current.attachment, `${label}[${index}].attachment`);
      requirePartScope(current.attachment as AttachmentReference, conversation, `${label}[${index}].attachment`);
      identity = current.attachment as AttachmentReference;
    }
    const key = `${JSON.stringify(identity.messageId)}:${identity.partIndex}`;
    if (!declared.has(key)) throw new TypeError(`${label}[${index}] references a part not declared by the message`);
    if (represented.has(key)) throw new TypeError(`${label} contains duplicate part content`);
    represented.add(key);
  });
  if (represented.size !== declared.size)
    throw new TypeError(`${label} does not represent every declared message part`);
}

function observationTarget(value: unknown, label: string, event: ProviderEventIdentity): void {
  const target = record(value, label);
  member(target.kind, ["message", "conversation"] as const, `${label}.kind`);
  if (target.kind === "message") {
    exactKeys(target, ["kind", "message"], label);
    messageTargetReference(target.message, `${label}.message`);
    requireConversationScope(event, target.message as MessageTargetReference, `${label}.message`);
  } else {
    exactKeys(target, ["kind", "conversation"], label);
    conversationReference(target.conversation, `${label}.conversation`);
    requireConversationScope(event, target.conversation as ConversationReference, `${label}.conversation`);
  }
}

export function parseNormalizedPhotonInput(value: unknown): NormalizedPhotonInput {
  assertJsonSafe(value, "normalizedInput");
  const input = record(value, "normalizedInput");
  providerEventIdentity(input.event, "normalizedInput.event");
  const event = input.event as ProviderEventIdentity;
  member(input.kind, PHOTON_EVENT_KINDS, "normalizedInput.kind");
  if (["lifecycle", "unknown", "read", "delivery"].includes(input.kind as string)) {
    if (input.kind === "lifecycle") {
      member(
        input.action,
        ["connected", "disconnected", "reconnecting", "stopped", "catchup-complete"] as const,
        "normalizedInput.action",
      );
      if (input.action === "catchup-complete") {
        exactKeys(input, ["event", "kind", "action", "headSequence"], "normalizedInput");
        sequenceString(input, "headSequence", "normalizedInput");
      } else {
        exactKeys(input, ["event", "kind", "action", "detail"], "normalizedInput");
        if (input.detail !== undefined) record(input.detail, "normalizedInput.detail");
      }
    } else if (input.kind === "unknown") {
      exactKeys(input, ["event", "kind", "rawType", "reason", "conversation", "actor", "payload"], "normalizedInput");
      stringField(input, "rawType", "normalizedInput");
      stringField(input, "reason", "normalizedInput");
      if (input.conversation !== undefined) {
        conversationReference(input.conversation, "normalizedInput.conversation");
        requireConversationScope(event, input.conversation as ConversationReference, "normalizedInput.conversation");
      }
      if (input.actor !== undefined) actorReference(input.actor, "normalizedInput.actor");
      if (input.payload !== undefined) record(input.payload, "normalizedInput.payload");
    } else {
      exactKeys(input, ["event", "kind", "actor", "target"], "normalizedInput");
      if (input.actor !== undefined) actorReference(input.actor, "normalizedInput.actor");
      observationTarget(input.target, "normalizedInput.target", event);
    }
    return value as unknown as NormalizedPhotonInput;
  }
  conversationReference(input.conversation, "normalizedInput.conversation");
  const conversation = input.conversation as ConversationReference;
  requireConversationScope(event, conversation, "normalizedInput.conversation");
  if (input.actor !== undefined) actorReference(input.actor, "normalizedInput.actor");
  if (input.kind === "message") {
    exactKeys(input, ["event", "kind", "conversation", "actor", "message", "content", "replyTo"], "normalizedInput");
    if ((input.actor as ProviderActorReference | undefined)?.kind !== "human") {
      throw new TypeError("normalizedInput.actor must be a human for message events");
    }
    messageReference(input.message, "normalizedInput.message");
    if (!sameConversation((input.message as MessageReference).conversation, conversation)) {
      throw new TypeError("normalizedInput.message contradicts the event conversation");
    }
    orderedContent(input.content, "normalizedInput.content", conversation, input.message as MessageReference);
    if (input.replyTo !== undefined) {
      messagePartReference(input.replyTo, "normalizedInput.replyTo");
      requirePartScope(input.replyTo as ReplyReference, conversation, "normalizedInput.replyTo");
    }
  } else if (input.kind === "edit") {
    exactKeys(input, ["event", "kind", "conversation", "actor", "target", "content"], "normalizedInput");
    messageTargetReference(input.target, "normalizedInput.target");
    requirePartScope(input.target as MessageTargetReference, conversation, "normalizedInput.target");
    inboundEditContent(input.content, "normalizedInput.content");
  } else if (input.kind === "unsend") {
    exactKeys(input, ["event", "kind", "conversation", "actor", "target"], "normalizedInput");
    messageTargetReference(input.target, "normalizedInput.target");
    requirePartScope(input.target as MessageTargetReference, conversation, "normalizedInput.target");
  } else if (input.kind === "reaction") {
    exactKeys(input, ["event", "kind", "conversation", "actor", "target", "reaction"], "normalizedInput");
    if (input.actor === undefined) throw new TypeError("normalizedInput.actor is required for reactions");
    messageTargetReference(input.target, "normalizedInput.target");
    requirePartScope(input.target as MessageTargetReference, conversation, "normalizedInput.target");
    const reaction = record(input.reaction, "normalizedInput.reaction");
    exactKeys(reaction, ["action", "value"], "normalizedInput.reaction");
    member(reaction.action, ["add", "remove"] as const, "normalizedInput.reaction.action");
    stringField(reaction, "value", "normalizedInput.reaction");
  } else if (input.kind === "poll") {
    stringField(input, "pollMessageGuid", "normalizedInput");
    member(input.action, ["created", "voted", "unvoted", "option-added"] as const, "normalizedInput.action");
    if (input.action === "voted" || input.action === "unvoted") {
      exactKeys(
        input,
        ["event", "kind", "conversation", "actor", "pollMessageGuid", "action", "optionIdentifier"],
        "normalizedInput",
      );
      stringField(input, "optionIdentifier", "normalizedInput");
    } else {
      exactKeys(
        input,
        ["event", "kind", "conversation", "actor", "pollMessageGuid", "action", "title", "options"],
        "normalizedInput",
      );
      stringField(input, "title", "normalizedInput");
      if (!Array.isArray(input.options) || input.options.length === 0) {
        throw new TypeError("normalizedInput.options must be a non-empty array");
      }
      input.options.forEach((option, index) => {
        const current = record(option, `normalizedInput.options[${index}]`);
        exactKeys(current, ["optionIdentifier", "text", "creatorId"], `normalizedInput.options[${index}]`);
        stringField(current, "optionIdentifier", `normalizedInput.options[${index}]`);
        stringField(current, "text", `normalizedInput.options[${index}]`);
        optionalString(current, "creatorId", `normalizedInput.options[${index}]`);
      });
      const optionIdentifiers = (input.options as Array<{ optionIdentifier: string }>).map(
        ({ optionIdentifier }) => optionIdentifier,
      );
      if (new Set(optionIdentifiers).size !== optionIdentifiers.length) {
        throw new TypeError("normalizedInput.options must use unique option identifiers");
      }
    }
  } else if (input.kind === "group") {
    member(input.action, ["renamed", "avatar-set", "avatar-cleared"] as const, "normalizedInput.action");
    exactKeys(
      input,
      input.action === "renamed"
        ? ["event", "kind", "conversation", "actor", "action", "displayName"]
        : ["event", "kind", "conversation", "actor", "action"],
      "normalizedInput",
    );
    if (input.action === "renamed") stringField(input, "displayName", "normalizedInput");
  } else if (input.kind === "membership") {
    exactKeys(input, ["event", "kind", "conversation", "actor", "action", "memberIds"], "normalizedInput");
    member(input.action, ["added", "removed", "left"] as const, "normalizedInput.action");
    requireStringArray(input, "memberIds", "normalizedInput");
  }
  return value as unknown as NormalizedPhotonInput;
}

function validateQmInput(name: QmChannelOperationName, value: unknown): void {
  const input = record(value, `checkedOperation.input(${name})`);
  const fields: Record<QmChannelOperationName, readonly string[]> = {
    "turn.start": ["source", "request", "redeliveryKey"],
    "turn.steer": ["runId", "text"],
    "turn.resume": ["sessionId"],
    "approval.resolve": ["bindingId", "decision"],
    "run.signal": ["runId", "signal", "text"],
    "session.share": ["sessionId"],
    "session.rename": ["sessionId", "title"],
    "session.fork": ["sessionId"],
    "loop.fire": ["loopId"],
    "loop.item.act": ["loopId", "itemId", "action"],
    "cron.run": ["cronId"],
    "reach.send": ["destination", "content"],
  };
  exactKeys(input, fields[name], `checkedOperation.input(${name})`);
  if (name === "turn.start") {
    if (input.source !== "photon") throw new TypeError("turn.start source must be photon");
    const request = parseNormalizedPhotonInput(input.request);
    if (request.kind !== "message") throw new TypeError("turn.start.request must be a message event");
    stringField(input, "redeliveryKey", "turn.start");
  } else if (name === "turn.steer") {
    stringField(input, "runId", name);
    stringField(input, "text", name);
  } else if (name === "turn.resume" || name.startsWith("session.")) {
    stringField(input, "sessionId", name);
    if (name === "session.rename") stringField(input, "title", name);
  } else if (name === "approval.resolve") {
    stringField(input, "bindingId", name);
    member(input.decision, ["approve", "deny"] as const, `${name}.decision`);
  } else if (name === "run.signal") {
    stringField(input, "runId", name);
    member(input.signal, ["abort", "steer"] as const, `${name}.signal`);
    optionalString(input, "text", name);
    if (input.signal === "steer" && input.text === undefined) throw new TypeError("run.signal steer requires text");
  } else if (name === "loop.fire") stringField(input, "loopId", name);
  else if (name === "loop.item.act") {
    stringField(input, "loopId", name);
    stringField(input, "itemId", name);
    stringField(input, "action", name);
  } else if (name === "cron.run") stringField(input, "cronId", name);
  else {
    const destination = record(input.destination, "reach.send.destination");
    member(destination.kind, ["principal", "channel", "group"] as const, "reach.send.destination.kind");
    if (destination.kind === "principal") {
      exactKeys(destination, ["kind", "principalId"], "reach.send.destination");
      stringField(destination, "principalId", "reach.send.destination");
    } else if (destination.kind === "channel") {
      exactKeys(destination, ["kind", "channelId"], "reach.send.destination");
      stringField(destination, "channelId", "reach.send.destination");
    } else {
      exactKeys(destination, ["kind", "participantIds"], "reach.send.destination");
      requireStringArray(destination, "participantIds", "reach.send.destination");
    }
    const content = record(input.content, "reach.send.content");
    exactKeys(content, ["text", "attachments"], "reach.send.content");
    optionalString(content, "text", "reach.send.content");
    if (content.attachments !== undefined) {
      if (!Array.isArray(content.attachments) || content.attachments.length === 0) {
        throw new TypeError("reach.send.content.attachments must be a non-empty array when present");
      }
      content.attachments.forEach((attachment, index) =>
        outboundAttachmentReference(attachment, `reach.send.content.attachments[${index}]`),
      );
    }
    if (content.text === undefined && content.attachments === undefined) {
      throw new TypeError("reach.send.content requires text or attachments");
    }
  }
}

export function parseQmChannelOperationRequest(value: unknown): QmChannelOperationRequest {
  assertJsonSafe(value, "operationRequest");
  const input = record(value, "operationRequest");
  exactKeys(input, ["operationId", "name", "actorId", "sessionId", "idempotencyKey", "input"], "operationRequest");
  stringField(input, "operationId", "operationRequest");
  member(input.name, QM_CHANNEL_OPERATIONS, "operationRequest.name");
  stringField(input, "actorId", "operationRequest");
  optionalString(input, "sessionId", "operationRequest");
  stringField(input, "idempotencyKey", "operationRequest");
  validateQmInput(input.name as QmChannelOperationName, input.input);
  const operationInput = input.input as Record<string, unknown>;
  if (
    input.sessionId !== undefined &&
    operationInput.sessionId !== undefined &&
    input.sessionId !== operationInput.sessionId
  ) {
    throw new TypeError("operationRequest sessionId contradicts input.sessionId");
  }
  return value as QmChannelOperationRequest;
}

export function parseCheckedQmChannelOperation(value: unknown): CheckedQmChannelOperation {
  assertJsonSafe(value, "checkedOperation");
  const input = record(value, "checkedOperation");
  exactKeys(
    input,
    ["operationId", "name", "actorId", "sessionId", "idempotencyKey", "input", "authorization"],
    "checkedOperation",
  );
  const request = parseQmChannelOperationRequest({
    operationId: input.operationId,
    name: input.name,
    actorId: input.actorId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    idempotencyKey: input.idempotencyKey,
    input: input.input,
  });
  const authorization = record(input.authorization, "checkedOperation.authorization");
  exactKeys(
    authorization,
    ["actorId", "capabilityId", "resourceRevision", "checkedAt", "decision"],
    "checkedOperation.authorization",
  );
  stringField(authorization, "actorId", "checkedOperation.authorization");
  stringField(authorization, "capabilityId", "checkedOperation.authorization");
  stringField(authorization, "resourceRevision", "checkedOperation.authorization");
  isoTimestamp(authorization, "checkedAt", "checkedOperation.authorization");
  if (authorization.decision !== "allowed")
    throw new TypeError("checkedOperation.authorization.decision must be allowed");
  if (authorization.actorId !== request.actorId)
    throw new TypeError("checkedOperation actor does not match authorization actor");
  return value as unknown as CheckedQmChannelOperation;
}

function requireStringArray(input: Record<string, unknown>, key: string, label: string, minimum = 1): void {
  if (
    !Array.isArray(input[key]) ||
    input[key].length < minimum ||
    (input[key] as unknown[]).some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    throw new TypeError(`${label}.${key} must contain at least ${minimum} non-blank strings`);
  }
}

function validatePresentationInput(
  name: PhotonPresentationOperationName,
  value: unknown,
  conversation: ConversationReference,
): void {
  const input = record(value, `presentationOperation.input(${name})`);
  const fields: Record<PhotonPresentationOperationName, readonly string[]> = {
    "message.text": ["text", "replyTo", "effect", "enableLinkPreview"],
    "message.markdown": ["markdown", "replyTo", "effect", "enableLinkPreview"],
    "message.text.stream": ["format", "replyTo", "effect"],
    "message.link": ["url", "preview", "replyTo"],
    "message.multipart": ["parts", "replyTo", "effect"],
    "message.attachment": ["attachment", "replyTo", "effect"],
    "message.voice": ["attachment"],
    "message.contact": ["vcard"],
    "message.poll.create": ["title", "options"],
    "message.poll.vote": ["pollMessageGuid", "optionIdentifier"],
    "message.poll.unvote": ["pollMessageGuid"],
    "message.poll.add-option": ["pollMessageGuid", "text"],
    "message.app.send": ["app"],
    "message.app.update": ["handle", "app"],
    "message.react": ["target", "action", "reaction"],
    "message.edit": ["target", "content"],
    "message.unsend": ["target"],
    "conversation.typing": ["active"],
    "conversation.read": ["target"],
    "conversation.rename": ["title"],
    "conversation.avatar.set": ["attachment"],
    "conversation.avatar.clear": [],
    "conversation.membership.add": ["participantIds"],
    "conversation.membership.remove": ["participantIds"],
    "conversation.membership.leave": [],
  };
  exactKeys(input, fields[name], `presentationOperation.input(${name})`);
  if (name === "message.text" || name === "message.markdown") {
    stringField(input, name === "message.text" ? "text" : "markdown", name);
    if (input.effect !== undefined) messageEffect(input.effect, `${name}.effect`);
    if (input.enableLinkPreview !== undefined && typeof input.enableLinkPreview !== "boolean") {
      throw new TypeError(`${name}.enableLinkPreview must be boolean when present`);
    }
    if (input.replyTo !== undefined) {
      messagePartReference(input.replyTo, `${name}.replyTo`);
      requirePartScope(input.replyTo as ReplyReference, conversation, `${name}.replyTo`);
    }
  } else if (name === "message.text.stream") {
    member(input.format, ["plain", "markdown"] as const, `${name}.format`);
    if (input.effect !== undefined) messageEffect(input.effect, `${name}.effect`);
    if (input.replyTo !== undefined) {
      messagePartReference(input.replyTo, `${name}.replyTo`);
      requirePartScope(input.replyTo as ReplyReference, conversation, `${name}.replyTo`);
    }
  } else if (name === "message.link") {
    httpsUrl(input, "url", name);
    if (typeof input.preview !== "boolean") throw new TypeError(`${name}.preview must be boolean`);
    if (input.replyTo !== undefined) {
      messagePartReference(input.replyTo, `${name}.replyTo`);
      requirePartScope(input.replyTo as ReplyReference, conversation, `${name}.replyTo`);
    }
  } else if (name === "message.multipart") {
    if (!Array.isArray(input.parts) || input.parts.length === 0) throw new TypeError(`${name}.parts must be non-empty`);
    input.parts.forEach((part, index) => multipartPart(part, `${name}.parts[${index}]`));
    if (input.effect !== undefined) messageEffect(input.effect, `${name}.effect`);
    if (input.replyTo !== undefined) {
      messagePartReference(input.replyTo, `${name}.replyTo`);
      requirePartScope(input.replyTo as ReplyReference, conversation, `${name}.replyTo`);
    }
  } else if (["message.attachment", "message.voice", "conversation.avatar.set"].includes(name)) {
    outboundAttachmentReference(input.attachment, `${name}.attachment`);
    if (name === "message.attachment") {
      if (input.effect !== undefined) messageEffect(input.effect, `${name}.effect`);
      if (input.replyTo !== undefined) {
        messagePartReference(input.replyTo, `${name}.replyTo`);
        requirePartScope(input.replyTo as ReplyReference, conversation, `${name}.replyTo`);
      }
    }
  } else if (name === "message.contact") stringField(input, "vcard", name);
  else if (name === "message.poll.create") {
    if (stringField(input, "title", name).trim().length === 0) throw new TypeError(`${name}.title must be non-blank`);
    requireStringArray(input, "options", name, 2);
  } else if (name === "message.poll.vote") {
    stringField(input, "pollMessageGuid", name);
    stringField(input, "optionIdentifier", name);
  } else if (name === "message.poll.unvote") {
    stringField(input, "pollMessageGuid", name);
  } else if (name === "message.poll.add-option") {
    stringField(input, "pollMessageGuid", name);
    if (stringField(input, "text", name).trim().length === 0) throw new TypeError(`${name}.text must be non-blank`);
  } else if (name === "message.app.send") {
    appCardSpec(input.app, `${name}.app`);
    if ((input.app as PhotonAppCardSpec).provider !== conversation.provider) {
      throw new TypeError(`${name}.app.provider contradicts the operation provider`);
    }
  } else if (name === "message.app.update") {
    appCardHandle(input.handle, `${name}.handle`, conversation);
    appCardSpec(input.app, `${name}.app`);
    if ((input.handle as PhotonAppCardHandle).cardId !== (input.app as PhotonAppCardSpec).cardId) {
      throw new TypeError(`${name}.handle.cardId contradicts ${name}.app.cardId`);
    }
    if ((input.app as PhotonAppCardSpec).provider !== conversation.provider) {
      throw new TypeError(`${name}.app.provider contradicts the operation provider`);
    }
  } else if (["message.react", "message.edit", "message.unsend"].includes(name)) {
    messageTargetReference(input.target, `${name}.target`);
    requirePartScope(input.target as MessagePartReference, conversation, `${name}.target`);
    if (name === "message.react") {
      member(input.action, ["add", "remove"] as const, `${name}.action`);
      reaction(input.reaction, `${name}.reaction`);
    }
    if (name === "message.edit") {
      editableContent(input.content, `${name}.content`, conversation);
      if (conversation.provider === "advanced-imessage" && (input.content as PhotonEditableContent).kind !== "text") {
        throw new TypeError(`${name}.content must be text for Advanced iMessage`);
      }
    }
  } else if (name === "conversation.typing") {
    if (typeof input.active !== "boolean") throw new TypeError(`${name}.active must be boolean`);
  } else if (name === "conversation.read" && input.target !== undefined) {
    messageTargetReference(input.target, `${name}.target`);
    requirePartScope(input.target as MessagePartReference, conversation, `${name}.target`);
  } else if (name === "conversation.rename") stringField(input, "title", name);
  else if (name === "conversation.membership.add" || name === "conversation.membership.remove") {
    requireStringArray(input, "participantIds", name);
  }
}

export function parsePhotonPresentationOperation(value: unknown): PhotonPresentationOperation {
  assertJsonSafe(value, "presentationOperation");
  const input = record(value, "presentationOperation");
  exactKeys(
    input,
    ["operationId", "attemptId", "name", "conversation", "idempotencyKey", "input"],
    "presentationOperation",
  );
  stringField(input, "operationId", "presentationOperation");
  stringField(input, "attemptId", "presentationOperation");
  member(input.name, PHOTON_PRESENTATION_OPERATIONS, "presentationOperation.name");
  conversationReference(input.conversation, "presentationOperation.conversation");
  stringField(input, "idempotencyKey", "presentationOperation");
  validatePresentationInput(
    input.name as PhotonPresentationOperationName,
    input.input,
    input.conversation as ConversationReference,
  );
  return value as unknown as PhotonPresentationOperation;
}

function operationReference(value: unknown, label: string): asserts value is PhotonOperationReference {
  const input = record(value, label);
  exactKeys(input, ["operationId", "name", "conversation", "idempotencyKey"], label);
  stringField(input, "operationId", label);
  member(input.name, PHOTON_PRESENTATION_OPERATIONS, `${label}.name`);
  conversationReference(input.conversation, `${label}.conversation`);
  stringField(input, "idempotencyKey", label);
}

function confirmedPart(value: unknown, label: string, operation: PhotonOperationReference): void {
  const input = record(value, label);
  exactKeys(input, ["logicalPartIndex", "part", "providerReceipt"], label);
  if (!Number.isSafeInteger(input.logicalPartIndex) || (input.logicalPartIndex as number) < 0) {
    throw new TypeError(`${label}.logicalPartIndex must be a non-negative safe integer`);
  }
  messagePartReference(input.part, `${label}.part`);
  if (!sameConversation(input.part as MessagePartReference, operation.conversation)) {
    throw new TypeError(`${label}.part contradicts the operation conversation`);
  }
  if (input.providerReceipt !== undefined) {
    const receipt = record(input.providerReceipt, `${label}.providerReceipt`);
    exactKeys(receipt, ["providerMessageId", "providerPartIndex"], `${label}.providerReceipt`);
    stringField(receipt, "providerMessageId", `${label}.providerReceipt`);
    if (!Number.isSafeInteger(receipt.providerPartIndex) || (receipt.providerPartIndex as number) < 0) {
      throw new TypeError(`${label}.providerReceipt.providerPartIndex must be a non-negative safe integer`);
    }
  }
}

const noMessageOperations: Record<
  PhotonProviderName,
  ReadonlyMap<PhotonPresentationOperationName, "void" | "poll" | "chat" | "app-card">
> = {
  "spectrum-imessage": new Map<PhotonPresentationOperationName, "void" | "poll" | "chat" | "app-card">([
    ["message.app.update", "app-card"],
    ["message.edit", "void"],
    ["message.unsend", "void"],
    ["conversation.typing", "void"],
    ["conversation.read", "void"],
    ["conversation.rename", "void"],
    ["conversation.avatar.set", "void"],
    ["conversation.avatar.clear", "void"],
    ["conversation.membership.add", "void"],
    ["conversation.membership.remove", "void"],
    ["conversation.membership.leave", "void"],
  ]),
  "advanced-imessage": new Map<PhotonPresentationOperationName, "void" | "poll" | "chat" | "app-card">([
    ["message.poll.vote", "poll"],
    ["message.poll.unvote", "poll"],
    ["message.poll.add-option", "poll"],
    ["message.unsend", "void"],
    ["conversation.typing", "void"],
    ["conversation.read", "void"],
    ["conversation.rename", "chat"],
    ["conversation.avatar.set", "void"],
    ["conversation.avatar.clear", "void"],
    ["conversation.membership.add", "chat"],
    ["conversation.membership.remove", "chat"],
    ["conversation.membership.leave", "void"],
  ]),
};

function providerReceipt(
  value: unknown,
  mode: "poll" | "chat" | "app-card",
  label: string,
  operation: PhotonOperationReference,
  message?: MessageReference,
): void {
  const input = record(value, label);
  if (mode === "poll") {
    exactKeys(input, ["receiptType", "pollMessageGuid", "optionIdentifiers"], label);
    if (input.receiptType !== "poll") throw new TypeError(`${label}.receiptType must be poll`);
    stringField(input, "pollMessageGuid", label);
    requireStringArray(input, "optionIdentifiers", label);
    if (new Set(input.optionIdentifiers as string[]).size !== (input.optionIdentifiers as string[]).length) {
      throw new TypeError(`${label}.optionIdentifiers must be unique`);
    }
    if (message !== undefined && input.pollMessageGuid !== message.messageId) {
      throw new TypeError(`${label}.pollMessageGuid contradicts the confirmed message`);
    }
  } else if (mode === "chat") {
    exactKeys(input, ["receiptType", "chatGuid", "participantIds", "displayName"], label);
    if (input.receiptType !== "chat") throw new TypeError(`${label}.receiptType must be chat`);
    stringField(input, "chatGuid", label);
    requireStringArray(input, "participantIds", label);
    optionalString(input, "displayName", label);
    if (input.chatGuid !== operation.conversation.conversationId) {
      throw new TypeError(`${label}.chatGuid contradicts the operation conversation`);
    }
  } else {
    exactKeys(input, ["receiptType", "session"], label);
    if (input.receiptType !== "app-card") throw new TypeError(`${label}.receiptType must be app-card`);
    appCardSession(input.session, `${label}.session`);
    const session = input.session as PhotonAppCardSession;
    if (session.chatGuid !== operation.conversation.conversationId) {
      throw new TypeError(`${label}.session.chatGuid contradicts the operation conversation`);
    }
    if (message !== undefined && session.messageGuid !== message.messageId) {
      throw new TypeError(`${label}.session.messageGuid contradicts the confirmed message`);
    }
    if (
      message !== undefined &&
      operation.name === "message.app.send" &&
      session.targetMessageGuid !== message.messageId
    ) {
      throw new TypeError(`${label}.session.targetMessageGuid contradicts the confirmed message`);
    }
  }
}

function confirmedMessageReceiptMode(operation: PhotonOperationReference): "poll" | "app-card" | undefined {
  if (operation.conversation.provider === "advanced-imessage" && operation.name === "message.poll.create")
    return "poll";
  if (
    operation.name === "message.app.send" ||
    (operation.conversation.provider === "advanced-imessage" && operation.name === "message.app.update")
  )
    return "app-card";
  return undefined;
}

export function parsePhotonOperationOutcome(value: unknown): PhotonOperationOutcome {
  assertJsonSafe(value, "operationOutcome");
  const input = record(value, "operationOutcome");
  member(
    input.kind,
    ["confirmed-message", "confirmed-no-message", "unsupported", "failed", "ambiguous"] as const,
    "operationOutcome.kind",
  );
  operationReference(input.operation, "operationOutcome.operation");
  const operation = input.operation as PhotonOperationReference;
  if (
    operation.conversation.provider === "advanced-imessage" &&
    operation.name === "message.contact" &&
    input.kind !== "unsupported"
  ) {
    throw new TypeError("operationOutcome must be unsupported for advanced-imessage message.contact");
  }
  const fields = {
    "confirmed-message": ["kind", "operation", "message", "confirmedParts", "providerReceipt"],
    "confirmed-no-message": ["kind", "operation", "providerReceipt"],
    unsupported: ["kind", "operation", "capability", "reason"],
    failed: ["kind", "operation", "code", "retryable", "confirmedParts"],
    ambiguous: ["kind", "operation", "reconciliationKey", "confirmedParts"],
  } as const;
  exactKeys(input, fields[input.kind as keyof typeof fields], "operationOutcome");
  if (input.kind === "confirmed-message") {
    if (noMessageOperations[operation.conversation.provider].has(operation.name)) {
      throw new TypeError(`operationOutcome cannot confirm a message for ${operation.name}`);
    }
    messageReference(input.message, "operationOutcome.message");
    const message = input.message as MessageReference;
    if (!sameConversation(message.conversation, operation.conversation)) {
      throw new TypeError("operationOutcome.message contradicts the operation conversation");
    }
    if (!Array.isArray(input.confirmedParts)) throw new TypeError("operationOutcome.confirmedParts must be an array");
    const confirmed = input.confirmedParts as ConfirmedMessagePart[];
    const expected = new Set(message.parts.map((_, index) => index));
    const actual = new Set(confirmed.map(({ logicalPartIndex }) => logicalPartIndex));
    if (
      confirmed.length !== expected.size ||
      actual.size !== expected.size ||
      [...actual].some((part) => !expected.has(part)) ||
      confirmed.some(({ logicalPartIndex, part }) => {
        const expectedPart = message.parts[logicalPartIndex];
        return (
          expectedPart === undefined ||
          expectedPart.messageId !== part.messageId ||
          expectedPart.partIndex !== part.partIndex
        );
      })
    ) {
      throw new TypeError("operationOutcome.confirmedParts must exactly confirm every returned message part once");
    }
    const resultMode = confirmedMessageReceiptMode(operation);
    if (resultMode !== undefined && input.providerReceipt === undefined) {
      throw new TypeError(`operationOutcome requires a provider receipt for ${operation.name}`);
    }
    if (resultMode === undefined && input.providerReceipt !== undefined) {
      throw new TypeError(`operationOutcome cannot attach a provider receipt to ${operation.name}`);
    }
    if (resultMode !== undefined) {
      providerReceipt(input.providerReceipt, resultMode, "operationOutcome.providerReceipt", operation, message);
    }
  }
  if (input.kind === "confirmed-no-message") {
    const resultMode = noMessageOperations[operation.conversation.provider].get(operation.name);
    if (resultMode === undefined) {
      throw new TypeError(`operationOutcome cannot confirm an absent message for ${operation.name}`);
    }
    if (
      (resultMode === "poll" || resultMode === "chat" || resultMode === "app-card") &&
      input.providerReceipt === undefined
    ) {
      throw new TypeError(`operationOutcome requires a provider receipt for ${operation.name}`);
    }
    if (resultMode === "void" && input.providerReceipt !== undefined) {
      throw new TypeError(`operationOutcome cannot attach a provider receipt to void ${operation.name}`);
    }
    if (resultMode === "poll" || resultMode === "chat" || resultMode === "app-card") {
      providerReceipt(input.providerReceipt, resultMode, "operationOutcome.providerReceipt", operation);
    }
  }
  if (input.kind === "unsupported") {
    stringField(input, "capability", "operationOutcome");
    stringField(input, "reason", "operationOutcome");
  }
  if (input.kind === "failed") {
    stringField(input, "code", "operationOutcome");
    if (typeof input.retryable !== "boolean") throw new TypeError("operationOutcome.retryable must be boolean");
  }
  if (input.kind === "ambiguous") stringField(input, "reconciliationKey", "operationOutcome");
  if (["confirmed-message", "failed", "ambiguous"].includes(input.kind as string)) {
    if (!Array.isArray(input.confirmedParts)) throw new TypeError("operationOutcome.confirmedParts must be an array");
    input.confirmedParts.forEach((part, index) =>
      confirmedPart(part, `operationOutcome.confirmedParts[${index}]`, operation),
    );
    const indexes = (input.confirmedParts as ConfirmedMessagePart[]).map((part) => part.logicalPartIndex);
    if (new Set(indexes).size !== indexes.length) {
      throw new TypeError("operationOutcome.confirmedParts must use unique logical part indexes");
    }
    const providerParts = (input.confirmedParts as ConfirmedMessagePart[]).map(({ part }) =>
      JSON.stringify([
        part.provider,
        part.installationId,
        part.lineId,
        part.conversationId,
        part.messageId,
        part.partIndex,
      ]),
    );
    if (new Set(providerParts).size !== providerParts.length) {
      throw new TypeError("operationOutcome.confirmedParts must use unique provider part identities");
    }
  }
  return value as unknown as PhotonOperationOutcome;
}

function sameOperationReference(left: PhotonOperationReference, right: PhotonOperationReference): boolean {
  return (
    left.operationId === right.operationId &&
    left.name === right.name &&
    left.idempotencyKey === right.idempotencyKey &&
    sameConversation(left.conversation, right.conversation)
  );
}

export function parsePhotonReconciliationEvidence(value: unknown): PhotonReconciliationEvidence {
  assertJsonSafe(value, "reconciliationEvidence");
  const input = record(value, "reconciliationEvidence");
  exactKeys(input, ["operation", "observedAt", "source", "outcome"], "reconciliationEvidence");
  operationReference(input.operation, "reconciliationEvidence.operation");
  isoTimestamp(input, "observedAt", "reconciliationEvidence");
  stringField(input, "source", "reconciliationEvidence");
  const outcome = parsePhotonOperationOutcome(input.outcome);
  if (outcome.kind === "unsupported" || outcome.kind === "ambiguous") {
    throw new TypeError("reconciliationEvidence.outcome must resolve ambiguity");
  }
  if (!sameOperationReference(input.operation as PhotonOperationReference, outcome.operation)) {
    throw new TypeError("reconciliationEvidence outcome contradicts its operation");
  }
  return value as unknown as PhotonReconciliationEvidence;
}

export function parseActionBinding(value: unknown): ActionBinding {
  assertJsonSafe(value, "actionBinding");
  const input = record(value, "actionBinding");
  exactKeys(
    input,
    ["bindingId", "actor", "resource", "resourceRevision", "allowedAction", "expiresAt", "session", "conversation"],
    "actionBinding",
  );
  stringField(input, "bindingId", "actionBinding");
  actorReference(input.actor, "actionBinding.actor");
  const resource = record(input.resource, "actionBinding.resource");
  exactKeys(resource, ["resourceType", "resourceId"], "actionBinding.resource");
  stringField(resource, "resourceType", "actionBinding.resource");
  stringField(resource, "resourceId", "actionBinding.resource");
  stringField(input, "resourceRevision", "actionBinding");
  member(input.allowedAction, QM_CHANNEL_OPERATIONS, "actionBinding.allowedAction");
  isoTimestamp(input, "expiresAt", "actionBinding");
  const session = record(input.session, "actionBinding.session");
  exactKeys(session, ["sessionId"], "actionBinding.session");
  stringField(session, "sessionId", "actionBinding.session");
  conversationReference(input.conversation, "actionBinding.conversation");
  return value as unknown as ActionBinding;
}

function httpsVerificationUrl(value: Record<string, unknown>, label: string, managementOrigin: string): string {
  const url = stringField(value, "verificationUrl", label);
  const parsed = new URL(url);
  const trusted = new URL(managementOrigin);
  if (parsed.protocol !== "https:" || trusted.protocol !== "https:" || parsed.origin !== trusted.origin) {
    throw new TypeError(`${label}.verificationUrl must use the trusted management origin`);
  }
  return url;
}

export function parseInstallationDisplayStatus(
  value: unknown,
  trustedManagementOrigin?: string,
): InstallationDisplayStatus {
  assertJsonSafe(value, "installationStatus");
  const input = record(value, "installationStatus");
  member(input.state, PHOTON_INSTALLATION_STATES, "installationStatus.state");
  stringField(input, "installationId", "installationStatus");
  if (input.state === "not-started") exactKeys(input, ["state", "installationId"], "installationStatus");
  else if (input.state === "awaiting-authorization") {
    exactKeys(input, ["state", "installationId", "userCode", "verificationUrl", "expiresAt"], "installationStatus");
    stringField(input, "userCode", "installationStatus");
    if (trustedManagementOrigin === undefined) {
      throw new TypeError("installationStatus requires a trusted management origin during authorization");
    }
    httpsVerificationUrl(input, "installationStatus", trustedManagementOrigin);
    isoTimestamp(input, "expiresAt", "installationStatus");
  } else if (["provisioning", "needs-owner-rebind", "needs-credential-repair"].includes(input.state as string)) {
    exactKeys(input, ["state", "installationId"], "installationStatus");
  } else if (input.state === "connected") {
    exactKeys(input, ["state", "installationId", "projectId", "lines"], "installationStatus");
    stringField(input, "projectId", "installationStatus");
    if (!Array.isArray(input.lines) || input.lines.length === 0)
      throw new TypeError("installationStatus.lines must be a non-empty array");
    input.lines.forEach((line, index) => {
      const current = record(line, `installationStatus.lines[${index}]`);
      exactKeys(current, ["lineId", "maskedAddress"], `installationStatus.lines[${index}]`);
      stringField(current, "lineId", `installationStatus.lines[${index}]`);
      optionalString(current, "maskedAddress", `installationStatus.lines[${index}]`);
    });
  } else {
    exactKeys(input, ["state", "installationId", "safeCode"], "installationStatus");
    stringField(input, "safeCode", "installationStatus");
  }
  return value as InstallationDisplayStatus;
}

export function projectInstallationForDashboard(value: PrivateInstallationStatus): InstallationDisplayStatus {
  const input = record(value, "privateInstallationStatus");
  const installationId = stringField(input, "installationId", "privateInstallationStatus");
  if (input.state === "not-started") return { state: "not-started", installationId };
  if (input.state === "awaiting-authorization") {
    const managementOrigin = stringField(input, "managementOrigin", "privateInstallationStatus");
    const status = {
      state: "awaiting-authorization" as const,
      installationId,
      userCode: stringField(input, "userCode", "privateInstallationStatus"),
      verificationUrl: httpsVerificationUrl(input, "privateInstallationStatus", managementOrigin),
      expiresAt: stringField(input, "expiresAt", "privateInstallationStatus"),
    };
    return parseInstallationDisplayStatus(status, managementOrigin);
  }
  if (
    input.state === "provisioning" ||
    input.state === "needs-owner-rebind" ||
    input.state === "needs-credential-repair"
  ) {
    return { state: input.state, installationId };
  }
  if (input.state === "connected") {
    const lines = Array.isArray(input.lines)
      ? input.lines.map((line, index) => {
          const current = record(line, `privateInstallationStatus.lines[${index}]`);
          const lineId = stringField(current, "lineId", `privateInstallationStatus.lines[${index}]`);
          const maskedAddress = current.maskedAddress;
          return typeof maskedAddress === "string" ? { lineId, maskedAddress } : { lineId };
        })
      : [];
    return parseInstallationDisplayStatus({
      state: "connected",
      installationId,
      projectId: stringField(input, "projectId", "privateInstallationStatus"),
      lines,
    });
  }
  return parseInstallationDisplayStatus({
    state: "failed",
    installationId,
    safeCode: stringField(input, "safeCode", "privateInstallationStatus"),
  });
}

export function parseInstallationReference(value: unknown): InstallationReference {
  assertJsonSafe(value, "installationReference");
  installationReference(value, "installationReference");
  return value;
}
