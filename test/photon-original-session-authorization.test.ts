import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";

import type {
  ActionBinding,
  ConversationReference,
  MessagePartReference,
  MessageReference,
  NormalizedPhotonInput,
  ProviderActorReference,
  QmChannelOperationRequest,
} from "../plugins/chassis/src/photon-contract.ts";
import {
  createPhotonAuthorization,
  PhotonAuthorizationError,
  type PhotonActionAuthorizationPort,
  type PhotonAuthorizationDeps,
  type PhotonOperationSource,
} from "../src/api/photon-authorization.ts";
import { createPhotonCoreClient, type PhotonCoreClientDeps } from "../src/api/photon-core-client.ts";
import { personalScope, type PendingApprovalRecord, type Session, type TurnRequest } from "../src/types.ts";

const ACTOR_ID = "photon-human";
const ATTACKER_ID = "photon-attacker";
const PROVIDER_ACTOR_ID = "provider-human";
const ATTACKER_PROVIDER_ACTOR_ID = "provider-attacker";
const INSTALLATION_ID = "installation-1";
const PROJECT_ID = "project-1";
const LINE_ID = "line-1";
const REVISION_A = "revision-a";
const REVISION_B = "revision-b";
const CONVERSATION: ConversationReference = {
  provider: "spectrum-imessage",
  installationId: INSTALLATION_ID,
  projectId: PROJECT_ID,
  lineId: LINE_ID,
  conversationId: "conversation-1",
};
const FOREIGN_CONVERSATION: ConversationReference = {
  ...CONVERSATION,
  conversationId: "conversation-foreign",
};
const PROVIDER_ACTOR: ProviderActorReference & { kind: "human" } = {
  actorId: PROVIDER_ACTOR_ID,
  kind: "human",
  providerAddress: "+15555550100",
};
const ATTACKER_PROVIDER_ACTOR: ProviderActorReference & { kind: "human" } = {
  actorId: ATTACKER_PROVIDER_ACTOR_ID,
  kind: "human",
  providerAddress: "+15555550101",
};
const RESOLVED_ACTOR: ProviderActorReference = { ...PROVIDER_ACTOR, canonicalIdentityId: ACTOR_ID };
const RESOLVED_ATTACKER: ProviderActorReference = {
  ...ATTACKER_PROVIDER_ACTOR,
  canonicalIdentityId: ATTACKER_ID,
};

const SESSION_A: Session = {
  id: "session-a",
  type: "dm",
  scopeId: personalScope(ACTOR_ID),
  threadRef: "photon:session-a",
  createdAt: Date.parse("2026-09-12T07:00:00.000Z"),
  surface: "photon",
};
const SESSION_B: Session = {
  id: "session-b",
  type: "dm",
  scopeId: personalScope(ACTOR_ID),
  threadRef: "photon:session-b",
  createdAt: Date.parse("2026-09-12T07:30:00.000Z"),
  surface: "photon",
};

type SessionKey = "a" | "b";
type ActionConsumptionRequest = Parameters<PhotonActionAuthorizationPort["consume"]>[0];

interface MessageBinding {
  providerMessage: MessageReference;
  qmSessionId: string;
  qmEntrySequence: number;
  resourceRevision: string;
}

interface ScenarioCalls {
  actionConsumptionRequests: ActionConsumptionRequest[];
  actionConsumes: number;
  actionReads: number;
  approvalReads: number;
  approvalViewers: (string | undefined)[];
  capabilityChecks: number;
  conversationReads: number;
  identityReads: number;
  messageLookups: MessagePartReference[];
  runStoreReads: number;
  sessionReads: number;
  turnRequests: TurnRequest[];
  businessStoreWrites: number;
  slackAuthorizations: number;
  webAuthorizations: number;
}

interface ScenarioState {
  action?: ActionBinding;
  approvals: Map<string, PendingApprovalRecord & { requestId: string }>;
  authorizedRevisions: Set<string>;
  consumedAction: boolean;
  conversationLookupAvailable: boolean;
  messages: Map<string, MessageBinding>;
  run?: { id: string; sessionId: string; visible: boolean };
  selected: SessionKey;
  visibleSessions: Set<string>;
  calls: ScenarioCalls;
}

