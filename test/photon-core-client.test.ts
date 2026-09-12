import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";

import type {
  ActionBinding,
  ConversationReference,
  NormalizedPhotonInput,
  ProviderActorReference,
  QmChannelOperationRequest,
} from "../plugins/chassis/src/photon-contract.ts";
import {
  createPhotonAuthorization,
  photonOperationIdempotencyKey,
  photonRedeliveryKey,
  type PhotonActionAuthorizationPort,
  type PhotonOperationSource,
} from "../src/api/photon-authorization.ts";
import { createPhotonCoreClient } from "../src/api/photon-core-client.ts";
import type { App } from "../src/api/app.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { personalScope, type PendingApprovalRecord, type TurnRequest } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ACTOR_ID = "photon-human";
const PROVIDER_ACTOR_ID = "provider-human";
const INSTALLATION_ID = "installation-1";
const PROJECT_ID = "project-1";
const LINE_ID = "line-1";
const THREAD_REF = "photon:thread-1";
const REVISION = "revision-1";
const CONVERSATION: ConversationReference = {
  provider: "spectrum-imessage",
  installationId: INSTALLATION_ID,
  projectId: PROJECT_ID,
  lineId: LINE_ID,
  conversationId: "conversation-1",
};
const PROVIDER_ACTOR: ProviderActorReference = {
  actorId: PROVIDER_ACTOR_ID,
  kind: "human",
  providerAddress: "+15555550100",
};
const RESOLVED_ACTOR: ProviderActorReference = {
  ...PROVIDER_ACTOR,
  canonicalIdentityId: ACTOR_ID,
};

function source(eventId: string, text: string, conversation = CONVERSATION): PhotonOperationSource {
  const part = { messageId: `message-${eventId}`, partIndex: 0 };
  const input: NormalizedPhotonInput = {
    event: {
      provider: conversation.provider,
      installationId: conversation.installationId,
      eventId,
      lineId: conversation.lineId,
      occurredAt: "2026-09-12T08:00:00.000Z",
      direction: "inbound",
    },
    kind: "message",
    conversation,
    actor: PROVIDER_ACTOR as ProviderActorReference & { kind: "human" },
    message: {
      conversation,
      messageId: `message-${eventId}`,
      parts: [{ messageId: part.messageId, partIndex: part.partIndex }],
    },
    content: [{ kind: "text", part, text }],
  };
  return { event: input.event, actor: input.actor, conversation, input };
}

function startOperation(
  sourceInput: PhotonOperationSource,
): Extract<QmChannelOperationRequest, { name: "turn.start" }> {
  return {
    operationId: `operation-${sourceInput.event.eventId}`,
    name: "turn.start",
    actorId: ACTOR_ID,
    idempotencyKey: `logical-${sourceInput.event.eventId}`,
    input: {
      source: "photon",
      request: sourceInput.input as Extract<NormalizedPhotonInput, { kind: "message" }>,
      redeliveryKey: photonRedeliveryKey(sourceInput.event),
    },
  };
}

function runOperation(
  sourceInput: PhotonOperationSource,
  runId: string,
  signal: "abort" | "steer" = "steer",
): Extract<QmChannelOperationRequest, { name: "run.signal" }> {
  return {
    operationId: `operation-${sourceInput.event.eventId}`,
    name: "run.signal",
    actorId: ACTOR_ID,
    idempotencyKey: `logical-${sourceInput.event.eventId}`,
    input: { runId, signal, ...(signal === "steer" ? { text: "keep the raced input" } : {}) },
  };
}

class Actions implements PhotonActionAuthorizationPort {
  binding: ActionBinding | undefined;
  consumed = false;

  async read(): Promise<ActionBinding | undefined> {
    return this.binding;
  }

  async consume(): Promise<ActionBinding | undefined> {
    if (this.consumed) return undefined;
    this.consumed = true;
    return this.binding;
  }
}

