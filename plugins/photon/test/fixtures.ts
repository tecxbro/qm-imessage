import type {
  ActionBinding,
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
import type {
  ActionBindingStorePort,
  CanonicalIdentityLookupPort,
  DeliveryOperationRecord,
  DeliveryOperationStorePort,
  EventReceipt,
  EventReceiptStorePort,
  InstallationRecord,
  InstallationStorePort,
  MessageBinding,
  MessageBindingStorePort,
  SpectrumProviderClientPort,
} from "../src/ports.ts";

export const users = [
  { actorId: "provider-user-a", kind: "human", canonicalIdentityId: "qm-user-a", providerAddress: "+15550000001" },
  { actorId: "provider-user-b", kind: "human", canonicalIdentityId: "qm-user-b", providerAddress: "+15550000002" },
] as const satisfies readonly ProviderActorReference[];

export const installations = [
  { installationId: "installation-a", projectId: "project-a" },
  { installationId: "installation-b", projectId: "project-b" },
] as const satisfies readonly InstallationReference[];

export const lines = [
  { installation: installations[0], lineId: "line-a", maskedAddress: "+1•••0001" },
  { installation: installations[1], lineId: "line-b", maskedAddress: "+1•••0002" },
] as const satisfies readonly LineReference[];

export const chats = [
  { provider: "spectrum-imessage", conversationId: "chat-a", line: lines[0] },
  { provider: "spectrum-imessage", conversationId: "chat-b", line: lines[1] },
] as const satisfies readonly ConversationReference[];

export const providerEvents = [
  {
    eventId: "event-a",
    provider: "spectrum-imessage",
    installation: installations[0],
    sequence: "101",
    occurredAt: "2026-09-10T12:00:00.000Z",
    direction: "inbound",
    actor: users[0],
    family: "message",
  },
  {
    eventId: "event-b",
    provider: "spectrum-imessage",
    installation: installations[1],
    sequence: "202",
    occurredAt: "2026-09-10T12:00:01.000Z",
    direction: "inbound",
    actor: users[1],
    family: "message",
  },
] as const satisfies readonly ProviderEventIdentity[];

export const duplicateEvents = [providerEvents[0], providerEvents[0]] as const;

export const normalizedInputs = [
  {
    event: providerEvents[0],
    conversation: chats[0],
    text: "first part",
    attachments: [
      {
        attachmentId: "attachment-a",
        providerReference: "provider-attachment-a",
        fileName: "one.png",
        mediaType: "image/png",
        byteLength: 128,
      },
      {
        attachmentId: "attachment-b",
        providerReference: "provider-attachment-b",
        fileName: "two.txt",
        mediaType: "text/plain",
        byteLength: 32,
      },
    ],
    replyTo: { conversationId: "chat-a", messagePart: { messageId: "message-parent", partIndex: 1 } },
  },
  {
    event: providerEvents[1],
    conversation: chats[1],
    text: "second chat",
    attachments: [],
  },
] as const satisfies readonly NormalizedPhotonInput[];

export const multipartMessages = [
  {
    conversation: chats[0],
    messageId: "message-a",
    parts: [
      { messageId: "message-a", partIndex: 0 },
      { messageId: "message-a", partIndex: 1 },
    ],
  },
  {
    conversation: chats[1],
    messageId: "message-b",
    parts: [
      { messageId: "message-b", partIndex: 0 },
      { messageId: "message-b", partIndex: 1 },
    ],
  },
] as const satisfies readonly MessageReference[];

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
    bindingId: "binding-b",
    actor: users[1],
    resource: { resourceType: "approval", resourceId: "approval-a" },
    resourceRevision: "revision-1",
    allowedAction: "approval.resolve",
    expiresAt: "2026-09-10T13:00:00.000Z",
    session: { sessionId: "session-a" },
    conversation: chats[1],
  },
] as const satisfies readonly ActionBinding[];

export class FakeInstallationStore implements InstallationStorePort {
  readonly records = new Map<string, InstallationRecord>();

  async read(installationId: string): Promise<InstallationRecord | undefined> {
    return this.records.get(installationId);
  }

  async create(record: InstallationRecord): Promise<boolean> {
    if (this.records.has(record.installation.installationId)) return false;
    this.records.set(record.installation.installationId, record);
    return true;
  }

  async compareAndSet(installationId: string, expectedVersion: number, next: InstallationRecord): Promise<boolean> {
    if (this.records.get(installationId)?.version !== expectedVersion) return false;
    this.records.set(installationId, next);
    return true;
  }
}

export class FakeCanonicalIdentityLookup implements CanonicalIdentityLookupPort {
  async resolveActor(event: ProviderEventIdentity): Promise<ProviderActorReference | undefined> {
    return users.find((user) => user.actorId === event.actor.actorId);
  }
}

export class FakeEventReceiptStore implements EventReceiptStorePort {
  readonly receipts = new Map<string, EventReceipt>();

  async capture(receipt: EventReceipt): Promise<"captured" | "duplicate"> {
    if (this.receipts.has(receipt.event.eventId)) return "duplicate";
    this.receipts.set(receipt.event.eventId, receipt);
    return "captured";
  }

  async claim(eventId: string): Promise<EventReceipt | undefined> {
    const receipt = this.receipts.get(eventId);
    if (receipt === undefined || receipt.state !== "captured") return undefined;
    const claimed = { ...receipt, state: "processing" as const };
    this.receipts.set(eventId, claimed);
    return claimed;
  }

