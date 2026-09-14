import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import type { PoolClient } from "pg";

import type { PhotonDmBacklink } from "../src/delivery/delivery-store.ts";
import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { createPhotonDestination, type PhotonDestination } from "../src/surfaces/photon-destinations.ts";
import type { Destination } from "../src/types.ts";
import { cp1PostgresSkip, createCp1PostgresHarness, type Cp1PostgresHarness } from "./helpers/cp1-postgres.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = cp1PostgresSkip(
  "Photon delivery backlink PostgreSQL tests",
  databaseUrl,
  process.env.CP1_REQUIRE_POSTGRES === "1",
);
let harness: Cp1PostgresHarness | undefined;

const conversation = {
  provider: "spectrum-imessage" as const,
  installationId: "installation-1",
  projectId: "project-1",
  lineId: "line-1",
  maskedAddress: "+1******0100",
  conversationId: "any;-;+15555550101",
};

function photonDm(suffix: string): PhotonDestination {
  return createPhotonDestination({
    conversation: { ...conversation, conversationId: `${conversation.conversationId}-${suffix}` },
    kind: "dm",
    principalIds: ["alice"],
    audienceScopeId: "personal:alice",
    recipientPrincipalId: "alice",
  });
}

function photonGroup(): PhotonDestination {
  return createPhotonDestination({
    conversation: { ...conversation, conversationId: "any;+;group-1" },
    kind: "group",
    principalIds: ["alice", "bob"],
    audienceScopeId: "group:group-1",
    groupId: "group-1",
  });
}

function backlink(destination: PhotonDestination): PhotonDmBacklink {
  return {
    recipientPrincipalId: destination.recipientPrincipalId!,
    conversation: structuredClone(destination.conversation),
  };
}

const malformedPhoton = {
  type: "photon",
  target: conversation.conversationId,
  conversationKind: "dm",
  recipientPrincipalId: "alice",
} as Destination;

before(async () => {
  if (!databaseUrl) return;
  harness = await createCp1PostgresHarness(databaseUrl);
});

after(async () => {
  await harness?.close();
});

test("PostgreSQL stores the exact canonical Photon DM backlink durably and atomically", { skip }, async () => {
  const store = createPostgresDeliveryStore(harness!.connectionString);
  const destination = photonDm("canonical");
  const delivery = await store.enqueue({
    destination,
    text: "Photon DM",
    idempotencyKey: "r08-postgres-canonical",
  });

  const outcomes = await Promise.all([
    store.recordPhotonDmBacklink(delivery.id, backlink(destination)),
    store.recordPhotonDmBacklink(delivery.id, backlink(destination)),
  ]);
  assert.deepEqual(outcomes.sort(), ["duplicate", "recorded"]);

  const restarted = createPostgresDeliveryStore(harness!.connectionString);
  assert.deepEqual(await restarted.photonDmBacklink(delivery.id), backlink(destination));
  assert.equal((await restarted.get(delivery.id))?.deliveredAt, null);
  const persisted = await harness!.pool.query<{ photon_dm_backlink: unknown }>(
    "SELECT photon_dm_backlink FROM deliveries WHERE id = $1",
    [delivery.id],
  );
  assert.deepEqual(persisted.rows[0]?.photon_dm_backlink, backlink(destination));
  const migration = await harness!.pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM qm_schema_migrations WHERE id = $1",
    ["delivery/store/0007-photon-dm-backlinks"],
  );
  assert.equal(migration.rows[0]?.count, "1");
});

