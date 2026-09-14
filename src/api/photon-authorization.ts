import { isDeepStrictEqual } from "node:util";

import type {
  ActionBinding,
  CheckedQmChannelOperation,
  ConversationReference,
  InstallationReference,
  MessagePartReference,
  MessageReference,
  NormalizedPhotonInput,
  PrivateInstallationStatus,
  ProviderActorReference,
  ProviderEventIdentity,
  QmChannelOperationRequest,
} from "../../plugins/chassis/src/photon-contract.ts";
import {
  parseCheckedQmChannelOperation,
  parseNormalizedPhotonInput,
  parseQmChannelOperationRequest,
} from "../../plugins/chassis/src/photon-contract.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { Session } from "../types.ts";

import type { App } from "./app.ts";

export interface PhotonOperationSource {
  event: ProviderEventIdentity;
  actor: ProviderActorReference & { kind: "human" };
  conversation: ConversationReference;
  input: NormalizedPhotonInput;
}

export interface PhotonInstallationAuthorizationRecord {
  installation: InstallationReference;
  status: PrivateInstallationStatus;
  ownerRevision: string;
  version: number;
}

export interface PhotonInstallationAuthorizationPort {
  read(installationId: string): Promise<PhotonInstallationAuthorizationRecord | undefined>;
}

export interface PhotonCanonicalIdentityAuthorizationPort {
  resolveActor(
    event: ProviderEventIdentity,
    actor: ProviderActorReference,
  ): Promise<ProviderActorReference | undefined>;
}

export interface PhotonConversationAuthorizationBinding {
  conversation: ConversationReference;
  qmSessionId: string;
  resourceRevision: string;
}

export interface PhotonConversationAuthorizationPort {
  find(conversation: ConversationReference): Promise<PhotonConversationAuthorizationBinding | undefined>;
}

export interface PhotonMessageAuthorizationPort {
  findByProviderPart(part: MessagePartReference): Promise<
    | {
        providerMessage: MessageReference;
        qmSessionId: string;
        qmEntrySequence: number;
        resourceRevision: string;
      }
    | undefined
  >;
}

export interface PhotonActionAuthorizationPort {
  read(conversation: ConversationReference, bindingId: string): Promise<ActionBinding | undefined>;
  consume(request: {
    bindingId: string;
    actor: ProviderActorReference;
    resourceType: string;
    resourceId: string;
    resourceRevision: string;
    allowedAction: ActionBinding["allowedAction"];
    sessionId: string;
    conversation: ConversationReference;
    now: string;
  }): Promise<ActionBinding | undefined>;
}

type PhotonAuthorizationApp = Pick<App, "authorizesCapabilityScope" | "getApproval" | "getRun" | "getSessionForViewer">;

export interface PhotonAuthorizationDeps {
  app: PhotonAuthorizationApp;
  installations: PhotonInstallationAuthorizationPort;
  identities: PhotonCanonicalIdentityAuthorizationPort;
  conversations: PhotonConversationAuthorizationPort;
  messages: PhotonMessageAuthorizationPort;
  actions: PhotonActionAuthorizationPort;
  runs: Pick<RunStore, "get">;
  now?: () => number;
}

export interface AuthorizedPhotonOperation {
  checked: CheckedQmChannelOperation;
  source: PhotonOperationSource;
  actor: ProviderActorReference & { kind: "human"; canonicalIdentityId: string };
  session: Session;
  binding: PhotonConversationAuthorizationBinding;
  approval?: NonNullable<Awaited<ReturnType<App["getApproval"]>>>;
  action?: ActionBinding;
}

export class PhotonAuthorizationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "PhotonAuthorizationError";
    this.code = code;
  }
}

function deny(code: string): never {
  throw new PhotonAuthorizationError(code);
}

function sameConversation(left: ConversationReference, right: ConversationReference): boolean {
  return (
    left.provider === right.provider &&
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.lineId === right.lineId &&
    left.conversationId === right.conversationId
  );
}

function sameActor(left: ProviderActorReference, right: ProviderActorReference): boolean {
  return (
    left.actorId === right.actorId &&
    left.kind === right.kind &&
    left.canonicalIdentityId === right.canonicalIdentityId &&
    left.providerAddress === right.providerAddress
  );
}

function sameProviderActor(left: ProviderActorReference, right: ProviderActorReference): boolean {
  return left.actorId === right.actorId && left.kind === right.kind && left.providerAddress === right.providerAddress;
}

function sourceOf(input: NormalizedPhotonInput): PhotonOperationSource {
  if (!("conversation" in input) || !("actor" in input) || !input.actor || input.actor.kind !== "human") {
    deny("human_source_required");
  }
  if (input.event.direction !== "inbound") deny("inbound_source_required");
  return {
    event: input.event,
    actor: input.actor as ProviderActorReference & { kind: "human" },
    conversation: input.conversation as ConversationReference,
    input,
  };
}

