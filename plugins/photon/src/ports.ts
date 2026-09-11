import type {
  ActionBinding,
  AttachmentReference,
  CheckedQmChannelOperation,
  ConversationReference,
  InstallationDisplayStatus,
  InstallationReference,
  LineReference,
  MessageReference,
  NormalizedPhotonInput,
  PhotonOperationOutcome,
  PhotonPresentationOperation,
  ProviderActorReference,
  ProviderEventIdentity,
} from "../../chassis/src/photon-contract.ts";

export interface InstallationRecord {
  installation: InstallationReference;
  status: InstallationDisplayStatus;
  ownerRevision: string;
  credentialCiphertext: string;
  version: number;
}

export interface InstallationStorePort {
  read(installationId: string): Promise<InstallationRecord | undefined>;
  create(record: InstallationRecord): Promise<boolean>;
  compareAndSet(installationId: string, expectedVersion: number, next: InstallationRecord): Promise<boolean>;
}

export interface CanonicalIdentityLookupPort {
  resolveActor(event: ProviderEventIdentity): Promise<ProviderActorReference | undefined>;
}

export interface EventReceipt {
  event: ProviderEventIdentity;
  capturedAt: string;
  payloadSha256: string;
  state: "captured" | "processing" | "checkpointed" | "failed";
  checkpoint?: string;
}

export interface EventReceiptStorePort {
  capture(receipt: EventReceipt): Promise<"captured" | "duplicate">;
  claim(eventId: string): Promise<EventReceipt | undefined>;
  checkpoint(eventId: string, checkpoint: string): Promise<boolean>;
  fail(eventId: string, safeCode: string): Promise<boolean>;
  read(eventId: string): Promise<EventReceipt | undefined>;
}

export interface MessageBinding {
  providerMessage: MessageReference;
  qmSessionId: string;
  qmEntrySequence: number;
  resourceRevision: string;
}

export interface MessageBindingStorePort {
  bind(binding: MessageBinding): Promise<"bound" | "duplicate" | "conflict">;
  findByProviderMessage(
    conversationId: string,
    messageId: string,
    partIndex: number,
  ): Promise<MessageBinding | undefined>;
  findByQmEntry(qmSessionId: string, qmEntrySequence: number): Promise<readonly MessageBinding[]>;
}

export interface DeliveryOperationRecord {
  operation: PhotonPresentationOperation;
  state: "reserved" | "dispatched" | "confirmed" | "ambiguous" | "failed";
  outcome?: PhotonOperationOutcome;
  version: number;
}

export interface DeliveryOperationStorePort {
  reserve(operation: PhotonPresentationOperation): Promise<"reserved" | "duplicate">;
  markDispatched(operationId: string): Promise<boolean>;
  complete(operationId: string, outcome: PhotonOperationOutcome): Promise<boolean>;
  read(operationId: string): Promise<DeliveryOperationRecord | undefined>;
}

export interface ActionBindingStorePort {
  create(binding: ActionBinding): Promise<"created" | "duplicate" | "conflict">;
  consume(
    bindingId: string,
    actorId: string,
    resourceRevision: string,
    now: string,
  ): Promise<ActionBinding | undefined>;
  read(bindingId: string): Promise<ActionBinding | undefined>;
}

export interface QmChannelAuthorityPort {
  check(operation: CheckedQmChannelOperation): Promise<CheckedQmChannelOperation>;
  execute(operation: CheckedQmChannelOperation): Promise<Readonly<Record<string, unknown>>>;
}

export interface SpectrumProviderClientPort {
  start(onInput: (input: NormalizedPhotonInput) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  resolveConversation(line: LineReference, participantIds: readonly string[]): Promise<ConversationReference>;
  deliver(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  fetchAttachment(reference: AttachmentReference): Promise<Uint8Array>;
}

export interface AdvancedIMessageProviderClientPort {
  sendText(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  sendMultipart(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  sendAttachment(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  sendVoice(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  shareContact(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  createPoll(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  sendAppCard(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  updateAppCard(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  react(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  edit(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  unsend(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  setTyping(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  markRead(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  renameConversation(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  setConversationAvatar(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
  changeMembership(operation: PhotonPresentationOperation): Promise<PhotonOperationOutcome>;
}
