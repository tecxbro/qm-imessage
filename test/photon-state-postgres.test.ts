import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";

import { createPostgresPhotonStateStores, type PhotonStateStores } from "../plugins/chassis/src/photon-state.ts";
import {
  PHOTON_ADAPTER_DATABASE_ROLE,
  PHOTON_CORE_LINK_DATABASE_ROLE,
  PHOTON_STATE_MIGRATION,
  PHOTON_STATE_SCHEMA,
} from "../plugins/chassis/src/photon-state-schema.ts";
import type {
  ActionBinding,
  MessagePartReference,
  PhotonOperationOutcome,
  PhotonPresentationOperation,
} from "../plugins/chassis/src/photon-contract.ts";
import { createPhotonStateDatabase, type PhotonStatePool } from "../plugins/photon/src/state.ts";
import {
  chats,
  competingActions,
  multipartMessages,
  normalizedInputs,
  operationReference,
  providerEvents,
  textOperation,
} from "../plugins/photon/test/fixtures.ts";
import { applyPgMigrations, definePgMigration, PG_MIGRATIONS_TABLE } from "../src/persistence/pg-pool.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL to a real PostgreSQL database";
const admin = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : undefined;
let stores: PhotonStateStores;

function database(pool: pg.Pool) {
  return createPhotonStateDatabase(pool as unknown as PhotonStatePool);
}

function receipt(index: 0 | 1, eventId: string, sequence?: string, lineId?: string) {
  const normalizedInput = structuredClone(normalizedInputs[index]!);
  const scopedLineId = lineId ?? normalizedInput.event.lineId!;
  const envelope = {
    ...normalizedInput,
    event: {
      ...providerEvents[index]!,
      eventId,
      lineId: scopedLineId,
      ...(sequence === undefined ? {} : { sequence }),
    },
    conversation: { ...normalizedInput.conversation, lineId: scopedLineId },
    message: {
      ...normalizedInput.message,
      conversation: { ...normalizedInput.message.conversation, lineId: scopedLineId },
    },
    content: normalizedInput.content.map((item) =>
      item.kind === "attachment" ? { ...item, attachment: { ...item.attachment, lineId: scopedLineId } } : item,
    ),
    ...(normalizedInput.replyTo === undefined ? {} : { replyTo: { ...normalizedInput.replyTo, lineId: scopedLineId } }),
  };
  if (sequence === undefined) delete (envelope.event as { sequence?: string }).sequence;
  return {
    key: {
      provider: envelope.event.provider,
      installationId: envelope.event.installationId,
      eventId,
      lineId: envelope.event.lineId,
    },
    ...(sequence === undefined ? {} : { sequence }),
    capturedAt: "2026-09-10T12:00:00.000Z",
    payload: { kind: "envelope" as const, envelope },
    state: "captured" as const,
  };
}

function multipartOperation(suffix: string): Extract<PhotonPresentationOperation, { name: "message.multipart" }> {
  return {
    operationId: `operation-${suffix}`,
    attemptId: `attempt-${suffix}`,
    name: "message.multipart",
    conversation: chats[0],
    idempotencyKey: `logical-${suffix}`,
    input: {
      parts: [
        { kind: "text", text: "first" },
        { kind: "attachment", attachment: { attachmentId: "file-a", providerReference: "blob://file-a" } },
        { kind: "text", text: "last" },
      ],
    },
  };
}

function providerPart(messageId: string, logicalPartIndex: number, partIndex = 0) {
  return {
    logicalPartIndex,
    part: { ...chats[0], messageId, partIndex },
  };
}

before(async () => {
  if (!admin) return;
  await admin.query(`DROP SCHEMA IF EXISTS ${PHOTON_STATE_SCHEMA} CASCADE`);
  await admin.query("CREATE TABLE IF NOT EXISTS qm_photon_unrelated_business(id TEXT PRIMARY KEY)");
  const ledger = await admin.query("SELECT to_regclass($1) AS name", [PG_MIGRATIONS_TABLE]);
  if (ledger.rows[0]?.name)
    await admin.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [PHOTON_STATE_MIGRATION.id]);
  await applyPgMigrations(admin, [definePgMigration(PHOTON_STATE_MIGRATION.id, PHOTON_STATE_MIGRATION.statements)]);
  stores = createPostgresPhotonStateStores(database(admin));
});