async function boundary(options: { approval?: PendingApprovalRecord & { requestId: string } } = {}) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "photon-core-")) }));
  const session = await built.sessions.getOrCreateByThread(
    THREAD_REF,
    "dm",
    personalScope(ACTOR_ID),
    undefined,
    "photon",
  );
  await built.sessions.addParticipant(session.id, ACTOR_ID);
  const state = {
    active: true,
    linked: true,
    member: true,
    revision: true,
    conversation: CONVERSATION,
  };
  const actions = new Actions();
  const authApp = {
    authorizesCapabilityScope: (...args: Parameters<App["authorizesCapabilityScope"]>) =>
      state.revision ? built.app.authorizesCapabilityScope(...args) : Promise.resolve(false),
    getApproval: (...args: Parameters<App["getApproval"]>) =>
      options.approval ? Promise.resolve(options.approval) : built.app.getApproval(...args),
    getRun: (...args: Parameters<App["getRun"]>) => built.app.getRun(...args),
    getSessionForViewer: (...args: Parameters<App["getSessionForViewer"]>) =>
      state.member ? built.app.getSessionForViewer(...args) : Promise.resolve(null),
  };
  const authorization = createPhotonAuthorization({
    app: authApp,
    installations: {
      async read(installationId) {
        if (!state.active || installationId !== INSTALLATION_ID) return undefined;
        return {
          installation: { installationId: INSTALLATION_ID, projectId: PROJECT_ID },
          status: {
            state: "connected",
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
      async resolveActor(_event, actor) {
        return state.linked && actor.actorId === PROVIDER_ACTOR_ID ? RESOLVED_ACTOR : undefined;
      },
    },
    conversations: {
      async find(conversation) {
        if (!isDeepStrictEqual(conversation, state.conversation)) return undefined;
        return { conversation: state.conversation, qmSessionId: session.id, resourceRevision: REVISION };
      },
    },
    actions,
    runs: built.runs,
    now: () => Date.parse("2026-09-12T08:00:00.000Z"),
  });
  const core = createPhotonCoreClient({
    app: {
      ackDelivery: (...args) => built.app.ackDelivery(...args),
      activeRunForThread: (...args) => built.app.activeRunForThread(...args),
      fulfillContextRequest: (...args) => built.app.fulfillContextRequest(...args),
      getApproval: (...args) => authApp.getApproval(...args),
      getContextRequest: (...args) => built.app.getContextRequest(...args),
      getRun: (...args) => built.app.getRun(...args),
      listSessionApprovals: (...args) => built.app.listSessionApprovals(...args),
      pendingContextRequests: (...args) => built.app.pendingContextRequests(...args),
      pendingDeliveries: (...args) => built.app.pendingDeliveries(...args),
      signalRun: (...args) => built.app.signalRun(...args),
      turn: (...args) => built.app.turn(...args),
      withdrawRun: (...args) => built.app.withdrawRun(...args),
    },
    authorization,
    deliveries: built.deliveries,
  });
  return { built, core, state, session, actions };
}

test("scoped Photon redelivery produces one QM run and ordinary input steers the active run", async () => {
  const { built, core } = await boundary();
  const firstSource = source("event-1", "start the task");
  const firstOperation = startOperation(firstSource);
  const checked = await core.check(firstSource, firstOperation);
  const first = await core.execute(firstSource, checked);
  assert.equal(first.status, "queued");
  const repeated = await core.execute(firstSource, checked);
  assert.equal(repeated.status, "silent");
  assert.equal((await built.runs.list()).filter((run) => run.sessionId === THREAD_REF).length, 1);

  const secondSource = source("event-2", "use the smaller diff");
  const secondOperation = startOperation(secondSource);
  const steered = await core.execute(secondSource, await core.check(secondSource, secondOperation));
  assert.equal(steered.runId, first.runId);
  assert.equal(steered.steered, true);
  const signals = await built.signals.takePending(String(first.runId));
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.kind, "steer");
  assert.equal(signals[0]?.dedupeKey, photonRedeliveryKey(secondSource.event));

  const haltSource = source("event-3", "stop");
  const halted = await core.execute(haltSource, await core.check(haltSource, startOperation(haltSource)));
  assert.equal(halted.runId, first.runId);
  assert.equal((await built.signals.takePending(String(first.runId)))[0]?.kind, "abort");
});

test("installation, canonical human, current membership, conversation, and revision checks fail closed", async () => {
  const { built, core, state, session } = await boundary();
  const current = source("event-auth", "do not run");
  const operation = startOperation(current);
  for (const key of ["active", "linked", "member", "revision"] as const) {
    state[key] = false;
    await assert.rejects(() => core.check(current, operation));
    state[key] = true;
  }
  const otherConversation = { ...CONVERSATION, conversationId: "conversation-other" };
  const wrongConversation = source("event-other", "do not run", otherConversation);
  await assert.rejects(() => core.check(wrongConversation, startOperation(wrongConversation)));
  const unsupported: Extract<QmChannelOperationRequest, { name: "session.rename" }> = {
    operationId: "operation-unsupported",
    name: "session.rename",
    actorId: ACTOR_ID,
    sessionId: session.id,
    idempotencyKey: "logical-unsupported",
    input: { sessionId: session.id, title: "not linked here" },
  };
  await assert.rejects(
    () => core.check(current, unsupported),
    (error) => error instanceof Error && error.message === "operation_authority_unavailable",
  );
  assert.equal((await built.runs.list()).length, 0);
});

test("run authority binds the source conversation and queued withdrawal stays in the existing run store", async () => {
  const { built, core, session } = await boundary();
  const request: OrchestratorInput = {
    surface: "photon",
    actor: { id: ACTOR_ID, type: "internal" },
    conversation: {
      kind: "dm",
      threadRef: THREAD_REF,
      audience: [{ id: ACTOR_ID, type: "internal" }],
    },
    text: "queued",
    origin: { kind: "human" },
  };
  const first = await built.runs.enqueue({ sessionId: session.threadRef, request });
  const queued = await built.runs.enqueue({
    sessionId: session.threadRef,
    request: { ...request, text: "withdraw me" },
  });
  assert.notEqual(first.run.id, queued.run.id);
  const requestSource = source("event-withdraw", "withdraw");
  const operation = runOperation(requestSource, queued.run.id, "abort");
  assert.deepEqual(await core.withdrawRun(requestSource, operation), { withdrawn: true });

  const otherSession = await built.sessions.getOrCreateByThread(
    "photon:other",
    "dm",
    personalScope(ACTOR_ID),
    undefined,
    "photon",
  );
  await built.sessions.addParticipant(otherSession.id, ACTOR_ID);
  const other = await built.runs.enqueue({
    sessionId: otherSession.threadRef,
    request: { ...request, text: "other" },
  });
  await assert.rejects(() => core.withdrawRun(requestSource, runOperation(requestSource, other.run.id, "abort")));
});

test("signal terminal races reuse QM orphan replay and stable signal dedupe", async () => {
  const { built, core } = await boundary();
  const initialSource = source("event-race-start", "start");
  const initial = await core.execute(initialSource, await core.check(initialSource, startOperation(initialSource)));
  const runId = String(initial.runId);
  const originalSend = built.signals.send.bind(built.signals);
  built.signals.send = async (id, signal) => {
    const stored = await originalSend(id, signal);
    const claimed = await built.runs.claimById(id, "photon-test", 30_000);
    if (claimed?.leaseToken) await built.runs.complete(id, claimed.leaseToken, { status: "silent" });
    return stored;
  };
  const raceSource = source("event-race-steer", "keep the raced input");
  const operation = runOperation(raceSource, runId);
  const outcome = await core.execute(raceSource, await core.check(raceSource, operation));
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.reason, "terminal");
  assert.equal(outcome.replayed, true);
  const runs = (await built.runs.list()).filter((run) => run.sessionId === THREAD_REF);
  assert.equal(runs.length, 2);
  assert.equal(runs.find((run) => run.id !== runId)?.request.text, "keep the raced input");
  assert.equal((await built.signals.takePending(runId)).length, 0);
});