interface Scenario {
  authorization: ReturnType<typeof createPhotonAuthorization>;
  core: ReturnType<typeof createPhotonCoreClient>;
  state: ScenarioState;
}

function partKey(part: MessagePartReference): string {
  return JSON.stringify([
    part.provider,
    part.installationId,
    part.projectId,
    part.lineId,
    part.conversationId,
    part.messageId,
    part.partIndex,
  ]);
}

function messagePart(messageId: string, conversation: ConversationReference = CONVERSATION): MessagePartReference {
  return { ...conversation, messageId, partIndex: 0 };
}

function messageBinding(
  part: MessagePartReference,
  session: SessionKey,
  conversation: ConversationReference = CONVERSATION,
): MessageBinding {
  return {
    providerMessage: {
      conversation,
      messageId: part.messageId,
      parts: [{ messageId: part.messageId, partIndex: part.partIndex }],
    },
    qmSessionId: session === "a" ? SESSION_A.id : SESSION_B.id,
    qmEntrySequence: 17,
    resourceRevision: session === "a" ? REVISION_A : REVISION_B,
  };
}

function source(
  eventId: string,
  text: string,
  replyTo?: MessagePartReference,
  actor: ProviderActorReference & { kind: "human" } = PROVIDER_ACTOR,
): PhotonOperationSource {
  const part = { messageId: `message-${eventId}`, partIndex: 0 };
  const input: NormalizedPhotonInput = {
    event: {
      provider: CONVERSATION.provider,
      installationId: CONVERSATION.installationId,
      eventId,
      lineId: CONVERSATION.lineId,
      occurredAt: "2026-09-12T08:00:00.000Z",
      direction: "inbound",
    },
    kind: "message",
    conversation: CONVERSATION,
    actor,
    message: {
      conversation: CONVERSATION,
      messageId: part.messageId,
      parts: [part],
    },
    content: [{ kind: "text", part, text }],
    ...(replyTo ? { replyTo } : {}),
  };
  return { event: input.event, actor: input.actor, conversation: CONVERSATION, input };
}

function startOperation(
  sourceInput: PhotonOperationSource,
  options: { actorId?: string; sessionId?: string } = {},
): Extract<QmChannelOperationRequest, { name: "turn.start" }> {
  return {
    operationId: `operation-${sourceInput.event.eventId}`,
    name: "turn.start",
    actorId: options.actorId ?? ACTOR_ID,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    idempotencyKey: `logical-${sourceInput.event.eventId}`,
    input: {
      source: "photon",
      request: sourceInput.input as Extract<NormalizedPhotonInput, { kind: "message" }>,
      redeliveryKey: JSON.stringify({
        provider: sourceInput.event.provider,
        installationId: sourceInput.event.installationId,
        lineId: sourceInput.event.lineId ?? null,
        eventId: sourceInput.event.eventId,
      }),
    },
  };
}

function approvalOperation(
  sourceInput: PhotonOperationSource,
  bindingId: string,
  options: { actorId?: string; sessionId?: string } = {},
): Extract<QmChannelOperationRequest, { name: "approval.resolve" }> {
  return {
    operationId: `operation-${sourceInput.event.eventId}`,
    name: "approval.resolve",
    actorId: options.actorId ?? ACTOR_ID,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    idempotencyKey: `logical-${sourceInput.event.eventId}`,
    input: { bindingId, decision: "approve" },
  };
}

function steerOperation(
  sourceInput: PhotonOperationSource,
  runId: string,
): Extract<QmChannelOperationRequest, { name: "turn.steer" }> {
  return {
    operationId: `operation-${sourceInput.event.eventId}`,
    name: "turn.steer",
    actorId: ACTOR_ID,
    idempotencyKey: `logical-${sourceInput.event.eventId}`,
    input: { runId, text: "continue" },
  };
}