export function parsePhotonOperationSource(value: unknown): PhotonOperationSource {
  return sourceOf(parseNormalizedPhotonInput(value));
}

export function photonRedeliveryKey(event: ProviderEventIdentity): string {
  return JSON.stringify({
    provider: event.provider,
    installationId: event.installationId,
    lineId: event.lineId ?? null,
    eventId: event.eventId,
  });
}

export function photonOperationIdempotencyKey(source: PhotonOperationSource, logicalKey: string): string {
  return JSON.stringify({
    provider: source.event.provider,
    installationId: source.event.installationId,
    lineId: source.event.lineId ?? null,
    conversationId: source.conversation.conversationId,
    eventId: source.event.eventId,
    logicalKey,
  });
}

export function parsePhotonOperationEnvelope(
  value: unknown,
  checked = false,
): { source: PhotonOperationSource; operation: QmChannelOperationRequest | CheckedQmChannelOperation } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("photon envelope must be an object");
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((key) => key !== "source" && key !== "operation");
  if (unexpected.length) throw new TypeError(`photon envelope contains unsupported fields: ${unexpected.join(",")}`);
  return {
    source: parsePhotonOperationSource(record.source),
    operation: checked
      ? parseCheckedQmChannelOperation(record.operation)
      : parseQmChannelOperationRequest(record.operation),
  };
}

function runId(operation: QmChannelOperationRequest): string | undefined {
  if (operation.name === "turn.steer" || operation.name === "run.signal") return operation.input.runId;
  return undefined;
}

function operationSessionId(operation: QmChannelOperationRequest): string | undefined {
  if (operation.sessionId) return operation.sessionId;
  if (
    operation.name === "turn.resume" ||
    operation.name === "session.share" ||
    operation.name === "session.rename" ||
    operation.name === "session.fork"
  ) {
    return operation.input.sessionId;
  }
  return undefined;
}

function actionRequest(binding: ActionBinding, actor: ProviderActorReference, now: string) {
  return {
    bindingId: binding.bindingId,
    actor,
    resourceType: binding.resource.resourceType,
    resourceId: binding.resource.resourceId,
    resourceRevision: binding.resourceRevision,
    allowedAction: binding.allowedAction,
    sessionId: binding.session.sessionId,
    conversation: binding.conversation,
    now,
  };
}

export interface PhotonAuthorizer {
  check(source: PhotonOperationSource, operation: QmChannelOperationRequest): Promise<CheckedQmChannelOperation>;
  authorize(
    source: PhotonOperationSource,
    operation: QmChannelOperationRequest,
    options?: { consumeAction?: boolean },
  ): Promise<AuthorizedPhotonOperation>;
}

