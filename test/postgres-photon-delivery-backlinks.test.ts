import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import type { PoolClient } from "pg";

import { createPostgresDeliveryStore } from "../src/delivery/postgres-delivery-store.ts";
import { createPhotonDestination, type PhotonDestination } from "../src/surfaces/photon-destinations.ts";
import type { Destination } from "../src/types.ts";
import { cp1PostgresSkip, createCp1PostgresHarness, type Cp1PostgresHarness } from "./helpers/cp1-postgres.ts";

const databaseUrl = process.env.CP1_POSTGRES_ADMIN_URL;
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

test(
  "PostgreSQL keeps principal and validated Photon DM recipient-thread behavior in parity across store recreation",
  { skip },
  async () => {
    const store = createPostgresDeliveryStore(harness!.connectionString);
    const principal = await store.enqueue({
      destination: { type: "principal", target: "alice" },
      text: "principal",
      idempotencyKey: "r08-postgres-principal",
    });
    const firstDm = await store.enqueue({
      destination: photonDm("first"),
      text: "first Photon DM",
      idempotencyKey: "r08-postgres-dm-first",
    });
    const secondDm = await store.enqueue({
      destination: photonDm("second"),
      text: "second Photon DM",
      idempotencyKey: "r08-postgres-dm-second",
    });
    const group = await store.enqueue({
      destination: photonGroup(),
      text: "Photon group",
      idempotencyKey: "r08-postgres-group",
    });
    const malformed = await store.enqueue({
      destination: malformedPhoton,
      text: "malformed Photon candidate",
      idempotencyKey: "r08-postgres-malformed",
    });

    await harness!.pool.query(
      `UPDATE deliveries
        SET created_at = CASE id
          WHEN $1 THEN 100
          WHEN $2 THEN 200
          WHEN $3 THEN 300
          WHEN $4 THEN 400
          WHEN $5 THEN 500
        END
      WHERE id = ANY($6)`,
      [
        principal.id,
        firstDm.id,
        secondDm.id,
        group.id,
        malformed.id,
        [principal.id, firstDm.id, secondDm.id, group.id, malformed.id],
      ],
    );

    await store.recordRecipientThread(principal.id, "agent:main:dm:alice", 1_000);
    await store.recordRecipientThread(firstDm.id, "agent:main:dm:alice", 2_000);
    await store.recordRecipientThread(firstDm.id, "agent:main:dm:alice", 3_000);
    await store.recordRecipientThread(secondDm.id, "agent:main:dm:alice", 4_000);
    await store.recordRecipientThread(group.id, "agent:main:dm:alice", 5_000);
    await store.recordRecipientThread(malformed.id, "agent:main:dm:alice", 6_000);
    await harness!.pool.query("UPDATE deliveries SET recipient_thread_ref = $2 WHERE id = ANY($1)", [
      [group.id, malformed.id],
      "agent:main:dm:alice",
    ]);

    assert.equal((await store.get(firstDm.id))?.deliveredAt, 2_000);
    assert.equal((await store.get(group.id))?.deliveredAt, null);
    assert.equal((await store.get(malformed.id))?.deliveredAt, null);

    const restarted = createPostgresDeliveryStore(harness!.connectionString);
    assert.deepEqual(
      (await restarted.listByRecipientThread("agent:main:dm:alice", { limit: 2 })).map((delivery) => delivery.id),
      [firstDm.id, secondDm.id],
    );
  },
);

test(
  "PostgreSQL compare-and-set rejects a Photon destination mutation between validation and recording",
  { skip },
  async () => {
    const store = createPostgresDeliveryStore(harness!.connectionString);
    const delivery = await store.enqueue({
      destination: photonDm("race"),
      text: "destination race",
      idempotencyKey: "r08-postgres-race",
    });
    let blocker: PoolClient | undefined;
    try {
      blocker = await harness!.pool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM deliveries WHERE id = $1 FOR UPDATE", [delivery.id]);
      const blockerPid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const recording = store.recordRecipientThread(delivery.id, "agent:main:dm:alice", 7_000);

      let waiting = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const active = await harness!.pool.query<{ waiting: boolean }>(
          `SELECT EXISTS(
           SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND $1 = ANY(pg_blocking_pids(pid))
              AND query LIKE '%recipient_thread_ref%'
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
      await recording;

      const stored = await store.get(delivery.id);
      assert.equal(stored?.destination.type, "photon");
      assert.equal(stored?.deliveredAt, null);
      assert.equal(stored?.recipientThreadRef, undefined);
    } finally {
      if (blocker) {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
    }
  },
);