function approvalRecord(session: Session, requestId = "approval-a"): PendingApprovalRecord & { requestId: string } {
  return {
    requestId,
    sessionId: session.id,
    command: "protected command",
    reason: "requires approval",
    request: {
      surface: "photon",
      actor: { externalId: ACTOR_ID },
      conversation: { kind: session.type, threadRef: session.threadRef },
      text: "protected command",
    },
  };
}

function actionBinding(
  session: Session,
  resourceId = "approval-a",
  actor: ProviderActorReference = RESOLVED_ACTOR,
  bindingId = "action-a",
): ActionBinding {
  return {
    bindingId,
    actor,
    resource: { resourceType: "approval", resourceId },
    resourceRevision: session.id === SESSION_A.id ? REVISION_A : REVISION_B,
    allowedAction: "approval.resolve",
    expiresAt: "2026-09-12T09:00:00.000Z",
    session: { sessionId: session.id },
    conversation: CONVERSATION,
  };
}

function createScenario(options: { includeMessages?: boolean } = {}): Scenario {
  const calls: ScenarioCalls = {
    actionConsumptionRequests: [],
    actionConsumes: 0,
    actionReads: 0,
    approvalReads: 0,
    approvalViewers: [],
    capabilityChecks: 0,
    conversationReads: 0,
    identityReads: 0,
    messageLookups: [],
    runStoreReads: 0,
    sessionReads: 0,
    turnRequests: [],
    businessStoreWrites: 0,
    slackAuthorizations: 0,
    webAuthorizations: 0,
  };
  const state: ScenarioState = {
    approvals: new Map(),
    authorizedRevisions: new Set([REVISION_A, REVISION_B]),
    consumedAction: false,
    conversationLookupAvailable: true,
    messages: new Map(),
    selected: "a",
    visibleSessions: new Set([SESSION_A.id, SESSION_B.id]),
    calls,
  };
  const sessions: Record<SessionKey, Session> = { a: SESSION_A, b: SESSION_B };
  const revisions: Record<SessionKey, string> = { a: REVISION_A, b: REVISION_B };
  const authApp: PhotonAuthorizationDeps["app"] = {
    authorizesCapabilityScope: async ({ scopeVersion }) => {
      calls.capabilityChecks += 1;
      return typeof scopeVersion === "string" && state.authorizedRevisions.has(scopeVersion);
    },
    getApproval: async (requestId, viewer) => {
      calls.approvalReads += 1;
      calls.approvalViewers.push(viewer);
      if (viewer !== ACTOR_ID) return null;
      return state.approvals.get(requestId) ?? null;
    },
    getRun: async (runId) => {
      calls.runStoreReads += 1;
      return state.run?.id === runId && state.run.visible
        ? { status: "running", result: null, startedAt: Date.parse("2026-09-12T08:00:00.000Z"), finishedAt: null }
        : null;
    },
    getSessionForViewer: async (sessionId) => {
      calls.sessionReads += 1;
      const session = Object.values(sessions).find((candidate) => candidate.id === sessionId);
      return session && state.visibleSessions.has(sessionId) ? { session, entries: [] } : null;
    },
  };
  const actions: PhotonActionAuthorizationPort = {
    read: async (_conversation, bindingId) => {
      calls.actionReads += 1;
      return state.action?.bindingId === bindingId ? state.action : undefined;
    },
    consume: async (request) => {
      calls.actionConsumes += 1;
      calls.actionConsumptionRequests.push(request);
      const action = state.action;
      const expected: ActionConsumptionRequest | undefined = action
        ? {
            bindingId: action.bindingId,
            actor: action.actor,
            resourceType: action.resource.resourceType,
            resourceId: action.resource.resourceId,
            resourceRevision: action.resourceRevision,
            allowedAction: action.allowedAction,
            sessionId: action.session.sessionId,
            conversation: action.conversation,
            now: "2026-09-12T08:00:00.000Z",
          }
        : undefined;
      if (state.consumedAction || !expected || !isDeepStrictEqual(request, expected)) return undefined;
      state.consumedAction = true;
      return action;
    },
  };
  const dependencies: PhotonAuthorizationDeps = {
    app: authApp,
    installations: {
      async read(installationId: string) {
        if (installationId !== INSTALLATION_ID) return undefined;
        return {
          installation: { installationId: INSTALLATION_ID, projectId: PROJECT_ID },
          status: {
            state: "connected" as const,
            installationId: INSTALLATION_ID,
            projectId: PROJECT_ID,
            lines: [{ lineId: LINE_ID }],
          },
          ownerRevision: "owner-1",
          version: 1,
        };
      },
    },
    identities: {
      async resolveActor(_event: unknown, actor: ProviderActorReference) {
        calls.identityReads += 1;
        if (actor.actorId === PROVIDER_ACTOR_ID) return RESOLVED_ACTOR;
        if (actor.actorId === ATTACKER_PROVIDER_ACTOR_ID) return RESOLVED_ATTACKER;
        return undefined;
      },
    },
    conversations: {
      async find(conversation: ConversationReference) {
        calls.conversationReads += 1;
        if (!state.conversationLookupAvailable) return undefined;
        if (!isDeepStrictEqual(conversation, CONVERSATION)) return undefined;
        const selected = state.selected;
        return {
          conversation: CONVERSATION,
          qmSessionId: sessions[selected].id,
          resourceRevision: revisions[selected],
        };
      },
    },
    actions,
    runs: {
      async get(runId) {
        calls.runStoreReads += 1;
        if (state.run?.id !== runId) return null;
        return {
          id: state.run.id,
          sessionId: state.run.sessionId,
          status: "running",
          request: {
            surface: "photon",
            actor: { id: ACTOR_ID, type: "internal" },
            conversation: {
              kind: "dm",
              threadRef: state.run.sessionId,
              audience: [{ id: ACTOR_ID, type: "internal" }],
            },
            text: "running",
            origin: { kind: "human" },
          },
          result: null,
          deliveryState: null,
          turnUserSeq: null,
          dedupKey: null,
          attempts: 1,
          errorAttempts: 0,
          maxAttempts: 3,
          leaseToken: "lease-1",
          leaseExpiresAt: Date.parse("2026-09-12T09:00:00.000Z"),
          workerId: "worker-1",
          createdAt: Date.parse("2026-09-12T07:00:00.000Z"),
          startedAt: Date.parse("2026-09-12T07:01:00.000Z"),
          finishedAt: null,
        };
      },
    },
    ...(options.includeMessages === false
      ? {}
      : {
          messages: {
            async findByProviderPart(part: MessagePartReference) {
              calls.messageLookups.push(part);
              return state.messages.get(partKey(part));
            },
          },
        }),
    now: () => Date.parse("2026-09-12T08:00:00.000Z"),
  };
  const authorization = createPhotonAuthorization(dependencies);
  const coreApp: PhotonCoreClientDeps["app"] = {
    ackDelivery: async () => {
      calls.businessStoreWrites += 1;
    },
    activeRunForThread: async () => null,
    fulfillContextRequest: async () => false,
    getApproval: authApp.getApproval,
    getContextRequest: async () => null,
    getRun: authApp.getRun,
    listSessionApprovals: async () => [],
    pendingContextRequests: async () => [],
    pendingDeliveries: async () => [],
    signalRun: async () => {
      calls.businessStoreWrites += 1;
      return { accepted: true };
    },
    turn: async (request) => {
      calls.turnRequests.push(request);
      return { status: "queued", sessionId: request.conversation.threadRef };
    },
    withdrawRun: async () => {
      calls.businessStoreWrites += 1;
      return { withdrawn: true };
    },
  };
  const core = createPhotonCoreClient({
    app: coreApp,
    authorization,
    deliveries: { get: async () => null },
  });
  return { authorization, core, state };
}

