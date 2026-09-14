import type {
  ActionBinding,
  AttachmentReference,
  CheckedQmChannelOperation,
  ConfirmedMessagePart,
  ConversationReference,
  InstallationReference,
  JsonObject,
  LineReference,
  MessagePartReference,
  MessageReference,
  NormalizedPhotonInput,
  PhotonAppCardHandle,
  PhotonOperationOutcome,
  PhotonPollState,
  PhotonPresentationOperation,
  PhotonProviderReceipt,
  PhotonReconciliationEvidence,
  PrivateInstallationStatus,
  ProviderActorReference,
  ProviderEventIdentity,
  ProviderScope,
  QmChannelOperationRequest,
} from "../../chassis/src/photon-contract.ts";

export interface InstallationRecord {
  installation: InstallationReference;
  status: PrivateInstallationStatus;
  ownerRevision: string;
  version: number;
}

export interface InstallationStorePort {
  read(installationId: string): Promise<InstallationRecord | undefined>;
  create(record: InstallationRecord): Promise<boolean>;
  compareAndSet(installationId: string, expectedVersion: number, next: InstallationRecord): Promise<boolean>;
}

export interface PhotonInstallationCiphertextRecord {
  installationId: string;
  ownerRevision: string;
  version: number;
  wrappingKeyId: string;
  ciphertext: string;
}

export interface PhotonInstallationCiphertextStore {
  read(installationId: string): Promise<PhotonInstallationCiphertextRecord | undefined>;
  create(record: PhotonInstallationCiphertextRecord): Promise<boolean>;
  compareAndSet(
    installationId: string,
    expectedVersion: number,
    next: PhotonInstallationCiphertextRecord,
  ): Promise<boolean>;
}

export interface PhotonInstallationStoreAdapter {
  read(installationId: string): Promise<InstallationRecord | undefined>;
  create(record: InstallationRecord): Promise<boolean>;
  compareAndSet(installationId: string, expectedVersion: number, next: InstallationRecord): Promise<boolean>;
}

export interface VerifiedAddressChallenge {
  challengeId: string;
  installationId: string;
  addressCiphertext: string;
  expiresAt: string;
  verifiedAt?: string;
  version: number;
}

export interface VerifiedAddressStorePort {
  create(challenge: VerifiedAddressChallenge): Promise<"created" | "duplicate" | "conflict">;
  verify(challengeId: string, expectedVersion: number, verifiedAt: string): Promise<boolean>;
  read(challengeId: string): Promise<VerifiedAddressChallenge | undefined>;
}

export interface CanonicalIdentityLookupPort {
  resolveActor(
    event: ProviderEventIdentity,
    actor: ProviderActorReference,
  ): Promise<ProviderActorReference | undefined>;
}

export interface ProviderEventKey extends ProviderScope {
  eventId: string;
  lineId?: string;
}

export interface ProviderLineScope extends ProviderScope {
  lineId: string;
}

export interface ReceiptClaim {
  claimId: string;
  fence: number;
  leaseExpiresAt: string;
}

export type CapturedEventPayload =
  | { kind: "envelope"; envelope: NormalizedPhotonInput }
  | { kind: "reference"; reference: string; payloadSha256: string };

export interface EventReceipt {
  key: ProviderEventKey;
  sequence?: string;
  capturedAt: string;
  payload: CapturedEventPayload;
  state: "captured" | "processing" | "checkpointed" | "rejected";
  claim?: ReceiptClaim;
  checkpoint?: string;
  rejectionCode?: string;
}

export interface CapturedEventReceipt {
  key: ProviderEventKey;
  sequence?: string;
  capturedAt: string;
  payload: CapturedEventPayload;
  state: "captured";
}

export interface ContiguousCheckpoint {
  scope: ProviderLineScope;
  sequence: string;
  version: number;
}