export function createPhotonAuthorization(deps: PhotonAuthorizationDeps): PhotonAuthorizer {
  const now = deps.now ?? Date.now;

  async function authorize(
    source: PhotonOperationSource,
    operation: QmChannelOperationRequest,
    options: { consumeAction?: boolean } = {},
  ): Promise<AuthorizedPhotonOperation> {
    const currentSource = parsePhotonOperationSource(source.input);
    if (
      !isDeepStrictEqual(currentSource.event, source.event) ||
      !isDeepStrictEqual(currentSource.actor, source.actor) ||
      !isDeepStrictEqual(currentSource.conversation, source.conversation)
    ) {
      deny("source_context_mismatch");
    }
    if (operation.name === "turn.start") {
      if (!isDeepStrictEqual(operation.input.request, source.input)) deny("turn_source_mismatch");
      if (operation.input.redeliveryKey !== photonRedeliveryKey(source.event)) deny("redelivery_scope_mismatch");
    }

    const installation = await deps.installations.read(source.event.installationId);
    if (!installation || installation.status.state !== "connected") deny("installation_inactive");
    if (
      installation.installation.installationId !== source.event.installationId ||
      installation.status.installationId !== source.event.installationId ||
      installation.installation.projectId !== source.conversation.projectId ||
      installation.status.projectId !== source.conversation.projectId ||
      !installation.status.lines.some((line) => line.lineId === source.conversation.lineId)
    ) {
      deny("installation_scope_mismatch");
    }

    const resolvedActor = await deps.identities.resolveActor(source.event, source.actor);
    if (
      !resolvedActor ||
      resolvedActor.kind !== "human" ||
      !sameProviderActor(resolvedActor, source.actor) ||
      !resolvedActor.canonicalIdentityId ||
      resolvedActor.canonicalIdentityId !== operation.actorId
    ) {
      deny("human_unlinked");
    }

    let action: ActionBinding | undefined;
    let binding: PhotonConversationAuthorizationBinding;

    if (operation.name === "turn.start" && currentSource.input.kind === "message" && currentSource.input.replyTo) {
      const replyTo = currentSource.input.replyTo;
      if (!sameConversation(replyTo, source.conversation)) deny("reply_scope_mismatch");
      const original = await deps.messages.findByProviderPart(replyTo);
      if (
        !original ||
        !sameConversation(original.providerMessage.conversation, source.conversation) ||
        !original.providerMessage.parts.some(
          (part) => part.messageId === replyTo.messageId && part.partIndex === replyTo.partIndex,
        )
      ) {
        deny("reply_binding_missing");
      }
      binding = {
        conversation: original.providerMessage.conversation,
        qmSessionId: original.qmSessionId,
        resourceRevision: original.resourceRevision,
      };
    } else if (operation.name === "approval.resolve") {
      action = await deps.actions.read(source.conversation, operation.input.bindingId);
      if (!action || !sameConversation(action.conversation, source.conversation)) {
        deny("action_not_authorized");
      }
      binding = {
        conversation: action.conversation,
        qmSessionId: action.session.sessionId,
        resourceRevision: action.resourceRevision,
      };
    } else {
      const selected = await deps.conversations.find(source.conversation);
      if (!selected || !sameConversation(selected.conversation, source.conversation)) {
        deny("conversation_unlinked");
      }
      binding = selected;
    }

    const claimedSessionId = operationSessionId(operation);
    if (claimedSessionId !== undefined && claimedSessionId !== binding.qmSessionId) deny("session_mismatch");

    const visible = await deps.app.getSessionForViewer(binding.qmSessionId, operation.actorId, { tailTurns: 1 });
    if (!visible || visible.session.id !== binding.qmSessionId) deny("membership_revoked");
    if (
      !(await deps.app.authorizesCapabilityScope({
        actorId: operation.actorId,
        scopeId: visible.session.scopeId,
        scopeVersion: binding.resourceRevision,
      }))
    ) {
      deny("resource_revision_revoked");
    }

    const requestedRunId = runId(operation);
    if (requestedRunId) {
      const [stored, current] = await Promise.all([
        deps.runs.get(requestedRunId),
        deps.app.getRun(requestedRunId, operation.actorId),
      ]);
      if (!stored || !current || stored.sessionId !== visible.session.threadRef) deny("run_not_authorized");
    }

    let approval: AuthorizedPhotonOperation["approval"];
    if (operation.name === "approval.resolve") {
      const actionExpiry = action ? Date.parse(action.expiresAt) : Number.NaN;
      if (
        !action ||
        action.allowedAction !== operation.name ||
        action.resource.resourceType !== "approval" ||
        action.resourceRevision !== binding.resourceRevision ||
        action.session.sessionId !== binding.qmSessionId ||
        !sameActor(action.actor, resolvedActor) ||
        !sameConversation(action.conversation, source.conversation) ||
        !Number.isFinite(actionExpiry) ||
        actionExpiry <= now()
      ) {
        deny("action_not_authorized");
      }
      const currentApproval = await deps.app.getApproval(action.resource.resourceId, operation.actorId);
      if (!currentApproval || currentApproval.sessionId !== binding.qmSessionId || !currentApproval.request) {
        deny("approval_not_authorized");
      }
      approval = currentApproval;
      if (options.consumeAction) {
        const consumed = await deps.actions.consume(
          actionRequest(action, resolvedActor, new Date(now()).toISOString()),
        );
        if (!consumed) deny("action_already_consumed");
        if (!isDeepStrictEqual(consumed, action)) deny("action_consumption_mismatch");
        action = consumed;
      }
    }

    if (
      operation.name !== "turn.start" &&
      operation.name !== "turn.steer" &&
      operation.name !== "approval.resolve" &&
      operation.name !== "run.signal"
    ) {
      deny("operation_authority_unavailable");
    }

    const checked = parseCheckedQmChannelOperation({
      ...operation,
      authorization: {
        actorId: operation.actorId,
        capabilityId: operation.name,
        resourceRevision: binding.resourceRevision,
        checkedAt: new Date(now()).toISOString(),
        decision: "allowed",
      },
    });
    return {
      checked,
      source: currentSource,
      actor: resolvedActor as ProviderActorReference & { kind: "human"; canonicalIdentityId: string },
      session: visible.session,
      binding,
      ...(approval ? { approval } : {}),
      ...(action ? { action } : {}),
    };
  }

  return {
    authorize,
    async check(source, operation) {
      return (await authorize(source, operation)).checked;
    },
  };
}