async function rejectsCode<T>(promise: Promise<T>, expected: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof PhotonAuthorizationError && error.code === expected,
  );
}

function assertNoOrdinaryEffects(state: ScenarioState): void {
  assert.equal(state.calls.turnRequests.length, 0);
  assert.equal(state.calls.runStoreReads, 0);
  assert.equal(state.calls.businessStoreWrites, 0);
  assert.equal(state.calls.slackAuthorizations, 0);
  assert.equal(state.calls.webAuthorizations, 0);
}

test("a reply remains in session A after a selection switch while a new message uses session B", async () => {
  const scenario = createScenario();
  const original = messagePart("original-a");
  scenario.state.messages.set(partKey(original), messageBinding(original, "a"));
  const reply = source("reply-a", "continue the old thread", original);
  scenario.state.conversationLookupAvailable = false;
  const checked = await scenario.core.check(reply, startOperation(reply));
  assert.equal(checked.authorization.resourceRevision, REVISION_A);
  assert.equal(scenario.state.calls.conversationReads, 0);

  scenario.state.selected = "b";
  const oldReplyResult = await scenario.core.execute(reply, checked);
  assert.equal(scenario.state.calls.conversationReads, 0);
  scenario.state.conversationLookupAvailable = true;
  const newMessage = source("message-b", "start in the selected thread");
  const newMessageResult = await scenario.core.execute(
    newMessage,
    await scenario.core.check(newMessage, startOperation(newMessage)),
  );

  assert.equal(oldReplyResult.status, "queued");
  assert.equal(newMessageResult.status, "queued");
  assert.deepEqual(
    scenario.state.calls.turnRequests.map((request) => request.conversation.threadRef),
    [SESSION_A.threadRef, SESSION_B.threadRef],
  );
  assert.deepEqual(
    scenario.state.calls.messageLookups.map((part) => part.messageId),
    [original.messageId, original.messageId],
  );
  assert.equal(scenario.state.calls.slackAuthorizations, 0);
  assert.equal(scenario.state.calls.webAuthorizations, 0);
});

