import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";

import { createPhotonReceiptStore } from "../plugins/chassis/src/photon-state/receipts.ts";
import { PHOTON_STATE_MIGRATION, PHOTON_STATE_SCHEMA } from "../plugins/chassis/src/photon-state-schema.ts";
import type { NormalizedPhotonInput } from "../plugins/chassis/src/photon-contract.ts";
import type { CapturedEventReceipt } from "../plugins/photon/src/ports.ts";
import { createPhotonStateDatabase, type PhotonStatePool } from "../plugins/photon/src/state.ts";
import { normalizedInputs } from "../plugins/photon/test/fixtures.ts";
import { applyPgMigrations, definePgMigration } from "../src/persistence/pg-pool.ts";
import { cp1PostgresSkip, createCp1PostgresHarness, type Cp1PostgresHarness } from "./helpers/cp1-postgres.ts";

const databaseUrl = process.env.CP1_POSTGRES_ADMIN_URL;
const skip = cp1PostgresSkip(
  "Photon receipt recovery PostgreSQL tests",
  databaseUrl,
  process.env.CP1_REQUIRE_POSTGRES === "1",
);
let harness: Cp1PostgresHarness | undefined;
let pool: pg.Pool | undefined;

function database(value: pg.Pool) {
  return createPhotonStateDatabase(value as unknown as PhotonStatePool);
}

function receipt(
  eventId: string,
  capturedAt: string,
  lineId = "recovery-line",
  sequence?: string,
): CapturedEventReceipt {
  const source = normalizedInputs[0]!;
  const { sequence: _sourceSequence, ...sourceEvent } = source.event;
  const envelope: NormalizedPhotonInput = {
    ...source,
    event: { ...sourceEvent, eventId, lineId, ...(sequence === undefined ? {} : { sequence }) },
    conversation: { ...source.conversation, lineId },
    message: { ...source.message, conversation: { ...source.message.conversation, lineId } },
    content: source.content.map((item) =>
      item.kind === "attachment" ? { ...item, attachment: { ...item.attachment, lineId } } : item,
    ),
    ...(source.replyTo === undefined ? {} : { replyTo: { ...source.replyTo, lineId } }),
  };
  return {
    key: {
      provider: envelope.event.provider,
      installationId: envelope.event.installationId,
      lineId,
      eventId,
    },
    ...(sequence === undefined ? {} : { sequence }),
    capturedAt,
    payload: { kind: "envelope", envelope },
    state: "captured",
  };
}

before(async () => {
  if (!databaseUrl) return;
  harness = await createCp1PostgresHarness(databaseUrl);
  pool = harness.pool;
  await harness.withClusterLock(() =>
    applyPgMigrations(pool!, [definePgMigration(PHOTON_STATE_MIGRATION.id, PHOTON_STATE_MIGRATION.statements)]),
  );
});

after(async () => {
  await harness?.close();
});

test("discovers recoverable receipts with scoped bounded keyset pages after replacement", { skip }, async () => {
  const store = createPhotonReceiptStore(database(pool!));
  const scope = {
    provider: normalizedInputs[0]!.event.provider,
    installationId: normalizedInputs[0]!.event.installationId,
    lineId: "recovery-line",
  };
  const now = "2026-09-10T12:10:00.000Z";
  const ordered = [
    receipt("page-b", "2026-09-10T12:00:00.000Z"),
    receipt("page-a", "2026-09-10T12:00:00.000Z"),
    receipt("page-c", "2026-09-10T12:01:00.000Z"),
  ];
  for (const candidate of [ordered[2]!, ordered[0]!, ordered[1]!]) {
    assert.equal(await store.capture(candidate), "captured");
  }

  const first = await store.discoverRecoverable({ ...scope, now, limit: 2 });
  assert.deepEqual(
    first.receipts.map((candidate) => candidate.key.eventId),
    ["page-a", "page-b"],
  );
  assert.deepEqual(first.next, { capturedAt: "2026-09-10T12:00:00.000Z", eventId: "page-b" });

  const behind = receipt("page-behind", "2026-09-10T11:59:00.000Z");
  assert.equal(await store.capture(behind), "captured");
  const second = await store.discoverRecoverable({ ...scope, now, limit: 2, after: first.next });
  assert.deepEqual(
    second.receipts.map((candidate) => candidate.key.eventId),
    ["page-c"],
  );
  assert.equal(second.next, undefined);

  const replacementPool = new pg.Pool({ connectionString: harness!.connectionString });
  try {
    const replacement = createPhotonReceiptStore(database(replacementPool));
    const restarted = await replacement.discoverRecoverable({ ...scope, now, limit: 1 });
    assert.equal(restarted.receipts[0]?.key.eventId, "page-behind");
    assert.equal(await replacement.readContiguousCheckpoint(scope), undefined);
  } finally {
    await replacementPool.end();
  }
});