test("explicit run signals use tenant-scoped stable idempotency without duplicate effects", async () => {
  const { built, core } = await boundary();
  const initialSource = source("event-signal-start", "start");
  const initial = await core.execute(initialSource, await core.check(initialSource, startOperation(initialSource)));
  const runId = String(initial.runId);
  const signalSource = source("event-signal", "continue");
  const operation = runOperation(signalSource, runId);
  const checked = await core.check(signalSource, operation);
  assert.deepEqual(await core.execute(signalSource, checked), { accepted: true });
  assert.deepEqual(await core.execute(signalSource, checked), { accepted: true });
  const signals = await built.signals.takePending(runId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.dedupeKey, photonOperationIdempotencyKey(signalSource, operation.idempotencyKey));
});

test("approval reads are current, action-scoped, and omit the stored replay request", async () => {
  const approvalRequest: TurnRequest = {
    surface: "photon",
    actor: { externalId: ACTOR_ID },
    conversation: { kind: "dm", threadRef: THREAD_REF },
    text: "protected command",
  };
  const approval = {
    requestId: "approval-1",
    sessionId: "placeholder",
    command: "protected command",
    reason: "requires approval",
    request: approvalRequest,
  };
  const builtBoundary = await boundary({ approval });
  approval.sessionId = builtBoundary.session.id;
  const approvalSource = source("event-approval", "approve");
  builtBoundary.actions.binding = {
    bindingId: "binding-1",
    actor: RESOLVED_ACTOR,
    resource: { resourceType: "approval", resourceId: approval.requestId },
    resourceRevision: REVISION,
    allowedAction: "approval.resolve",
    expiresAt: "2026-09-12T09:00:00.000Z",
    session: { sessionId: builtBoundary.session.id },
    conversation: CONVERSATION,
  };
  const operation: Extract<QmChannelOperationRequest, { name: "approval.resolve" }> = {
    operationId: "operation-approval",
    name: "approval.resolve",
    actorId: ACTOR_ID,
    sessionId: builtBoundary.session.id,
    idempotencyKey: "logical-approval",
    input: { bindingId: "binding-1", decision: "approve" },
  };
  const view = await builtBoundary.core.getApproval(approvalSource, operation);
  assert.equal(view?.requestId, approval.requestId);
  assert.equal(view?.command, approval.command);
  assert.equal(Object.hasOwn(view ?? {}, "request"), false);
  assert.equal(Object.hasOwn(view ?? {}, "sessionId"), false);
  const binding = builtBoundary.actions.binding;
  assert.ok(binding);
  binding.expiresAt = "not-a-date";
  await assert.rejects(
    () => builtBoundary.core.getApproval(approvalSource, operation),
    (error) => error instanceof Error && error.message === "action_not_authorized",
  );
});