test("unbound and foreign message parts fail before QM business effects", async () => {
  const unboundScenario = createScenario();
  const unbound = messagePart("unbound");
  const unboundSource = source("unbound-event", "cannot resolve", unbound);
  await rejectsCode(unboundScenario.core.check(unboundSource, startOperation(unboundSource)), "reply_binding_missing");
  assertNoOrdinaryEffects(unboundScenario.state);

  const unwiredScenario = createScenario({ includeMessages: false });
  const unwired = messagePart("unwired");
  const unwiredSource = source("unwired-event", "cannot resolve", unwired);
  await rejectsCode(unwiredScenario.core.check(unwiredSource, startOperation(unwiredSource)), "reply_binding_missing");
  assertNoOrdinaryEffects(unwiredScenario.state);

  const foreignScenario = createScenario();
  const foreignLookup = messagePart("foreign-binding");
  foreignScenario.state.messages.set(partKey(foreignLookup), messageBinding(foreignLookup, "a", FOREIGN_CONVERSATION));
  const foreignSource = source("foreign-event", "cannot cross conversations", foreignLookup);
  await rejectsCode(foreignScenario.core.check(foreignSource, startOperation(foreignSource)), "reply_binding_missing");
  assertNoOrdinaryEffects(foreignScenario.state);

  const unavailableScenario = createScenario();
  unavailableScenario.state.conversationLookupAvailable = false;
  const newMessage = source("unavailable-selection-event", "selection is unavailable");
  await rejectsCode(unavailableScenario.core.check(newMessage, startOperation(newMessage)), "conversation_unlinked");
  assert.equal(unavailableScenario.state.calls.conversationReads, 1);
  assert.equal(unavailableScenario.state.calls.messageLookups.length, 0);
  assertNoOrdinaryEffects(unavailableScenario.state);

  const foreignScopedSource = source(
    "foreign-scoped-event",
    "parser rejects foreign scope",
    messagePart("foreign", FOREIGN_CONVERSATION),
  );
  await assert.rejects(
    () => foreignScenario.core.check(foreignScopedSource, startOperation(foreignScopedSource)),
    /normalizedInput\.replyTo contradicts the event conversation/u,
  );
  assertNoOrdinaryEffects(foreignScenario.state);
});