after(async () => {
  if (!admin) return;
  await admin.query(`DROP SCHEMA IF EXISTS ${PHOTON_STATE_SCHEMA} CASCADE`);
  await admin.query("DROP TABLE IF EXISTS qm_photon_unrelated_business");
  await admin.query(`DELETE FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [PHOTON_STATE_MIGRATION.id]);
  await admin.end();
});

test("migration replay is stable and database roles enforce adapter and core-link boundaries", { skip }, async () => {
  await applyPgMigrations(admin!, [definePgMigration(PHOTON_STATE_MIGRATION.id, PHOTON_STATE_MIGRATION.statements)]);
  const tables = await admin!.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
    [PHOTON_STATE_SCHEMA],
  );
  assert.equal(tables.rows.length, 15);
  const roles = await admin!.query(
    `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = ANY($1::text[])`,
    [[PHOTON_ADAPTER_DATABASE_ROLE, PHOTON_CORE_LINK_DATABASE_ROLE]],
  );
  assert.equal(roles.rows.length, 2);
  assert.equal(
    roles.rows.every((role) => Object.values(role).every((attribute) => attribute === false)),
    true,
  );

  const adapter = await admin!.connect();
  try {
    await adapter.query(`SET ROLE ${PHOTON_ADAPTER_DATABASE_ROLE}`);
    await adapter.query(`SELECT 1 FROM ${PHOTON_STATE_SCHEMA}.event_receipts LIMIT 1`);
    await assert.rejects(adapter.query("SELECT 1 FROM qm_photon_unrelated_business"), /permission denied/u);
    await assert.rejects(
      adapter.query(`INSERT INTO ${PG_MIGRATIONS_TABLE}(id, checksum) VALUES ('runtime', 'forbidden')`),
      /permission denied/u,
    );
    await assert.rejects(
      adapter.query(`CREATE TABLE ${PHOTON_STATE_SCHEMA}.runtime_migration(id TEXT)`),
      /permission denied/u,
    );
  } finally {
    await adapter.query("RESET ROLE");
    adapter.release();
  }

  const coreLink = await admin!.connect();
  try {
    await coreLink.query(`SET ROLE ${PHOTON_CORE_LINK_DATABASE_ROLE}`);
    await coreLink.query(`SELECT 1 FROM ${PHOTON_STATE_SCHEMA}.chat_session_bindings LIMIT 1`);
    await coreLink.query(`SELECT 1 FROM ${PHOTON_STATE_SCHEMA}.message_bindings LIMIT 1`);
    await assert.rejects(coreLink.query(`SELECT 1 FROM ${PHOTON_STATE_SCHEMA}.installations`), /permission denied/u);
  } finally {
    await coreLink.query("RESET ROLE");
    coreLink.release();
  }
});

test(
  "receipt claims fence competitors, expire safely, and isolate identical provider IDs by tenant",
  { skip },
  async () => {
    const a = createPostgresPhotonStateStores(database(admin!));
    const b = createPostgresPhotonStateStores(database(admin!));
    const first = receipt(0, "claim-shared", "101");
    const isolated = receipt(1, "claim-shared", "101");
    assert.equal(await a.receipts.capture(first), "captured");
    assert.equal(await b.receipts.capture(isolated), "captured");

    const [claimA, claimB] = await Promise.all([
      a.receipts.claim(first.key, "worker-a", "2026-09-10T12:00:00.000Z", "2026-09-10T12:01:00.000Z"),
      b.receipts.claim(first.key, "worker-b", "2026-09-10T12:00:00.000Z", "2026-09-10T12:01:00.000Z"),
    ]);
    assert.equal([claimA, claimB].filter(Boolean).length, 1);
    const firstClaim = (claimA ?? claimB)!.claim!;
    assert.equal(
      await b.receipts.claim(first.key, "worker-c", "2026-09-10T12:00:30.000Z", "2026-09-10T12:02:00.000Z"),
      undefined,
    );
    const replacement = await b.receipts.claim(
      first.key,
      "worker-c",
      "2026-09-10T12:01:00.000Z",
      "2026-09-10T12:02:00.000Z",
    );
    assert.equal(replacement?.claim?.fence, firstClaim.fence + 1);
    assert.equal(
      await a.receipts.advanceContiguousCheckpoint(
        first.key as typeof first.key & { lineId: string },
        0,
        "101",
        firstClaim,
        "2026-09-10T12:00:30.000Z",
      ),
      false,
    );
    const isolatedClaim = await a.receipts.claim(
      isolated.key,
      "worker-isolated",
      "2026-09-10T12:00:00.000Z",
      "2026-09-10T12:01:00.000Z",
    );
    assert.ok(isolatedClaim?.claim);

    const installationScoped = {
      key: {
        provider: "spectrum-imessage" as const,
        installationId: "installation-a",
        eventId: "installation-lifecycle",
      },
      capturedAt: "2026-09-10T12:00:00.000Z",
      payload: {
        kind: "reference" as const,
        reference: "blob://installation-lifecycle",
        payloadSha256: "a".repeat(64),
      },
      state: "captured" as const,
    };
    assert.equal(await stores.receipts.capture(installationScoped), "captured");
    const installationClaim = await stores.receipts.claim(
      installationScoped.key,
      "worker-installation",
      "2026-09-10T12:00:00.000Z",
      "2026-09-10T12:01:00.000Z",
    );
    assert.ok(installationClaim?.claim);
    assert.equal(
      await stores.receipts.completeWithoutSequence(
        installationScoped.key,
        installationClaim.claim,
        "2026-09-10T12:00:30.000Z",
      ),
      true,
    );
  },
);

test("sequenced rejection and cursor advancement are atomic and cannot skip known predecessors", { skip }, async () => {
  const scope = { ...chats[0], lineId: "line-ordered" };
  const first = receipt(0, "ordered-201", "201", scope.lineId);
  const second = receipt(0, "ordered-202", "202", scope.lineId);
  assert.equal(await stores.receipts.capture(first), "captured");
  assert.equal(await stores.receipts.capture(second), "captured");
  const secondClaimed = await stores.receipts.claim(
    second.key,
    "worker-second",
    "2026-09-10T12:00:00.000Z",
    "2026-09-10T12:05:00.000Z",
  );
  assert.ok(secondClaimed?.claim);
  assert.equal(
    await stores.receipts.rejectAndAdvanceContiguousCheckpoint(
      second.key as typeof second.key & { lineId: string },
      0,
      "202",
      secondClaimed.claim,
      "2026-09-10T12:01:00.000Z",
      "invalid-event",
    ),
    false,
  );
  assert.equal(await stores.receipts.readContiguousCheckpoint(scope), undefined);
  assert.equal((await stores.receipts.read(second.key))?.state, "processing");

  const firstClaimed = await stores.receipts.claim(
    first.key,
    "worker-first",
    "2026-09-10T12:00:00.000Z",
    "2026-09-10T12:05:00.000Z",
  );
  assert.ok(firstClaimed?.claim);
  assert.equal(
    await stores.receipts.rejectAndAdvanceContiguousCheckpoint(
      first.key as typeof first.key & { lineId: string },
      0,
      "201",
      firstClaimed.claim,
      "2026-09-10T12:01:00.000Z",
      "invalid-event",
    ),
    true,
  );
  assert.deepEqual(await stores.receipts.readContiguousCheckpoint(scope), {
    scope: { provider: scope.provider, installationId: scope.installationId, lineId: scope.lineId },
    sequence: "201",
    version: 1,
  });
  assert.equal(
    await stores.receipts.rejectAndAdvanceContiguousCheckpoint(
      second.key as typeof second.key & { lineId: string },
      1,
      "202",
      secondClaimed.claim,
      "2026-09-10T12:01:00.000Z",
      "invalid-event",
    ),
    true,
  );
  assert.equal((await stores.receipts.readContiguousCheckpoint(scope))?.sequence, "202");

  const unsequenced = receipt(0, "unsequenced", undefined, scope.lineId);
  assert.equal(await stores.receipts.capture(unsequenced), "captured");
  const unsequencedClaim = await stores.receipts.claim(
    unsequenced.key,
    "worker-unsequenced",
    "2026-09-10T12:00:00.000Z",
    "2026-09-10T12:05:00.000Z",
  );
  assert.ok(unsequencedClaim?.claim);
  assert.equal(
    await stores.receipts.advanceContiguousCheckpoint(
      unsequenced.key as typeof unsequenced.key & { lineId: string },
      2,
      "203",
      unsequencedClaim.claim,
      "2026-09-10T12:01:00.000Z",
    ),
    false,
  );
  assert.equal(
    await stores.receipts.completeWithoutSequence(unsequenced.key, unsequencedClaim.claim, "2026-09-10T12:01:00.000Z"),
    true,
  );
});

test("multipart retry retains exact confirmed children and dispatches only unresolved indexes", { skip }, async () => {
  const original = multipartOperation("multipart-original");
  assert.equal(await stores.deliveries.reserve(original), "reserved");
  assert.equal(
    await stores.deliveries.reserve({ ...original, idempotencyKey: "logical-attempt-collision" }),
    "conflict",
  );
  assert.equal(
    await stores.deliveries.markDispatched(
      { ...original, operationId: "operation-swapped", attemptId: "attempt-swapped" },
      1,
    ),
    undefined,
  );
  const dispatched = await stores.deliveries.markDispatched(original, 1);
  assert.equal(dispatched?.dispatchFence, 1);
  const retained = providerPart("provider-part-1", 1);
  const failure: Extract<PhotonOperationOutcome, { kind: "failed" }> = {
    kind: "failed",
    operation: operationReference(original),
    code: "timeout",
    retryable: true,
    confirmedParts: [retained],
  };
  assert.equal(await stores.deliveries.complete(original, dispatched!.dispatchFence, failure), true);

  const retry: typeof original = {
    ...original,
    operationId: "operation-multipart-retry",
    attemptId: "attempt-multipart-retry",
  };
  const reserved = await stores.deliveries.retry(retry, 3);
  assert.deepEqual(
    reserved?.parts.filter((part) => part.state === "confirmed").map((part) => part.providerPart?.messageId),
    ["provider-part-1"],
  );
  const redispatched = await stores.deliveries.markDispatched(retry, reserved!.version);
  assert.deepEqual(
    redispatched?.parts.filter((part) => part.state === "dispatched").map((part) => part.partIndex),
    [0, 2],
  );

  const message = {
    conversation: chats[0],
    messageId: "provider-parent",
    parts: [
      { messageId: "provider-part-0", partIndex: 0 },
      { messageId: "provider-part-1", partIndex: 0 },
      { messageId: "provider-part-2", partIndex: 0 },
    ],
  };
  const contradictory: Extract<PhotonOperationOutcome, { kind: "confirmed-message" }> = {
    kind: "confirmed-message",
    operation: operationReference(retry),
    message,
    confirmedParts: [
      providerPart("provider-part-0", 0),
      providerPart("provider-part-changed", 1),
      providerPart("provider-part-2", 2),
    ],
  };
  const beforeContradiction = await stores.deliveries.read(retry);
  assert.equal(await stores.deliveries.complete(retry, redispatched!.dispatchFence, contradictory), false);
  assert.deepEqual(await stores.deliveries.read(retry), beforeContradiction);

  const confirmed: Extract<PhotonOperationOutcome, { kind: "confirmed-message" }> = {
    ...contradictory,
    confirmedParts: [providerPart("provider-part-0", 0), retained, providerPart("provider-part-2", 2)],
  };
  assert.equal(await stores.deliveries.complete(retry, redispatched!.dispatchFence, confirmed), true);
  assert.deepEqual(
    (await stores.deliveries.read(retry))?.parts.map((part) => part.providerPart?.messageId),
    ["provider-part-0", "provider-part-1", "provider-part-2"],
  );
});

test("ambiguous delivery remains reconciliation-only and survives a replacement store", { skip }, async () => {
  const operation = textOperation(0, {
    operationId: "operation-ambiguous",
    attemptId: "attempt-ambiguous",
    idempotencyKey: "logical-ambiguous",
  });
  assert.equal(await stores.deliveries.reserve(operation), "reserved");
  const dispatched = await stores.deliveries.markDispatched(operation, 1);
  const outcome: Extract<PhotonOperationOutcome, { kind: "ambiguous" }> = {
    kind: "ambiguous",
    operation: operationReference(operation),
    reconciliationKey: "reconcile-ambiguous",
    confirmedParts: [],
  };
  assert.equal(await stores.deliveries.complete(operation, dispatched!.dispatchFence, outcome), true);
  assert.equal(
    await stores.deliveries.retry({ ...operation, operationId: "blind-retry", attemptId: "blind-retry" }, 3),
    undefined,
  );

  const replacementPool = new pg.Pool({ connectionString: databaseUrl! });
  try {
    const replacement = createPostgresPhotonStateStores(database(replacementPool));
    assert.equal((await replacement.deliveries.read(operation))?.state, "ambiguous");
    assert.equal(
      await replacement.deliveries.reconcile(
        {
          operation: operationReference(operation),
          observedAt: "2026-09-10T12:10:00.000Z",
          source: "provider-read",
          outcome: {
            kind: "failed",
            operation: operationReference(operation),
            code: "not-found",
            retryable: false,
            confirmedParts: [],
          },
        },
        3,
      ),
      true,
    );
    assert.equal((await replacement.deliveries.read(operation))?.state, "failed");
  } finally {
    await replacementPool.end();
  }
});

test(
  "all remaining state families enforce CAS, expiry, one-time use, restart, and tenant scope",
  { skip },
  async () => {
    const installation = {
      installation: { installationId: "installation-record", projectId: "project-record" },
      status: {
        state: "connected" as const,
        installationId: "installation-record",
        projectId: "project-record",
        lines: [{ lineId: "line-record", maskedAddress: "+1•••0010" }],
        runtime: { credentialCiphertext: "ciphertext" },
      },
      ownerRevision: "owner-1",
      version: 1,
    };
    assert.equal(await stores.installations.create(installation), true);
    assert.equal(
      await stores.installations.compareAndSet("installation-record", 0, { ...installation, version: 2 }),
      false,
    );
    assert.equal(
      await stores.installations.compareAndSet("installation-record", 1, {
        ...installation,
        ownerRevision: "owner-2",
        version: 2,
      }),
      true,
    );
    await assert.rejects(
      stores.installations.create({
        ...installation,
        installation: { installationId: "plaintext-installation", projectId: "project-record" },
        status: {
          ...installation.status,
          installationId: "plaintext-installation",
          management: { accessToken: "plaintext" },
        },
      }),
      /unsupported fields/u,
    );

    const challenge = {
      challengeId: "challenge-a",
      installationId: "installation-record",
      addressCiphertext: "ciphertext-address",
      expiresAt: "2026-09-10T13:00:00.000Z",
      version: 1,
    };
    assert.equal(await stores.verifiedAddresses.create(challenge), "created");
    assert.equal(await stores.verifiedAddresses.verify(challenge.challengeId, 1, "2026-09-10T13:00:00.000Z"), false);
    assert.equal(await stores.verifiedAddresses.verify(challenge.challengeId, 1, "2026-09-10T12:30:00.000Z"), true);

    const binding = { conversation: chats[0], qmSessionId: "session-bind", resourceRevision: "revision-bind" };
    assert.equal(await stores.chatSessions.bind(binding), "bound");
    assert.equal(await stores.chatSessions.bind({ ...binding, conversation: chats[1] }), "bound");
    const messageBinding = {
      providerMessage: multipartMessages[0]!,
      qmSessionId: "session-bind",
      qmEntrySequence: 9,
      resourceRevision: "revision-bind",
    };
    assert.equal(await stores.messages.bind(messageBinding), "bound");
    const part: MessagePartReference = { ...chats[0], ...multipartMessages[0]!.parts[1]! };
    assert.equal((await stores.messages.findByProviderPart(part))?.qmEntrySequence, 9);

    const attachment = normalizedInputs[0]!.content[1];
    assert.equal(attachment?.kind, "attachment");
    if (!attachment || attachment.kind !== "attachment") throw new Error("fixture attachment missing");
    const attachmentRecord = {
      reference: attachment.attachment,
      storageReference: "blob://durable-attachment",
      state: "available" as const,
    };
    assert.equal(await stores.attachments.put(attachmentRecord), "stored");
    assert.equal(await stores.attachments.release(attachment.attachment), true);
    assert.equal(await stores.attachments.release(attachment.attachment), false);

    const streamOperation: Extract<PhotonPresentationOperation, { name: "message.text.stream" }> = {
      operationId: "stream-operation",
      attemptId: "stream-attempt",
      name: "message.text.stream",
      conversation: chats[0],
      idempotencyKey: "stream-logical",
      input: { format: "plain" },
    };
    assert.equal(await stores.textStreams.create(streamOperation), "created");
    assert.equal(await stores.textStreams.append(streamOperation, 2, "wrong version"), undefined);
    const appended = await stores.textStreams.append(streamOperation, 1, "first chunk");
    assert.deepEqual(appended?.chunks, ["first chunk"]);
    assert.equal((await stores.textStreams.finalize(streamOperation, appended!.version))?.state, "finalized");

    const poll = { conversation: chats[0], pollMessageGuid: "poll-a", optionIdentifiers: ["yes", "no"], version: 1 };
    assert.equal(await stores.polls.put(poll), "stored");
    assert.equal(
      await stores.polls.replace({ ...poll, optionIdentifiers: ["yes", "no", "maybe"], version: 2 }, 1),
      true,
    );

    const card = {
      conversation: chats[0],
      cardId: "card-a",
      handle: {
        provider: "spectrum-imessage" as const,
        cardId: "card-a",
        target: { ...chats[0], messageId: "card-message" },
        session: {
          chatGuid: chats[0].conversationId,
          messageGuid: "card-message",
          sessionId: "card-session",
          targetMessageGuid: "card-message",
        },
        revision: "card-revision-1",
      },
      version: 1,
    };
    assert.equal(await stores.cards.put(card), "stored");
    assert.equal(
      await stores.cards.replace({ ...card, handle: { ...card.handle, revision: "card-revision-2" }, version: 2 }, 1),
      true,
    );
    assert.equal(
      await stores.cards.replace(
        {
          ...card,
          handle: { ...card.handle, session: { ...card.handle.session, sessionId: "replacement-session" } },
          version: 3,
        },
        2,
      ),
      false,
    );

    const action: ActionBinding = { ...competingActions[0], bindingId: "action-once" };
    assert.equal(await stores.actions.create(action), "created");
    const consumption = {
      bindingId: action.bindingId,
      actor: action.actor,
      resourceType: action.resource.resourceType,
      resourceId: action.resource.resourceId,
      resourceRevision: action.resourceRevision,
      allowedAction: action.allowedAction,
      sessionId: action.session.sessionId,
      conversation: action.conversation,
      now: "2026-09-10T12:30:00.000Z",
    };
    assert.equal((await stores.actions.consume(consumption))?.bindingId, action.bindingId);
    assert.equal(await stores.actions.consume(consumption), undefined);

    const replacementPool = new pg.Pool({ connectionString: databaseUrl! });
    try {
      const replacement = createPostgresPhotonStateStores(database(replacementPool));
      assert.equal((await replacement.installations.read("installation-record"))?.ownerRevision, "owner-2");
      assert.deepEqual((await replacement.textStreams.read(streamOperation))?.chunks, ["first chunk"]);
      assert.equal((await replacement.polls.read(chats[0], "poll-a"))?.version, 2);
      assert.equal((await replacement.chatSessions.find(chats[1]))?.qmSessionId, "session-bind");
    } finally {
      await replacementPool.end();
    }
  },
);