export interface EventReceiptStorePort {
  capture(receipt: CapturedEventReceipt): Promise<"captured" | "duplicate" | "conflict">;
  claim(
    key: ProviderEventKey,
    claimantId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<EventReceipt | undefined>;
  completeWithoutSequence(key: ProviderEventKey, claim: ReceiptClaim, now: string): Promise<boolean>;
  rejectWithoutSequence(key: ProviderEventKey, claim: ReceiptClaim, now: string, safeCode: string): Promise<boolean>;
  rejectAndAdvanceContiguousCheckpoint(
    key: ProviderEventKey & ProviderLineScope,
    expectedVersion: number,
    nextSequence: string,
    claim: ReceiptClaim,
    now: string,
    safeCode: string,
  ): Promise<boolean>;
  read(key: ProviderEventKey): Promise<EventReceipt | undefined>;
  readContiguousCheckpoint(scope: ProviderLineScope): Promise<ContiguousCheckpoint | undefined>;
  advanceContiguousCheckpoint(
    key: ProviderEventKey & ProviderLineScope,
    expectedVersion: number,
    nextSequence: string,
    claim: ReceiptClaim,
    now: string,
  ): Promise<boolean>;
}

export interface ReceiptRecoveryCursor {
  capturedAt: string;
  eventId: string;
}

export interface ReceiptRecoveryQuery {
  provider: ProviderEventKey["provider"];
  installationId: string;
  lineId?: string;
  now: string;
  limit: number;
  after?: ReceiptRecoveryCursor;
}

export interface ReceiptRecoveryPage {
  receipts: readonly EventReceipt[];
  next?: ReceiptRecoveryCursor;
}

export interface RecoverableEventReceiptStorePort extends EventReceiptStorePort {
  discoverRecoverable(query: ReceiptRecoveryQuery): Promise<ReceiptRecoveryPage>;
}

export interface ChatSessionBinding {
  conversation: ConversationReference;
  qmSessionId: string;
  resourceRevision: string;
}

export interface ChatSessionBindingStorePort {
  bind(binding: ChatSessionBinding): Promise<"bound" | "duplicate" | "conflict">;
  find(conversation: ConversationReference): Promise<ChatSessionBinding | undefined>;
}

export interface ChatSessionSelection {
  binding: ChatSessionBinding;
  version: number;
}

export interface ChatSessionSelectionStorePort extends ChatSessionBindingStorePort {
  readSelection(conversation: ConversationReference): Promise<ChatSessionSelection | undefined>;
  compareAndSetSelection(
    conversation: ConversationReference,
    expectedVersion: number,
    next: ChatSessionBinding,
  ): Promise<ChatSessionSelection | undefined>;
}

export interface MessageBinding {
  providerMessage: MessageReference;
  qmSessionId: string;
  qmEntrySequence: number;
  resourceRevision: string;
}

export interface MessageBindingStorePort {
  bind(binding: MessageBinding): Promise<"bound" | "duplicate" | "conflict">;
  findByProviderPart(part: MessagePartReference): Promise<MessageBinding | undefined>;
  findByQmEntry(qmSessionId: string, qmEntrySequence: number): Promise<readonly MessageBinding[]>;
}

export interface AttachmentRecord {
  reference: AttachmentReference;
  storageReference: string;
  state: "available" | "released";
}

export interface AttachmentStorePort {
  put(record: AttachmentRecord): Promise<"stored" | "duplicate" | "conflict">;
  read(reference: AttachmentReference): Promise<AttachmentRecord | undefined>;
  release(reference: AttachmentReference): Promise<boolean>;
}

export interface DeliveryOperationRecord {
  operation: PhotonPresentationOperation;
  attempts: readonly { operationId: string; attemptId: string }[];
  parts: readonly DeliveryPartRecord[];
  state: "reserved" | "dispatched" | "confirmed" | "unsupported" | "ambiguous" | "failed";
  dispatchFence: number;
  outcome?: PhotonOperationOutcome;
  version: number;
}

export interface DeliveryPartRecord {
  partId: string;
  partIndex: number;
  state: "reserved" | "dispatched" | "confirmed" | "unsupported" | "ambiguous" | "failed";
  dispatchFence: number;
  providerPart?: MessagePartReference;
}

export interface DeliveryOperationStorePort {
  reserve(operation: PhotonPresentationOperation): Promise<"reserved" | "duplicate" | "conflict">;
  markDispatched(
    operation: PhotonPresentationOperation,
    expectedVersion: number,
  ): Promise<DeliveryOperationRecord | undefined>;
  retry(operation: PhotonPresentationOperation, expectedVersion: number): Promise<DeliveryOperationRecord | undefined>;
  complete(
    operation: PhotonPresentationOperation,
    dispatchFence: number,
    outcome: PhotonOperationOutcome,
  ): Promise<boolean>;
  reconcile(evidence: PhotonReconciliationEvidence, expectedVersion: number): Promise<boolean>;
  read(operation: PhotonPresentationOperation): Promise<DeliveryOperationRecord | undefined>;
}

export interface DeliveryDispatchClaim {
  ownerId: string;
  fence: number;
  leaseExpiresAt: string;
}

export interface RecoverableDeliveryOperationRecord extends DeliveryOperationRecord {
  dispatchClaim?: DeliveryDispatchClaim;
}

export interface DeliveryRecoveryCursor {
  updatedAt: string;
  conversationId: string;
  idempotencyKey: string;
}

export interface DeliveryRecoveryQuery {
  provider: ProviderLineScope["provider"];
  installationId: string;
  lineId: string;
  now: string;
  limit: number;
  after?: DeliveryRecoveryCursor;
}

export interface DeliveryRecoveryPage {
  deliveries: readonly RecoverableDeliveryOperationRecord[];
  next?: DeliveryRecoveryCursor;
}

export interface RecoverableDeliveryOperationStorePort extends Omit<
  DeliveryOperationStorePort,
  "complete" | "markDispatched" | "read"
> {
  acquireDispatch(
    operation: PhotonPresentationOperation,
    expectedVersion: number,
    ownerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<RecoverableDeliveryOperationRecord | undefined>;
  renewDispatch(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    now: string,
    leaseExpiresAt: string,
  ): Promise<RecoverableDeliveryOperationRecord | undefined>;
  expireDispatch(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    now: string,
  ): Promise<RecoverableDeliveryOperationRecord | undefined>;
  recordConfirmedPart(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    logicalPartIndex: number,
    part: MessagePartReference,
    now: string,
  ): Promise<RecoverableDeliveryOperationRecord | undefined>;
  complete(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    outcome: PhotonOperationOutcome,
    now: string,
  ): Promise<boolean>;
  discoverRecoverable(query: DeliveryRecoveryQuery): Promise<DeliveryRecoveryPage>;
  read(operation: PhotonPresentationOperation): Promise<RecoverableDeliveryOperationRecord | undefined>;
}

export interface TextStreamSessionRecord {
  operation: Extract<PhotonPresentationOperation, { name: "message.text.stream" }>;
  chunks: readonly string[];
  state: "open" | "finalized";
  version: number;
}

export interface TextStreamSessionStorePort {
  create(
    operation: Extract<PhotonPresentationOperation, { name: "message.text.stream" }>,
  ): Promise<"created" | "duplicate" | "conflict">;
  append(
    operation: Extract<PhotonPresentationOperation, { name: "message.text.stream" }>,
    expectedVersion: number,
    chunk: string,
  ): Promise<TextStreamSessionRecord | undefined>;
  finalize(
    operation: Extract<PhotonPresentationOperation, { name: "message.text.stream" }>,
    expectedVersion: number,
  ): Promise<TextStreamSessionRecord | undefined>;
  read(
    operation: Extract<PhotonPresentationOperation, { name: "message.text.stream" }>,
  ): Promise<TextStreamSessionRecord | undefined>;
}

export interface PollReference {
  conversation: ConversationReference;
  pollMessageGuid: string;
  optionIdentifiers: readonly string[];
  version: number;
}

export interface PollReferenceStorePort {
  put(reference: PollReference): Promise<"stored" | "duplicate" | "conflict">;
  replace(reference: PollReference, expectedVersion: number): Promise<boolean>;
  read(conversation: ConversationReference, pollMessageGuid: string): Promise<PollReference | undefined>;
}

export interface PublicCardHandle {
  conversation: ConversationReference;
  cardId: string;
  handle: PhotonAppCardHandle;
  version: number;
}

export interface PublicCardHandleStorePort {
  put(handle: PublicCardHandle): Promise<"stored" | "duplicate" | "conflict">;
  replace(handle: PublicCardHandle, expectedVersion: number): Promise<boolean>;
  read(conversation: ConversationReference, cardId: string): Promise<PublicCardHandle | undefined>;
}

export interface ActionBindingConsumption {
  bindingId: string;
  actor: ProviderActorReference;
  resourceType: string;
  resourceId: string;
  resourceRevision: string;
  allowedAction: ActionBinding["allowedAction"];
  sessionId: string;
  conversation: ConversationReference;
  now: string;
}

export interface ActionBindingStorePort {
  create(binding: ActionBinding): Promise<"created" | "duplicate" | "conflict">;
  consume(request: ActionBindingConsumption): Promise<ActionBinding | undefined>;
  read(conversation: ConversationReference, bindingId: string): Promise<ActionBinding | undefined>;
}

export interface QmChannelAuthorityPort {
  check(operation: QmChannelOperationRequest): Promise<CheckedQmChannelOperation>;
  execute(operation: CheckedQmChannelOperation): Promise<JsonObject>;
}

export interface PhotonDeliveryDispatch<Operation extends PhotonPresentationOperation = PhotonPresentationOperation> {
  operation: Operation;
  logicalPartIndexes: readonly number[];
  confirmedParts: readonly ConfirmedMessagePart[];
}

export interface PhotonDeliveryProgressPort {
  assertCanContinue(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    logicalPartIndex: number,
    now: string,
  ): Promise<void>;
  recordConfirmedPart(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    logicalPartIndex: number,
    part: MessagePartReference,
    now: string,
  ): Promise<void>;
}

export type PhotonProviderMode = "spectrum" | "advanced";

export type PhotonLineCredentialResolution =
  | {
      kind: "available";
      installationId: string;
      lineId: string;
      mode: PhotonProviderMode;
      bearerToken: string;
      expiresAt?: string;
      provenance: "persisted-line-assignment" | "explicit-runtime-input";
      renewal: "automatic" | "external";
    }
  | { kind: "unavailable"; code: string }
  | { kind: "expired"; code: string };

export interface PhotonLineCredentialResolver {
  resolve(input: {
    installationId: string;
    lineId: string;
    mode: PhotonProviderMode;
    now: string;
  }): Promise<PhotonLineCredentialResolution>;
}

export interface PhotonLineOwnerKey {
  installationId: string;
  lineId: string;
}

export interface PhotonLineOwnerClaim {
  key: PhotonLineOwnerKey;
  ownerId: string;
  fence: number;
  leaseExpiresAt: string;
}

export interface PhotonLineOwnerStore {
  claim(
    key: PhotonLineOwnerKey,
    ownerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<PhotonLineOwnerClaim | undefined>;
  renew(claim: PhotonLineOwnerClaim, now: string, leaseExpiresAt: string): Promise<PhotonLineOwnerClaim | undefined>;
  release(claim: PhotonLineOwnerClaim, now: string): Promise<boolean>;
}

export interface SpectrumProviderClientPort {
  start(onInput: (input: NormalizedPhotonInput) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  resolveConversation(line: LineReference, participantIds: readonly string[]): Promise<ConversationReference>;
  deliver(
    dispatch: PhotonDeliveryDispatch<Exclude<PhotonPresentationOperation, { name: "message.text.stream" }>>,
  ): Promise<PhotonOperationOutcome>;
  streamText(
    operation: Extract<PhotonPresentationOperation, { name: "message.text.stream" }>,
    chunks: AsyncIterable<string>,
  ): Promise<PhotonOperationOutcome>;
  fetchAttachment(reference: AttachmentReference): Promise<Uint8Array>;
}

type ConfirmedMessageWithReceipt<ReceiptType extends PhotonProviderReceipt["receiptType"]> = Omit<
  Extract<PhotonOperationOutcome, { kind: "confirmed-message" }>,
  "providerReceipt"
> & {
  providerReceipt: Extract<PhotonProviderReceipt, { receiptType: ReceiptType }>;
};

type NonMessageSuccessOutcome = Extract<PhotonOperationOutcome, { kind: "unsupported" | "failed" | "ambiguous" }>;

type UnsupportedProviderOutcome = Extract<PhotonOperationOutcome, { kind: "unsupported" }>;

type MessageProviderOutcome = Exclude<PhotonOperationOutcome, { kind: "confirmed-no-message" }>;

type ConfirmedNoMessageWithoutReceipt = Omit<
  Extract<PhotonOperationOutcome, { kind: "confirmed-no-message" }>,
  "providerReceipt"
> & {
  providerReceipt?: never;
};

type ConfirmedNoMessageWithReceipt<ReceiptType extends PhotonProviderReceipt["receiptType"]> = Omit<
  Extract<PhotonOperationOutcome, { kind: "confirmed-no-message" }>,
  "providerReceipt"
> & {
  providerReceipt: Extract<PhotonProviderReceipt, { receiptType: ReceiptType }>;
};

type ProviderOutcomeWithReceipt<ReceiptType extends PhotonProviderReceipt["receiptType"]> =
  NonMessageSuccessOutcome | ConfirmedMessageWithReceipt<ReceiptType>;

type NoMessageProviderOutcomeWithReceipt<ReceiptType extends PhotonProviderReceipt["receiptType"]> =
  NonMessageSuccessOutcome | ConfirmedNoMessageWithReceipt<ReceiptType>;

type VoidProviderOutcome = NonMessageSuccessOutcome | ConfirmedNoMessageWithoutReceipt;

type AdvancedTextEditOperation = Extract<PhotonPresentationOperation, { name: "message.edit" }> & {
  input: Extract<PhotonPresentationOperation, { name: "message.edit" }>["input"] & {
    content: { kind: "text"; text: string };
  };
};

export interface AdvancedIMessageProviderClientPort {
  sendText(operation: Extract<PhotonPresentationOperation, { name: "message.text" }>): Promise<MessageProviderOutcome>;
  sendMarkdown(
    operation: Extract<PhotonPresentationOperation, { name: "message.markdown" }>,
  ): Promise<MessageProviderOutcome>;
  sendLink(operation: Extract<PhotonPresentationOperation, { name: "message.link" }>): Promise<MessageProviderOutcome>;
  sendMultipart(
    dispatch: PhotonDeliveryDispatch<Extract<PhotonPresentationOperation, { name: "message.multipart" }>>,
  ): Promise<MessageProviderOutcome>;
  sendAttachment(
    operation: Extract<PhotonPresentationOperation, { name: "message.attachment" }>,
  ): Promise<MessageProviderOutcome>;
  sendVoice(
    operation: Extract<PhotonPresentationOperation, { name: "message.voice" }>,
  ): Promise<MessageProviderOutcome>;
  shareContact(
    operation: Extract<PhotonPresentationOperation, { name: "message.contact" }>,
  ): Promise<UnsupportedProviderOutcome>;
  getPoll(conversation: ConversationReference, pollMessageGuid: string): Promise<PhotonPollState>;
  createPoll(
    operation: Extract<PhotonPresentationOperation, { name: "message.poll.create" }>,
  ): Promise<ProviderOutcomeWithReceipt<"poll">>;
  votePoll(
    operation: Extract<PhotonPresentationOperation, { name: "message.poll.vote" }>,
  ): Promise<NoMessageProviderOutcomeWithReceipt<"poll">>;
  unvotePoll(
    operation: Extract<PhotonPresentationOperation, { name: "message.poll.unvote" }>,
  ): Promise<NoMessageProviderOutcomeWithReceipt<"poll">>;
  addPollOption(
    operation: Extract<PhotonPresentationOperation, { name: "message.poll.add-option" }>,
  ): Promise<NoMessageProviderOutcomeWithReceipt<"poll">>;
  sendAppCard(
    operation: Extract<PhotonPresentationOperation, { name: "message.app.send" }>,
  ): Promise<ProviderOutcomeWithReceipt<"app-card">>;
  updateAppCard(
    operation: Extract<PhotonPresentationOperation, { name: "message.app.update" }>,
  ): Promise<ProviderOutcomeWithReceipt<"app-card">>;
  react(operation: Extract<PhotonPresentationOperation, { name: "message.react" }>): Promise<MessageProviderOutcome>;
  edit(operation: AdvancedTextEditOperation): Promise<MessageProviderOutcome>;
  unsend(operation: Extract<PhotonPresentationOperation, { name: "message.unsend" }>): Promise<VoidProviderOutcome>;
  setTyping(
    operation: Extract<PhotonPresentationOperation, { name: "conversation.typing" }>,
  ): Promise<VoidProviderOutcome>;
  markRead(
    operation: Extract<PhotonPresentationOperation, { name: "conversation.read" }>,
  ): Promise<VoidProviderOutcome>;
  renameConversation(
    operation: Extract<PhotonPresentationOperation, { name: "conversation.rename" }>,
  ): Promise<NoMessageProviderOutcomeWithReceipt<"chat">>;
  setConversationAvatar(
    operation: Extract<PhotonPresentationOperation, { name: "conversation.avatar.set" }>,
  ): Promise<VoidProviderOutcome>;
  clearConversationAvatar(
    operation: Extract<PhotonPresentationOperation, { name: "conversation.avatar.clear" }>,
  ): Promise<VoidProviderOutcome>;
  changeMembership(
    operation: Extract<
      PhotonPresentationOperation,
      { name: "conversation.membership.add" | "conversation.membership.remove" }
    >,
  ): Promise<NoMessageProviderOutcomeWithReceipt<"chat">>;
  changeMembership(
    operation: Extract<PhotonPresentationOperation, { name: "conversation.membership.leave" }>,
  ): Promise<VoidProviderOutcome>;
}