test("reply authorization rejects revoked A, a spoofed actor, and a caller-supplied B session", async () => {
  const revokedScenario = createScenario();
  const revokedPart = messagePart("revoked-a");
  revokedScenario.state.messages.set(partKey(revokedPart), messageBinding(revokedPart, "a"));
  const revokedSource = source("revoked-event", "revoked old thread", revokedPart);
  const revokedChecked = await revokedScenario.core.check(revokedSource, startOperation(revokedSource));
  revokedScenario.state.visibleSessions.delete(SESSION_A.id);
  revokedScenario.state.authorizedRevisions.delete(REVISION_A);
  await rejectsCode(revokedScenario.core.execute(revokedSource, revokedChecked), "membership_revoked");
  assertNoOrdinaryEffects(revokedScenario.state);

  const staleRevisionScenario = createScenario();
  const staleRevisionPart = messagePart("stale-revision-a");
  staleRevisionScenario.state.messages.set(partKey(staleRevisionPart), messageBinding(staleRevisionPart, "a"));
  const staleRevisionSource = source("stale-revision-event", "revoked revision", staleRevisionPart);
  const staleRevisionChecked = await staleRevisionScenario.core.check(
    staleRevisionSource,
    startOperation(staleRevisionSource),
  );
  staleRevisionScenario.state.authorizedRevisions.delete(REVISION_A);
  await rejectsCode(
    staleRevisionScenario.core.execute(staleRevisionSource, staleRevisionChecked),
    "resource_revision_revoked",
  );
  assertNoOrdinaryEffects(staleRevisionScenario.state);

  const spoofedActorScenario = createScenario();
  const spoofedActorPart = messagePart("spoofed-actor");
  spoofedActorScenario.state.messages.set(partKey(spoofedActorPart), messageBinding(spoofedActorPart, "a"));
  const spoofedActorSource = source("spoofed-actor-event", "spoofed actor", spoofedActorPart, ATTACKER_PROVIDER_ACTOR);
  await rejectsCode(
    spoofedActorScenario.core.check(spoofedActorSource, startOperation(spoofedActorSource)),
    "human_unlinked",
  );
  assertNoOrdinaryEffects(spoofedActorScenario.state);

  const spoofedSessionScenario = createScenario();
  const spoofedSessionPart = messagePart("spoofed-session");
  spoofedSessionScenario.state.messages.set(partKey(spoofedSessionPart), messageBinding(spoofedSessionPart, "a"));
  const spoofedSessionSource = source("spoofed-session-event", "spoofed session", spoofedSessionPart);
  await rejectsCode(
    spoofedSessionScenario.core.check(
      spoofedSessionSource,
      startOperation(spoofedSessionSource, { sessionId: SESSION_B.id }),
    ),
    "session_mismatch",
  );
  assertNoOrdinaryEffects(spoofedSessionScenario.state);
});

test("execution revalidates run ownership after a successful check", async () => {
  const scenario = createScenario();
  const runId = "run-a";
  scenario.state.run = { id: runId, sessionId: SESSION_A.threadRef, visible: true };
  const currentSource = source("run-ownership-event", "continue the run");
  const operation = steerOperation(currentSource, runId);
  const checked = await scenario.core.check(currentSource, operation);

  scenario.state.run.sessionId = SESSION_B.threadRef;
  await rejectsCode(scenario.core.execute(currentSource, checked), "run_not_authorized");
  assert.equal(scenario.state.calls.runStoreReads, 4);
  assert.equal(scenario.state.calls.businessStoreWrites, 0);
  assert.equal(scenario.state.calls.turnRequests.length, 0);
});

