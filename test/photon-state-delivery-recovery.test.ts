import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";

import { createPostgresPhotonStateStores, type PhotonStateStores } from "../plugins/chassis/src/photon-state.ts";
import { PHOTON_STATE_MIGRATION, PHOTON_STATE_SCHEMA } from "../plugins/chassis/src/photon-state-schema.ts";
import type {
  MessagePartReference,
  PhotonOperationOutcome,
  PhotonPresentationOperation,
} from "../plugins/chassis/src/photon-contract.ts";
import type { DeliveryOperationRecord } from "../plugins/photon/src/ports.ts";
import { createPhotonStateDatabase, type PhotonStatePool } from "../plugins/photon/src/state.ts";
import { chats, operationReference, textOperation } from "../plugins/photon/test/fixtures.ts";
import { applyPgMigrations, definePgMigration, PG_MIGRATIONS_TABLE } from "../src/persistence/pg-pool.ts";
import { cp1PostgresSkip, createCp1PostgresHarness, type Cp1PostgresHarness } from "./helpers/cp1-postgres.ts";

interface DeliveryDispatchClaim {
  ownerId: string;
  fence: number;
  leaseExpiresAt: string;
}

interface DeliveryRecoveryCursor {
  updatedAt: string;
  conversationId: string;
  idempotencyKey: string;
}

interface DeliveryRecoveryPage {
  deliveries: readonly DeliveryOperationRecord[];
  next?: DeliveryRecoveryCursor;
}

interface DeliveryRecoveryQuery {
  provider: string;
  installationId: string;
  lineId: string;
  now: string;
  limit: number;
  after?: DeliveryRecoveryCursor;
}