test("filters claims and terminal rows while preserving line-less and line isolation", { skip }, async () => {
  const store = createPhotonReceiptStore(database(pool!));
  const recoveryLine = "filters-line";
  const base = {
    provider: normalizedInputs[0]!.event.provider,
    installationId: normalizedInputs[0]!.event.installationId,
  };
  const now = "2026-09-10T12:10:00.000Z";
  const expired = receipt("claim-expired", "2026-09-10T12:02:00.000Z", recoveryLine);
  const live = receipt("claim-live", "2026-09-10T12:03:00.000Z", recoveryLine);
  const terminal = receipt("claim-terminal", "2026-09-10T12:04:00.000Z", recoveryLine);
  const legacy = receipt("claim-legacy", "2026-09-10T12:05:00.000Z", recoveryLine);
  for (const candidate of [expired, live, terminal, legacy]) assert.equal(await store.capture(candidate), "captured");
  assert.ok(await store.claim(expired.key, "expired", "2026-09-10T12:00:00.000Z", "2026-09-10T12:05:00.000Z"));
  assert.ok(await store.claim(live.key, "live", "2026-09-10T12:00:00.000Z", "2026-09-10T12:20:00.000Z"));
  const terminalClaim = await store.claim(
    terminal.key,
    "terminal",
    "2026-09-10T12:00:00.000Z",
    "2026-09-10T12:20:00.000Z",
  );
  assert.ok(terminalClaim?.claim);
  assert.equal(await store.completeWithoutSequence(terminal.key, terminalClaim.claim, now), true);
  assert.ok(await store.claim(legacy.key, "legacy", "2026-09-10T12:00:00.000Z", "2026-09-10T12:05:00.000Z"));
  await pool!.query(
    `UPDATE ${PHOTON_STATE_SCHEMA}.event_receipts
        SET claim_expires_at = NULL
      WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND event_id = $4`,
    [base.provider, base.installationId, legacy.key.lineId, legacy.key.eventId],
  );

  const otherLine = receipt("claim-expired", "2026-09-10T12:02:00.000Z", "other-line");
  assert.equal(await store.capture(otherLine), "captured");
  const linePage = await store.discoverRecoverable({ ...base, lineId: recoveryLine, now, limit: 128 });
  assert.deepEqual(
    linePage.receipts.map((candidate) => candidate.key.eventId),
    ["claim-expired"],
  );

  const lineLess: CapturedEventReceipt = {
    key: { ...base, eventId: "line-less" },
    capturedAt: "2026-09-10T12:06:00.000Z",
    payload: { kind: "reference", reference: "blob://line-less", payloadSha256: "a".repeat(64) },
    state: "captured",
  };
  assert.equal(await store.capture(lineLess), "captured");
  assert.deepEqual(
    (await store.discoverRecoverable({ ...base, now, limit: 128 })).receipts.map((candidate) => candidate.key.eventId),
    ["line-less"],
  );
  assert.equal(
    (await store.discoverRecoverable({ ...base, lineId: "other-line", now, limit: 128 })).receipts[0]?.key.eventId,
    "claim-expired",
  );
});

test("validates canonical recovery bounds and cursors", { skip }, async () => {
  const store = createPhotonReceiptStore(database(pool!));
  const query = {
    provider: normalizedInputs[0]!.event.provider,
    installationId: normalizedInputs[0]!.event.installationId,
    lineId: "recovery-line",
    now: "2026-09-10T12:10:00.000Z",
  };
  await assert.rejects(store.discoverRecoverable({ ...query, limit: 0 }), /limit/u);
  await assert.rejects(
    store.discoverRecoverable({
      ...query,
      limit: 1,
      after: { capturedAt: "2026-09-10", eventId: "page-a" },
    }),
    /canonical ISO timestamp/u,
  );
});