test("approval resolution follows its original resource and actor binding after selection changes", async () => {
  const scenario = createScenario();
  scenario.state.action = actionBinding(SESSION_A);
  scenario.state.approvals.set("approval-a", approvalRecord(SESSION_A));
  scenario.state.selected = "b";
  scenario.state.conversationLookupAvailable = false;
  const approvalSource = source("approval-a-event", "approve the old request");
  const operation = approvalOperation(approvalSource, "action-a");
  const checked = await scenario.core.check(approvalSource, operation);
  assert.equal(checked.authorization.resourceRevision, REVISION_A);
  const result = await scenario.core.execute(approvalSource, checked);

  assert.equal(result.status, "queued");
  assert.deepEqual(
    scenario.state.calls.turnRequests.map((request) => request.conversation.threadRef),
    [SESSION_A.threadRef],
  );
  assert.equal(scenario.state.calls.actionConsumes, 1);
  assert.equal(scenario.state.calls.approvalReads, 2);
  assert.deepEqual(scenario.state.calls.approvalViewers, [ACTOR_ID, ACTOR_ID]);
  assert.equal(scenario.state.calls.conversationReads, 0);
  assert.deepEqual(scenario.state.calls.actionConsumptionRequests, [
    {
      bindingId: "action-a",
      actor: RESOLVED_ACTOR,
      resourceType: "approval",
      resourceId: "approval-a",
      resourceRevision: REVISION_A,
      allowedAction: "approval.resolve",
      sessionId: SESSION_A.id,
      conversation: CONVERSATION,
      now: "2026-09-12T08:00:00.000Z",
    },
  ]);
  assert.equal(scenario.state.calls.slackAuthorizations, 0);
  assert.equal(scenario.state.calls.webAuthorizations, 0);

  await rejectsCode(scenario.core.execute(approvalSource, checked), "action_already_consumed");
  assert.equal(scenario.state.calls.actionConsumes, 2);
  assert.equal(scenario.state.calls.turnRequests.length, 1);
  assert.deepEqual(scenario.state.calls.approvalViewers, [ACTOR_ID, ACTOR_ID, ACTOR_ID]);

  const wrongResourceScenario = createScenario();
  wrongResourceScenario.state.action = actionBinding(SESSION_A, "approval-b");
  wrongResourceScenario.state.approvals.set("approval-a", approvalRecord(SESSION_A));
  const wrongResourceSource = source("wrong-resource-event", "wrong resource");
  await rejectsCode(
    wrongResourceScenario.core.check(wrongResourceSource, approvalOperation(wrongResourceSource, "action-a")),
    "approval_not_authorized",
  );
  assertNoOrdinaryEffects(wrongResourceScenario.state);

  const wrongActorScenario = createScenario();
  wrongActorScenario.state.action = actionBinding(SESSION_A);
  wrongActorScenario.state.approvals.set("approval-a", approvalRecord(SESSION_A));
  const wrongActorSource = source("wrong-actor-event", "wrong actor", undefined, ATTACKER_PROVIDER_ACTOR);
  await rejectsCode(
    wrongActorScenario.core.check(
      wrongActorSource,
      approvalOperation(wrongActorSource, "action-a", { actorId: ATTACKER_ID }),
    ),
    "action_not_authorized",
  );
  assertNoOrdinaryEffects(wrongActorScenario.state);
});

test("approval check cannot be executed after access to its original session is revoked", async () => {
  const scenario = createScenario();
  scenario.state.action = actionBinding(SESSION_A);
  scenario.state.approvals.set("approval-a", approvalRecord(SESSION_A));
  const approvalSource = source("approval-revoked-event", "approve after revocation");
  const checked = await scenario.core.check(approvalSource, approvalOperation(approvalSource, "action-a"));
  scenario.state.visibleSessions.delete(SESSION_A.id);
  scenario.state.authorizedRevisions.delete(REVISION_A);

  await rejectsCode(scenario.core.execute(approvalSource, checked), "membership_revoked");
  assert.equal(scenario.state.calls.actionConsumes, 0);
  assert.equal(scenario.state.calls.turnRequests.length, 0);
  assert.equal(scenario.state.calls.slackAuthorizations, 0);
  assert.equal(scenario.state.calls.webAuthorizations, 0);
});