interface DeliveryStore {
  reserve(operation: PhotonPresentationOperation): Promise<"reserved" | "duplicate" | "conflict">;
  retry(operation: PhotonPresentationOperation, expectedVersion: number): Promise<DeliveryOperationRecord | undefined>;
  reconcile(evidence: unknown, expectedVersion: number): Promise<boolean>;
  read(operation: PhotonPresentationOperation): Promise<DeliveryOperationRecord | undefined>;
  acquireDispatch(
    operation: PhotonPresentationOperation,
    expectedVersion: number,
    ownerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<DeliveryOperationRecord | undefined>;
  renewDispatch(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    now: string,
    leaseExpiresAt: string,
  ): Promise<DeliveryOperationRecord | undefined>;
  expireDispatch(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    now: string,
  ): Promise<DeliveryOperationRecord | undefined>;
  recordConfirmedPart(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    logicalPartIndex: number,
    part: MessagePartReference,
    now: string,
  ): Promise<DeliveryOperationRecord | undefined>;
  complete(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    outcome: PhotonOperationOutcome,
    now: string,
  ): Promise<boolean>;
  discoverRecoverable(query: DeliveryRecoveryQuery): Promise<DeliveryRecoveryPage>;
}

const databaseUrl = process.env.CP1_POSTGRES_ADMIN_URL;
const skip = cp1PostgresSkip(
  "Photon delivery recovery PostgreSQL tests",
  databaseUrl,
  process.env.CP1_REQUIRE_POSTGRES === "1",
);
const leaseMigration = definePgMigration("photon/state/0002", [
  `ALTER TABLE ${PHOTON_STATE_SCHEMA}.delivery_operations
     ADD COLUMN IF NOT EXISTS dispatch_owner_id TEXT`,
  `ALTER TABLE ${PHOTON_STATE_SCHEMA}.delivery_operations
     ADD COLUMN IF NOT EXISTS dispatch_lease_expires_at TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS delivery_operations_dispatch_lease_expiry
     ON ${PHOTON_STATE_SCHEMA}.delivery_operations(
       provider, installation_id, line_id, dispatch_lease_expires_at, updated_at, conversation_id, idempotency_key
     )
     WHERE state = 'dispatched' AND dispatch_lease_expires_at IS NOT NULL`,
]);

let harness: Cp1PostgresHarness | undefined;
let admin: pg.Pool | undefined;
const extraPools: pg.Pool[] = [];

function database(pool: pg.Pool) {
  return createPhotonStateDatabase(pool as unknown as PhotonStatePool);
}

function deliveryStore(value: PhotonStateStores): DeliveryStore {
  return value.deliveries as unknown as DeliveryStore;
}

function openPool(): pg.Pool {
  const pool = new pg.Pool({ connectionString: harness!.connectionString });
  extraPools.push(pool);
  return pool;
}

async function closePool(pool: pg.Pool): Promise<void> {
  const index = extraPools.indexOf(pool);
  if (index >= 0) extraPools.splice(index, 1);
  await pool.end();
}

function values(operation: PhotonPresentationOperation): string[] {
  return [
    operation.conversation.provider,
    operation.conversation.installationId,
    operation.conversation.lineId,
    operation.conversation.conversationId,
    operation.idempotencyKey,
  ];
}

function multipartOperation(
  suffix: string,
  conversation: PhotonPresentationOperation["conversation"] = chats[0],
): Extract<PhotonPresentationOperation, { name: "message.multipart" }> {
  return {
    operationId: `operation-${suffix}`,
    attemptId: `attempt-${suffix}`,
    name: "message.multipart",
    conversation,
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

function providerPart(
  operation: PhotonPresentationOperation,
  logicalPartIndex: number,
  messageId: string,
): MessagePartReference {
  return { ...operation.conversation, messageId, partIndex: logicalPartIndex };
}

function confirmedMessageOutcome(
  operation: PhotonPresentationOperation,
  parts: readonly MessagePartReference[],
  messageId: string,
): Extract<PhotonOperationOutcome, { kind: "confirmed-message" }> {
  return {
    kind: "confirmed-message",
    operation: operationReference(operation),
    message: {
      conversation: operation.conversation,
      messageId,
      parts: parts.map(({ messageId: partMessageId, partIndex }) => ({ messageId: partMessageId, partIndex })),
    },
    confirmedParts: parts.map((part, logicalPartIndex) => ({ logicalPartIndex, part })),
  };
}

async function setUpdatedAt(operation: PhotonPresentationOperation, updatedAt: string): Promise<void> {
  await admin!.query(
    `UPDATE ${PHOTON_STATE_SCHEMA}.delivery_operations
        SET updated_at = $6::timestamptz
      WHERE provider = $1 AND installation_id = $2 AND line_id = $3
        AND conversation_id = $4 AND idempotency_key = $5`,
    [...values(operation), updatedAt],
  );
}

async function seedExpired(
  store: DeliveryStore,
  operation: PhotonPresentationOperation,
  ownerId: string,
  updatedAt: string,
): Promise<{ record: DeliveryOperationRecord; claim: DeliveryDispatchClaim }> {
  assert.equal(await store.reserve(operation), "reserved");
  const record = await store.acquireDispatch(
    operation,
    1,
    ownerId,
    "2026-09-14T11:00:00.000Z",
    "2026-09-14T11:01:00.000Z",
  );
  assert.ok(record);
  await setUpdatedAt(operation, updatedAt);
  return {
    record,
    claim: { ownerId, fence: record.dispatchFence, leaseExpiresAt: "2026-09-14T11:01:00.000Z" },
  };
}

before(async () => {
  if (!databaseUrl) return;
  harness = await createCp1PostgresHarness(databaseUrl);
  admin = harness.pool;
  await harness.withClusterLock(() =>
    applyPgMigrations(admin!, [
      definePgMigration(PHOTON_STATE_MIGRATION.id, PHOTON_STATE_MIGRATION.statements),
      leaseMigration,
    ]),
  );
});

after(async () => {
  while (extraPools.length > 0) await closePool(extraPools[0]!);
  await harness?.close();
});

test("lease migration is appended after immutable state migration and replays safely", { skip }, async () => {
  await applyPgMigrations(admin!, [
    definePgMigration(PHOTON_STATE_MIGRATION.id, PHOTON_STATE_MIGRATION.statements),
    leaseMigration,
  ]);
  const migrations = await admin!.query<{ id: string; checksum: string }>(
    `SELECT id, checksum FROM ${PG_MIGRATIONS_TABLE} WHERE id = ANY($1::text[]) ORDER BY id`,
    [[PHOTON_STATE_MIGRATION.id, leaseMigration.id]],
  );
  assert.deepEqual(
    migrations.rows,
    [
      { id: leaseMigration.id, checksum: leaseMigration.checksum },
      {
        id: PHOTON_STATE_MIGRATION.id,
        checksum: definePgMigration(PHOTON_STATE_MIGRATION.id, PHOTON_STATE_MIGRATION.statements).checksum,
      },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  );
  const columns = await admin!.query<{ column_name: string; is_nullable: string }>(
    `SELECT column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'delivery_operations'
        AND column_name = ANY($2::text[])
      ORDER BY column_name`,
    [PHOTON_STATE_SCHEMA, ["dispatch_owner_id", "dispatch_lease_expires_at"]],
  );
  assert.deepEqual(columns.rows, [
    { column_name: "dispatch_lease_expires_at", is_nullable: "YES" },
    { column_name: "dispatch_owner_id", is_nullable: "YES" },
  ]);
  const index = await admin!.query<{ indexdef: string }>(
    `SELECT indexdef
       FROM pg_indexes
      WHERE schemaname = $1 AND tablename = 'delivery_operations'
        AND indexname = 'delivery_operations_dispatch_lease_expiry'`,
    [PHOTON_STATE_SCHEMA],
  );
  assert.equal(index.rows.length, 1);
  assert.match(index.rows[0]!.indexdef, /dispatch_lease_expires_at/u);
});

test("competing dispatchers acquire one durable fenced lease", { skip }, async () => {
  const operation = textOperation(0, {
    operationId: "operation-r04-acquire",
    attemptId: "attempt-r04-acquire",
    idempotencyKey: "logical-r04-acquire",
  });
  const firstPool = openPool();
  const secondPool = openPool();
  try {
    const first = deliveryStore(createPostgresPhotonStateStores(database(firstPool)));
    const second = deliveryStore(createPostgresPhotonStateStores(database(secondPool)));
    assert.equal(await first.reserve(operation), "reserved");
    const [firstClaimed, secondClaimed] = await Promise.all([
      first.acquireDispatch(operation, 1, "worker-a", "2026-09-14T12:00:00.000Z", "2026-09-14T12:05:00.000Z"),
      second.acquireDispatch(operation, 1, "worker-b", "2026-09-14T12:00:00.000Z", "2026-09-14T12:05:00.000Z"),
    ]);
    assert.equal([firstClaimed, secondClaimed].filter(Boolean).length, 1);
    const winner = firstClaimed ?? secondClaimed;
    assert.ok(winner);
    assert.equal(winner.state, "dispatched");
    assert.equal(winner.dispatchFence, 1);
    assert.equal(winner.version, 2);
    const ownerId = firstClaimed === undefined ? "worker-b" : "worker-a";
    const row = await admin!.query<{
      dispatch_owner_id: string;
      dispatch_lease_expires_at: Date | string;
      state: string;
    }>(
      `SELECT dispatch_owner_id, dispatch_lease_expires_at, state
         FROM ${PHOTON_STATE_SCHEMA}.delivery_operations
        WHERE provider = $1 AND installation_id = $2 AND line_id = $3
          AND conversation_id = $4 AND idempotency_key = $5`,
      values(operation),
    );
    assert.deepEqual(
      row.rows.map((value) => ({
        ...value,
        dispatch_lease_expires_at:
          value.dispatch_lease_expires_at instanceof Date
            ? value.dispatch_lease_expires_at.toISOString()
            : new Date(value.dispatch_lease_expires_at).toISOString(),
      })),
      [{ dispatch_owner_id: ownerId, dispatch_lease_expires_at: "2026-09-14T12:05:00.000Z", state: "dispatched" }],
    );
    const stale = await (firstClaimed === undefined ? first : second).acquireDispatch(
      operation,
      1,
      "worker-c",
      "2026-09-14T12:00:00.000Z",
      "2026-09-14T12:06:00.000Z",
    );
    assert.equal(stale, undefined);
    const changedPayload = textOperation(0, {
      operationId: operation.operationId,
      attemptId: operation.attemptId,
      idempotencyKey: operation.idempotencyKey,
      input: { text: "changed" },
    });
    assert.equal(
      await (firstClaimed === undefined ? first : second).acquireDispatch(
        changedPayload,
        2,
        "worker-c",
        "2026-09-14T12:00:00.000Z",
        "2026-09-14T12:06:00.000Z",
      ),
      undefined,
    );
    assert.equal((await first.read(operation))?.version, 2);
    const isolated = textOperation(1, {
      operationId: "operation-r04-acquire-isolated",
      attemptId: "attempt-r04-acquire-isolated",
      idempotencyKey: "logical-r04-acquire",
    });
    assert.equal(await second.reserve(isolated), "reserved");
    const isolatedClaimed = await second.acquireDispatch(
      isolated,
      1,
      "worker-isolated",
      "2026-09-14T12:00:00.000Z",
      "2026-09-14T12:05:00.000Z",
    );
    assert.equal(isolatedClaimed?.dispatchFence, 1);
  } finally {
    await closePool(firstPool);
    await closePool(secondPool);
  }
});

test("renewal and expiry races reject stale claims and make completion fence-safe", { skip }, async () => {
  const operation = textOperation(0, {
    operationId: "operation-r04-renew",
    attemptId: "attempt-r04-renew",
    idempotencyKey: "logical-r04-renew",
  });
  const firstPool = openPool();
  const secondPool = openPool();
  try {
    const first = deliveryStore(createPostgresPhotonStateStores(database(firstPool)));
    const second = deliveryStore(createPostgresPhotonStateStores(database(secondPool)));
    assert.equal(await first.reserve(operation), "reserved");
    const acquired = await first.acquireDispatch(
      operation,
      1,
      "worker-renew",
      "2026-09-14T12:00:00.000Z",
      "2026-09-14T12:01:00.000Z",
    );
    assert.ok(acquired);
    const claim: DeliveryDispatchClaim = {
      ownerId: "worker-renew",
      fence: acquired.dispatchFence,
      leaseExpiresAt: "2026-09-14T12:01:00.000Z",
    };
    const renewed = await first.renewDispatch(operation, claim, "2026-09-14T12:00:30.000Z", "2026-09-14T12:01:30.000Z");
    assert.ok(renewed);
    assert.equal(renewed.dispatchFence, claim.fence);
    const renewedClaim: DeliveryDispatchClaim = { ...claim, leaseExpiresAt: "2026-09-14T12:01:30.000Z" };
    assert.equal(
      await second.renewDispatch(
        operation,
        { ...renewedClaim, ownerId: "worker-other" },
        "2026-09-14T12:00:45.000Z",
        "2026-09-14T12:02:00.000Z",
      ),
      undefined,
    );
    assert.equal(
      await second.renewDispatch(
        operation,
        { ...renewedClaim, fence: renewedClaim.fence - 1 },
        "2026-09-14T12:00:45.000Z",
        "2026-09-14T12:02:00.000Z",
      ),
      undefined,
    );
    assert.equal(
      await first.renewDispatch(operation, claim, "2026-09-14T12:00:45.000Z", "2026-09-14T12:02:00.000Z"),
      undefined,
    );
    assert.equal(
      await first.renewDispatch(operation, renewedClaim, "2030-01-01T00:00:00.000Z", "2030-01-01T00:05:00.000Z"),
      undefined,
    );

    const raceOperation = textOperation(0, {
      operationId: "operation-r04-renew-race",
      attemptId: "attempt-r04-renew-race",
      idempotencyKey: "logical-r04-renew-race",
    });
    assert.equal(await first.reserve(raceOperation), "reserved");
    const raceRecord = await first.acquireDispatch(
      raceOperation,
      1,
      "worker-race",
      "2026-09-14T12:00:00.000Z",
      "2026-09-14T12:01:00.000Z",
    );
    assert.ok(raceRecord);
    const raceClaim: DeliveryDispatchClaim = {
      ownerId: "worker-race",
      fence: raceRecord.dispatchFence,
      leaseExpiresAt: "2026-09-14T12:01:00.000Z",
    };
    const [raceRenewed, raceExpired] = await Promise.all([
      first.renewDispatch(raceOperation, raceClaim, "2026-09-14T12:00:30.000Z", "2026-09-14T12:02:00.000Z"),
      second.expireDispatch(raceOperation, raceClaim, "2026-09-14T12:01:30.000Z"),
    ]);
    assert.equal([raceRenewed, raceExpired].filter(Boolean).length, 1);
    const raceFinal = await first.read(raceOperation);
    assert.ok(raceFinal);
    assert.equal(raceFinal.state, raceRenewed === undefined ? "ambiguous" : "dispatched");

    const expiredOperation = textOperation(0, {
      operationId: "operation-r04-expired",
      attemptId: "attempt-r04-expired",
      idempotencyKey: "logical-r04-expired",
    });
    assert.equal(await first.reserve(expiredOperation), "reserved");
    const expiredRecord = await first.acquireDispatch(
      expiredOperation,
      1,
      "worker-expired",
      "2026-09-14T12:00:00.000Z",
      "2026-09-14T12:01:00.000Z",
    );
    assert.ok(expiredRecord);
    const expiredClaim: DeliveryDispatchClaim = {
      ownerId: "worker-expired",
      fence: expiredRecord.dispatchFence,
      leaseExpiresAt: "2026-09-14T12:01:00.000Z",
    };
    const expired = await second.expireDispatch(expiredOperation, expiredClaim, "2026-09-14T12:02:00.000Z");
    assert.ok(expired);
    assert.equal(expired.state, "ambiguous");
    const lateOutcome = confirmedMessageOutcome(
      expiredOperation,
      [providerPart(expiredOperation, 0, "provider-late")],
      "provider-late-parent",
    );
    const afterExpiry = await first.read(expiredOperation);
    assert.ok(afterExpiry);
    assert.equal(await first.complete(expiredOperation, expiredClaim, lateOutcome, "2026-09-14T12:03:00.000Z"), false);
    assert.deepEqual(await first.read(expiredOperation), afterExpiry);
    assert.equal(
      await first.recordConfirmedPart(
        expiredOperation,
        expiredClaim,
        0,
        providerPart(expiredOperation, 0, "provider-too-late"),
        "2026-09-14T12:03:00.000Z",
      ),
      undefined,
    );
    assert.equal(
      await first.retry(
        { ...expiredOperation, operationId: "operation-r04-expired-retry", attemptId: "attempt-r04-expired-retry" },
        afterExpiry.version,
      ),
      undefined,
    );
  } finally {
    await closePool(firstPool);
    await closePool(secondPool);
  }
});

test("completion requires the exact live claim, operation attempt, and payload", { skip }, async () => {
  const operation = textOperation(0, {
    operationId: "operation-r04-complete",
    attemptId: "attempt-r04-complete",
    idempotencyKey: "logical-r04-complete",
  });
  const store = deliveryStore(createPostgresPhotonStateStores(database(admin!)));
  assert.equal(await store.reserve(operation), "reserved");
  const acquired = await store.acquireDispatch(
    operation,
    1,
    "worker-complete",
    "2026-09-14T13:00:00.000Z",
    "2026-09-14T13:05:00.000Z",
  );
  assert.ok(acquired);
  const claim: DeliveryDispatchClaim = {
    ownerId: "worker-complete",
    fence: acquired.dispatchFence,
    leaseExpiresAt: "2026-09-14T13:05:00.000Z",
  };
  const part = providerPart(operation, 0, "provider-complete-part");
  const outcome = confirmedMessageOutcome(operation, [part], "provider-complete-parent");
  const forgedOutcome: typeof outcome = {
    ...outcome,
    confirmedParts: [{ logicalPartIndex: 0, part: { ...part, messageId: "provider-forged-part" } }],
  };
  assert.equal(await store.complete(operation, claim, forgedOutcome, "2026-09-14T13:01:00.000Z"), false);
  assert.equal(
    await store.complete(operation, { ...claim, ownerId: "worker-stale" }, outcome, "2026-09-14T13:01:00.000Z"),
    false,
  );
  assert.equal(
    await store.complete({ ...operation, attemptId: "attempt-r04-stale" }, claim, outcome, "2026-09-14T13:01:00.000Z"),
    false,
  );
  const changedPayload = textOperation(0, {
    operationId: operation.operationId,
    attemptId: operation.attemptId,
    idempotencyKey: operation.idempotencyKey,
    input: { text: "changed" },
  });
  assert.equal(await store.complete(changedPayload, claim, outcome, "2026-09-14T13:01:00.000Z"), false);
  assert.equal(await store.complete(operation, claim, outcome, "2026-09-14T13:01:00.000Z"), true);
  const completed = await store.read(operation);
  assert.equal(completed?.state, "confirmed");
  assert.deepEqual(completed?.parts[0]?.providerPart, part);
  const row = await admin!.query<{ dispatch_owner_id: string | null; dispatch_lease_expires_at: Date | null }>(
    `SELECT dispatch_owner_id, dispatch_lease_expires_at
       FROM ${PHOTON_STATE_SCHEMA}.delivery_operations
      WHERE provider = $1 AND installation_id = $2 AND line_id = $3
        AND conversation_id = $4 AND idempotency_key = $5`,
    [...values(operation)],
  );
  assert.deepEqual(row.rows, [{ dispatch_owner_id: null, dispatch_lease_expires_at: null }]);
});

test("expiry preserves committed multipart progress and makes unresolved parts ambiguous", { skip }, async () => {
  const operation = multipartOperation("r04-expiry-progress");
  const store = deliveryStore(createPostgresPhotonStateStores(database(admin!)));
  assert.equal(await store.reserve(operation), "reserved");
  const acquired = await store.acquireDispatch(
    operation,
    1,
    "worker-expiry-progress",
    "2026-09-14T13:10:00.000Z",
    "2026-09-14T13:11:00.000Z",
  );
  assert.ok(acquired);
  const claim: DeliveryDispatchClaim = {
    ownerId: "worker-expiry-progress",
    fence: acquired.dispatchFence,
    leaseExpiresAt: "2026-09-14T13:11:00.000Z",
  };
  const retained = providerPart(operation, 1, "provider-expiry-retained");
  assert.ok(await store.recordConfirmedPart(operation, claim, 1, retained, "2026-09-14T13:10:30.000Z"));
  const expired = await store.expireDispatch(operation, claim, "2026-09-14T13:11:00.000Z");
  assert.equal(expired?.state, "ambiguous");
  assert.deepEqual(
    expired?.parts.map((part) => ({ state: part.state, providerPart: part.providerPart })),
    [
      { state: "ambiguous", providerPart: undefined },
      { state: "confirmed", providerPart: retained },
      { state: "ambiguous", providerPart: undefined },
    ],
  );
});

test(
  "confirmed multipart parts persist before the next send and preserve exact identity across restart",
  { skip },
  async () => {
    const operation = multipartOperation("r04-progress");
    const writerPool = openPool();
    const replacementPool = openPool();
    try {
      const writer = deliveryStore(createPostgresPhotonStateStores(database(writerPool)));
      const replacement = deliveryStore(createPostgresPhotonStateStores(database(replacementPool)));
      assert.equal(await writer.reserve(operation), "reserved");
      const acquired = await writer.acquireDispatch(
        operation,
        1,
        "worker-progress",
        "2026-09-14T12:10:00.000Z",
        "2026-09-14T12:20:00.000Z",
      );
      assert.ok(acquired);
      const claim: DeliveryDispatchClaim = {
        ownerId: "worker-progress",
        fence: acquired.dispatchFence,
        leaseExpiresAt: "2026-09-14T12:20:00.000Z",
      };
      const retained = providerPart(operation, 1, "provider-progress-middle");
      const progress = await writer.recordConfirmedPart(operation, claim, 1, retained, "2026-09-14T12:10:30.000Z");
      assert.ok(progress);
      assert.equal(progress.version, acquired.version + 1);
      assert.equal(progress.parts[1]?.state, "confirmed");
      assert.deepEqual(progress.parts[1]?.providerPart, retained);
      assert.deepEqual(
        progress.parts.filter((part) => part.state === "dispatched").map((part) => part.partIndex),
        [0, 2],
      );
      const parent = await admin!.query<{ parts: unknown }>(
        `SELECT record->'value'->'parts' AS parts
         FROM ${PHOTON_STATE_SCHEMA}.delivery_operations
        WHERE provider = $1 AND installation_id = $2 AND line_id = $3
          AND conversation_id = $4 AND idempotency_key = $5`,
        values(operation),
      );
      const child = await admin!.query<{ state: string; dispatch_fence: string | number; provider_part: unknown }>(
        `SELECT state, dispatch_fence, provider_part
         FROM ${PHOTON_STATE_SCHEMA}.delivery_parts
        WHERE provider = $1 AND installation_id = $2 AND line_id = $3
          AND conversation_id = $4 AND idempotency_key = $5 AND part_index = 1`,
        values(operation),
      );
      assert.deepEqual((parent.rows[0]!.parts as { state: string; providerPart?: MessagePartReference }[])[1], {
        partId: progress.parts[1]!.partId,
        partIndex: 1,
        state: "confirmed",
        dispatchFence: claim.fence,
        providerPart: retained,
      });
      assert.deepEqual(
        child.rows.map((value) => ({ ...value, dispatch_fence: Number(value.dispatch_fence) })),
        [{ state: "confirmed", dispatch_fence: claim.fence, provider_part: retained }],
      );
      const duplicate = await writer.recordConfirmedPart(operation, claim, 1, retained, "2026-09-14T12:10:35.000Z");
      assert.ok(duplicate);
      assert.equal(duplicate.version, progress.version);
      const stable = await writer.read(operation);
      assert.ok(stable);
      assert.equal(
        await writer.recordConfirmedPart(
          operation,
          claim,
          1,
          providerPart(operation, 1, "provider-progress-conflict"),
          "2026-09-14T12:10:40.000Z",
        ),
        undefined,
      );
      assert.equal(
        await writer.recordConfirmedPart(operation, claim, 0, retained, "2026-09-14T12:10:40.000Z"),
        undefined,
      );
      const duplicateOutcome = confirmedMessageOutcome(operation, [retained, retained, retained], "provider-duplicate");
      assert.equal(await writer.complete(operation, claim, duplicateOutcome, "2026-09-14T12:10:40.000Z"), false);
      assert.equal(
        await writer.recordConfirmedPart(
          { ...operation, operationId: "operation-r04-progress-other", attemptId: "attempt-r04-progress-other" },
          claim,
          0,
          providerPart(operation, 0, "provider-progress-other-attempt"),
          "2026-09-14T12:10:40.000Z",
        ),
        undefined,
      );
      assert.equal(
        await writer.recordConfirmedPart(
          operation,
          claim,
          0,
          { ...chats[1], messageId: "provider-progress-foreign", partIndex: 0 },
          "2026-09-14T12:10:40.000Z",
        ),
        undefined,
      );
      assert.deepEqual(await writer.read(operation), stable);
      assert.deepEqual(await replacement.read(operation), stable);
    } finally {
      await closePool(writerPool);
      await closePool(replacementPool);
    }
  },
);

test(
  "multipart reads remain parent-child consistent during writes and reject stored child disagreement",
  { skip },
  async () => {
    const operation = multipartOperation("r04-consistency");
    const writerPool = openPool();
    const readerPool = openPool();
    try {
      const writer = deliveryStore(createPostgresPhotonStateStores(database(writerPool)));
      const reader = deliveryStore(createPostgresPhotonStateStores(database(readerPool)));
      assert.equal(await writer.reserve(operation), "reserved");
      const acquired = await writer.acquireDispatch(
        operation,
        1,
        "worker-consistency",
        "2026-09-14T12:30:00.000Z",
        "2026-09-14T12:40:00.000Z",
      );
      assert.ok(acquired);
      const claim: DeliveryDispatchClaim = {
        ownerId: "worker-consistency",
        fence: acquired.dispatchFence,
        leaseExpiresAt: "2026-09-14T12:40:00.000Z",
      };
      const [written, ...reads] = await Promise.all([
        writer.recordConfirmedPart(
          operation,
          claim,
          0,
          providerPart(operation, 0, "provider-consistency-first"),
          "2026-09-14T12:30:30.000Z",
        ),
        ...Array.from({ length: 80 }, () => reader.read(operation)),
      ]);
      assert.ok(written);
      assert.equal(reads.length, 80);
      for (const record of reads) {
        assert.ok(record);
        assert.equal(
          record.parts.filter((part) => part.state === "confirmed").length,
          record.parts[0]?.state === "confirmed" ? 1 : 0,
        );
      }
      const corruptOperation = multipartOperation("r04-corrupt");
      assert.equal(await writer.reserve(corruptOperation), "reserved");
      await writer.acquireDispatch(
        corruptOperation,
        1,
        "worker-corrupt",
        "2026-09-14T12:30:00.000Z",
        "2026-09-14T12:40:00.000Z",
      );
      await admin!.query(
        `UPDATE ${PHOTON_STATE_SCHEMA}.delivery_parts
          SET provider_part = $6::jsonb
        WHERE provider = $1 AND installation_id = $2 AND line_id = $3
          AND conversation_id = $4 AND idempotency_key = $5 AND part_index = 0`,
        [...values(corruptOperation), JSON.stringify(providerPart(corruptOperation, 0, "provider-corrupt"))],
      );
      await assert.rejects(() => reader.read(corruptOperation), /delivery operation and part rows disagree/u);
      const corruptParentOperation = multipartOperation("r04-parent-corrupt", {
        ...chats[0],
        lineId: "line-r04-parent-corrupt",
      });
      assert.equal(await writer.reserve(corruptParentOperation), "reserved");
      await admin!.query(
        `UPDATE ${PHOTON_STATE_SCHEMA}.delivery_operations
            SET record = jsonb_set(record, '{value,operation,conversation,conversationId}', '"foreign"'::jsonb)
          WHERE provider = $1 AND installation_id = $2 AND line_id = $3
            AND conversation_id = $4 AND idempotency_key = $5`,
        values(corruptParentOperation),
      );
      await assert.rejects(() => reader.read(corruptParentOperation), /delivery operation parent columns disagree/u);
    } finally {
      await closePool(writerPool);
      await closePool(readerPool);
    }
  },
);

test(
  "legacy null-lease dispatches become conservative ambiguity without accepting late completion",
  { skip },
  async () => {
    const operation = textOperation(0, {
      operationId: "operation-r04-legacy",
      attemptId: "attempt-r04-legacy",
      idempotencyKey: "logical-r04-legacy",
    });
    const pool = openPool();
    try {
      const store = deliveryStore(createPostgresPhotonStateStores(database(pool)));
      assert.equal(await store.reserve(operation), "reserved");
      await admin!.query(
        `UPDATE ${PHOTON_STATE_SCHEMA}.delivery_operations
          SET state = 'dispatched', dispatch_fence = 1, entity_version = 2,
              updated_at = $6::timestamptz,
              dispatch_owner_id = NULL, dispatch_lease_expires_at = NULL,
              record = jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(
                      jsonb_set(record, '{value,state}', '"dispatched"'::jsonb),
                      '{value,dispatchFence}', '1'::jsonb
                    ),
                    '{value,version}', '2'::jsonb
                  ),
                  '{value,parts,0,state}', '"dispatched"'::jsonb
                ),
                '{value,parts,0,dispatchFence}', '1'::jsonb
              )
        WHERE provider = $1 AND installation_id = $2 AND line_id = $3
          AND conversation_id = $4 AND idempotency_key = $5`,
        [...values(operation), "2026-09-14T11:00:00.000Z"],
      );
      await admin!.query(
        `UPDATE ${PHOTON_STATE_SCHEMA}.delivery_parts
          SET state = 'dispatched', dispatch_fence = 1
        WHERE provider = $1 AND installation_id = $2 AND line_id = $3
          AND conversation_id = $4 AND idempotency_key = $5`,
        values(operation),
      );
      const legacy = await store.read(operation);
      assert.equal(legacy?.state, "dispatched");
      const claim: DeliveryDispatchClaim = {
        ownerId: "legacy-recovery",
        fence: 1,
        leaseExpiresAt: "2026-09-14T11:01:00.000Z",
      };
      const expired = await store.expireDispatch(operation, claim, "2026-09-14T12:00:00.000Z");
      assert.equal(expired?.state, "ambiguous");
      const late = confirmedMessageOutcome(
        operation,
        [providerPart(operation, 0, "provider-legacy-late")],
        "provider-legacy-late-parent",
      );
      assert.equal(await store.complete(operation, claim, late, "2026-09-14T12:01:00.000Z"), false);
    } finally {
      await closePool(pool);
    }
  },
);

test("recovery discovery is bounded, stable, tenant-scoped, and restart-safe", { skip }, async () => {
  const pool = openPool();
  const replacementPool = openPool();
  try {
    const store = deliveryStore(createPostgresPhotonStateStores(database(pool)));
    const replacement = deliveryStore(createPostgresPhotonStateStores(database(replacementPool)));
    const firstOperation = textOperation(0, {
      operationId: "operation-r04-discovery-1",
      attemptId: "attempt-r04-discovery-1",
      idempotencyKey: "logical-r04-discovery-1",
    });
    const secondOperation = textOperation(0, {
      operationId: "operation-r04-discovery-2",
      attemptId: "attempt-r04-discovery-2",
      idempotencyKey: "logical-r04-discovery-2",
    });
    const thirdOperation = textOperation(0, {
      operationId: "operation-r04-discovery-3",
      attemptId: "attempt-r04-discovery-3",
      idempotencyKey: "logical-r04-discovery-3",
    });
    const foreignOperation = textOperation(1, {
      operationId: "operation-r04-discovery-foreign",
      attemptId: "attempt-r04-discovery-foreign",
      idempotencyKey: "logical-r04-discovery-foreign",
    });
    await seedExpired(store, firstOperation, "worker-discovery-1", "2026-09-14T11:00:00.000Z");
    await seedExpired(store, secondOperation, "worker-discovery-2", "2026-09-14T11:01:00.000Z");
    await seedExpired(store, thirdOperation, "worker-discovery-3", "2026-09-14T11:02:00.000Z");
    await seedExpired(store, foreignOperation, "worker-discovery-foreign", "2026-09-14T10:59:00.000Z");
    const query: DeliveryRecoveryQuery = {
      provider: chats[0].provider,
      installationId: chats[0].installationId,
      lineId: chats[0].lineId,
      now: "2026-09-14T12:00:00.000Z",
      limit: 2,
    };
    const firstPage = await replacement.discoverRecoverable(query);
    assert.deepEqual(
      firstPage.deliveries.map((record) => record.operation.idempotencyKey),
      [firstOperation.idempotencyKey, secondOperation.idempotencyKey],
    );
    assert.ok(firstPage.next);
    const secondPage = await replacement.discoverRecoverable({ ...query, after: firstPage.next });
    assert.deepEqual(
      secondPage.deliveries.map((record) => record.operation.idempotencyKey),
      [thirdOperation.idempotencyKey],
    );
    assert.equal(secondPage.next, undefined);
    assert.deepEqual(
      [...firstPage.deliveries, ...secondPage.deliveries].map((record) => record.operation.idempotencyKey),
      [firstOperation.idempotencyKey, secondOperation.idempotencyKey, thirdOperation.idempotencyKey],
    );
    for (const record of [...firstPage.deliveries, ...secondPage.deliveries]) {
      assert.deepEqual(await replacement.read(record.operation), record);
    }
    const behindCursor = textOperation(0, {
      operationId: "operation-r04-discovery-behind",
      attemptId: "attempt-r04-discovery-behind",
      idempotencyKey: "logical-r04-discovery-behind",
    });
    await seedExpired(store, behindCursor, "worker-discovery-behind", "2026-09-14T10:58:00.000Z");
    const freshSweep = await replacement.discoverRecoverable(query);
    assert.ok(freshSweep.deliveries.some((record) => record.operation.idempotencyKey === behindCursor.idempotencyKey));
    assert.equal(
      freshSweep.deliveries.some((record) => record.operation.idempotencyKey === foreignOperation.idempotencyKey),
      false,
    );
  } finally {
    await closePool(pool);
    await closePool(replacementPool);
  }
});

test("recovery pagination preserves ordering for database timestamps within one millisecond", { skip }, async () => {
  const conversation = {
    ...chats[0],
    lineId: "line-r04-cursor-precision",
    conversationId: "conversation-r04-cursor-precision",
  };
  const first = textOperation(0, {
    operationId: "operation-r04-cursor-a",
    attemptId: "attempt-r04-cursor-a",
    idempotencyKey: "logical-r04-cursor-a",
    conversation,
  });
  const second = textOperation(0, {
    operationId: "operation-r04-cursor-b",
    attemptId: "attempt-r04-cursor-b",
    idempotencyKey: "logical-r04-cursor-b",
    conversation,
  });
  const store = deliveryStore(createPostgresPhotonStateStores(database(admin!)));
  await seedExpired(store, first, "worker-r04-cursor-a", "2026-09-14T11:00:00.123456Z");
  await seedExpired(store, second, "worker-r04-cursor-b", "2026-09-14T11:00:00.123789Z");
  const query: DeliveryRecoveryQuery = {
    provider: conversation.provider,
    installationId: conversation.installationId,
    lineId: conversation.lineId,
    now: "2026-09-14T12:00:00.000Z",
    limit: 1,
  };
  const firstPage = await store.discoverRecoverable(query);
  assert.deepEqual(
    firstPage.deliveries.map((record) => record.operation.idempotencyKey),
    [first.idempotencyKey],
  );
  assert.equal(firstPage.next?.updatedAt, "2026-09-14T11:00:00.123Z");
  const secondPage = await store.discoverRecoverable({ ...query, after: firstPage.next });
  assert.deepEqual(
    secondPage.deliveries.map((record) => record.operation.idempotencyKey),
    [second.idempotencyKey],
  );
  assert.equal(secondPage.next, undefined);
});