test(
  "PostgreSQL rejects wrong recipients, noncanonical records, groups, malformed destinations, and Slack rows",
  { skip },
  async () => {
    const store = createPostgresDeliveryStore(harness!.connectionString);
    const destination = photonDm("reject");
    const delivery = await store.enqueue({
      destination,
      text: "Photon DM",
      idempotencyKey: "r08-postgres-reject",
    });
    const group = await store.enqueue({
      destination: photonGroup(),
      text: "Photon group",
      idempotencyKey: "r08-postgres-group",
    });
    const malformed = await store.enqueue({
      destination: malformedPhoton,
      text: "malformed Photon",
      idempotencyKey: "r08-postgres-malformed",
    });
    const principal = await store.enqueue({
      destination: { type: "principal", target: "alice" },
      text: "Slack DM",
      idempotencyKey: "r08-postgres-principal",
    });

    assert.equal(
      await store.recordPhotonDmBacklink(delivery.id, {
        ...backlink(destination),
        recipientPrincipalId: "bob",
      }),
      "conflict",
    );
    assert.equal(
      await store.recordPhotonDmBacklink(delivery.id, {
        ...backlink(destination),
        conversation: { ...destination.conversation, conversationId: "another-conversation" },
      }),
      "conflict",
    );
    assert.equal(
      await store.recordPhotonDmBacklink(delivery.id, { ...backlink(destination), extra: true } as PhotonDmBacklink),
      "conflict",
    );
    assert.equal(await store.recordPhotonDmBacklink(group.id, backlink(destination)), "conflict");
    assert.equal(await store.recordPhotonDmBacklink(malformed.id, backlink(destination)), "conflict");
    assert.equal(await store.recordPhotonDmBacklink(principal.id, backlink(destination)), "conflict");
    assert.equal(await store.recordPhotonDmBacklink("absent", backlink(destination)), "conflict");

    await store.recordRecipientThread(delivery.id, "dm:D-alice", 1_000);
    assert.equal((await store.get(delivery.id))?.deliveredAt, null);
    assert.deepEqual(await store.listByRecipientThread("dm:D-alice"), []);
    await store.recordRecipientThread(principal.id, "dm:D-alice", 2_000);
    assert.equal((await store.get(principal.id))?.deliveredAt, 2_000);
    assert.deepEqual(
      (await store.listByRecipientThread("dm:D-alice")).map((row) => row.id),
      [principal.id],
    );
  },
);

test("PostgreSQL fails closed when destination authority changes before record or read", { skip }, async () => {
  const store = createPostgresDeliveryStore(harness!.connectionString);
  const destination = photonDm("race");
  const delivery = await store.enqueue({
    destination,
    text: "destination race",
    idempotencyKey: "r08-postgres-race",
  });
  let blocker: PoolClient | undefined;
  try {
    blocker = await harness!.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM deliveries WHERE id = $1 FOR UPDATE", [delivery.id]);
    const blockerPid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const recording = store.recordPhotonDmBacklink(delivery.id, backlink(destination));

    let waiting = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const active = await harness!.pool.query<{ waiting: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND $1 = ANY(pg_blocking_pids(pid))
              AND query LIKE '%photon_dm_backlink%'
         ) AS waiting`,
        [blockerPid],
      );
      waiting = active.rows[0]?.waiting === true;
      if (waiting) break;
      await delay(10);
    }
    assert.equal(waiting, true);

    await blocker.query("UPDATE deliveries SET destination = $2 WHERE id = $1", [
      delivery.id,
      JSON.stringify(photonGroup()),
    ]);
    await blocker.query("COMMIT");
    assert.equal(await recording, "conflict");
    assert.equal(await store.photonDmBacklink(delivery.id), undefined);
  } finally {
    if (blocker) {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  }

  const storedDestination = photonDm("read-mutation");
  const stored = await store.enqueue({
    destination: storedDestination,
    text: "read mutation",
    idempotencyKey: "r08-postgres-read-mutation",
  });
  assert.equal(await store.recordPhotonDmBacklink(stored.id, backlink(storedDestination)), "recorded");
  await harness!.pool.query("UPDATE deliveries SET destination = $2 WHERE id = $1", [
    stored.id,
    JSON.stringify(photonGroup()),
  ]);
  assert.equal(await store.photonDmBacklink(stored.id), undefined);
});