test("QM failures propagate without being converted to success", async () => {
  const builtBoundary = await boundary();
  const requestSource = source("event-failure", "fail");
  const operation = startOperation(requestSource);
  const checked = await builtBoundary.core.check(requestSource, operation);
  builtBoundary.built.app.turn = async () => {
    throw new Error("qm failed");
  };
  await assert.rejects(() => builtBoundary.core.execute(requestSource, checked), /qm failed/);
});

test("machine delivery and context operations stay isolated to the Photon surface", async () => {
  const { built, core } = await boundary();
  const photonDelivery = await built.deliveries.enqueue({
    destination: { type: "photon", target: "conversation-1" },
    text: "photon",
    idempotencyKey: "delivery-photon",
  });
  const slackDelivery = await built.deliveries.enqueue({
    destination: { type: "slack", target: "channel-1" },
    text: "slack",
    idempotencyKey: "delivery-slack",
  });
  assert.deepEqual(await core.ackDelivery(photonDelivery.id), { ok: true });
  await assert.rejects(() => core.ackDelivery(slackDelivery.id), /delivery_not_authorized/);
  assert.equal((await built.deliveries.get(photonDelivery.id))?.deliveredAt !== null, true);
  assert.equal((await built.deliveries.get(slackDelivery.id))?.deliveredAt, null);

  const photonContext = await built.app.createContextRequest("photon", { count: 1 });
  const slackContext = await built.app.createContextRequest("slack", { count: 1 });
  assert.deepEqual(await core.fulfillContextRequest(photonContext.id, { result: { messages: [] } }), {
    fulfilled: true,
  });
  await assert.rejects(
    () => core.fulfillContextRequest(slackContext.id, { result: { messages: [] } }),
    /context_request_not_authorized/,
  );
  assert.equal((await built.app.getContextRequest(photonContext.id))?.status, "done");
  assert.equal((await built.app.getContextRequest(slackContext.id))?.status, "pending");
});