  async checkpoint(eventId: string, checkpoint: string): Promise<boolean> {
    const receipt = this.receipts.get(eventId);
    if (receipt === undefined || receipt.state !== "processing") return false;
    this.receipts.set(eventId, { ...receipt, state: "checkpointed", checkpoint });
    return true;
  }

  async fail(eventId: string, safeCode: string): Promise<boolean> {
    const receipt = this.receipts.get(eventId);
    if (receipt === undefined) return false;
    this.receipts.set(eventId, { ...receipt, state: "failed", checkpoint: safeCode });
    return true;
  }

  async read(eventId: string): Promise<EventReceipt | undefined> {
    return this.receipts.get(eventId);
  }
}

export class FakeMessageBindingStore implements MessageBindingStorePort {
  readonly bindings: MessageBinding[] = [];

  async bind(binding: MessageBinding): Promise<"bound" | "duplicate" | "conflict"> {
    const existing = await this.findByProviderMessage(
      binding.providerMessage.conversation.conversationId,
      binding.providerMessage.messageId,
      binding.providerMessage.parts[0]?.partIndex ?? 0,
    );
    if (existing === undefined) {
      this.bindings.push(binding);
      return "bound";
    }
    return existing.qmSessionId === binding.qmSessionId && existing.qmEntrySequence === binding.qmEntrySequence
      ? "duplicate"
      : "conflict";
  }

  async findByProviderMessage(
    conversationId: string,
    messageId: string,
    partIndex: number,
  ): Promise<MessageBinding | undefined> {
    return this.bindings.find(
      (binding) =>
        binding.providerMessage.conversation.conversationId === conversationId &&
        binding.providerMessage.messageId === messageId &&
        binding.providerMessage.parts.some((part) => part.partIndex === partIndex),
    );
  }

  async findByQmEntry(qmSessionId: string, qmEntrySequence: number): Promise<readonly MessageBinding[]> {
    return this.bindings.filter(
      (binding) => binding.qmSessionId === qmSessionId && binding.qmEntrySequence === qmEntrySequence,
    );
  }
}

export class FakeDeliveryOperationStore implements DeliveryOperationStorePort {
  readonly operations = new Map<string, DeliveryOperationRecord>();

  async reserve(operation: PhotonPresentationOperation): Promise<"reserved" | "duplicate"> {
    if (this.operations.has(operation.operationId)) return "duplicate";
    this.operations.set(operation.operationId, { operation, state: "reserved", version: 1 });
    return "reserved";
  }

  async markDispatched(operationId: string): Promise<boolean> {
    const current = this.operations.get(operationId);
    if (current === undefined || current.state !== "reserved") return false;
    this.operations.set(operationId, { ...current, state: "dispatched", version: current.version + 1 });
    return true;
  }

  async complete(operationId: string, outcome: PhotonOperationOutcome): Promise<boolean> {
    const current = this.operations.get(operationId);
    if (current === undefined || current.state !== "dispatched") return false;
    let state: DeliveryOperationRecord["state"] = "confirmed";
    if (outcome.kind === "ambiguous") state = "ambiguous";
    if (outcome.kind === "failed") state = "failed";
    this.operations.set(operationId, { ...current, state, outcome, version: current.version + 1 });
    return true;
  }

  async read(operationId: string): Promise<DeliveryOperationRecord | undefined> {
    return this.operations.get(operationId);
  }
}

export class FakeActionBindingStore implements ActionBindingStorePort {
  readonly bindings = new Map<string, ActionBinding>();
  readonly resourceOwners = new Map<string, string>();

  async create(binding: ActionBinding): Promise<"created" | "duplicate" | "conflict"> {
    const current = this.bindings.get(binding.bindingId);
    if (current !== undefined) return JSON.stringify(current) === JSON.stringify(binding) ? "duplicate" : "conflict";
    const key = `${binding.resource.resourceType}:${binding.resource.resourceId}:${binding.resourceRevision}:${binding.allowedAction}`;
    if (this.resourceOwners.has(key)) return "conflict";
    this.bindings.set(binding.bindingId, binding);
    this.resourceOwners.set(key, binding.bindingId);
    return "created";
  }

  async consume(
    bindingId: string,
    actorId: string,
    resourceRevision: string,
    now: string,
  ): Promise<ActionBinding | undefined> {
    const binding = this.bindings.get(bindingId);
    if (
      binding === undefined ||
      binding.actor.actorId !== actorId ||
      binding.resourceRevision !== resourceRevision ||
      Date.parse(binding.expiresAt) <= Date.parse(now)
    )
      return undefined;
    this.bindings.delete(bindingId);
    return binding;
  }

  async read(bindingId: string): Promise<ActionBinding | undefined> {
    return this.bindings.get(bindingId);
  }
}

export function fakeSpectrumProvider(outcome: PhotonOperationOutcome): SpectrumProviderClientPort {
  return {
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async resolveConversation(line: LineReference, participantIds: readonly string[]): Promise<ConversationReference> {
      return { provider: "spectrum-imessage", conversationId: participantIds.join(","), line };
    },
    async deliver(): Promise<PhotonOperationOutcome> {
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
    projectId: installations[index].projectId,
    lines: [{ lineId: lines[index].lineId, maskedAddress: lines[index].maskedAddress }],
  };
}
