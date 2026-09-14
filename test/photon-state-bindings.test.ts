import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";

import { createPhotonBindingStores, type PhotonBindingStores } from "../plugins/chassis/src/photon-state/bindings.ts";
import { PHOTON_STATE_MIGRATION, PHOTON_STATE_SCHEMA } from "../plugins/chassis/src/photon-state-schema.ts";
import type { ConversationReference, MessageReference } from "../plugins/chassis/src/photon-contract.ts";
import type { ChatSessionBinding, MessageBinding } from "../plugins/photon/src/ports.ts";
import { createPhotonStateDatabase, type PhotonStatePool } from "../plugins/photon/src/state.ts";
import { chats } from "../plugins/photon/test/fixtures.ts";
import { applyPgMigrations, definePgMigration } from "../src/persistence/pg-pool.ts";
import { cp1PostgresSkip, createCp1PostgresHarness, type Cp1PostgresHarness } from "./helpers/cp1-postgres.ts";

const databaseUrl = process.env.CP1_POSTGRES_ADMIN_URL;
const skip = cp1PostgresSkip("Photon selection binding tests", databaseUrl, process.env.CP1_REQUIRE_POSTGRES === "1");
let harness: Cp1PostgresHarness | undefined;
let admin: pg.Pool | undefined;
let stores: PhotonBindingStores;

function database(pool: pg.Pool) {
  return createPhotonStateDatabase(pool as unknown as PhotonStatePool);
}

function conversation(suffix: string, changes: Partial<ConversationReference> = {}): ConversationReference {
  return { ...chats[0], conversationId: `selection-${suffix}`, ...changes };
}

function session(conversationReference: ConversationReference, qmSessionId: string): ChatSessionBinding {
  return {
    conversation: conversationReference,
    qmSessionId,
    resourceRevision: `revision-${qmSessionId}`,
  };
}

function message(conversationReference: ConversationReference, suffix: string, qmSessionId: string): MessageBinding {
  const providerMessage: MessageReference = {
    conversation: conversationReference,
    messageId: `message-${suffix}`,
    parts: [
      { messageId: `part-${suffix}-0`, partIndex: 0 },
      { messageId: `part-${suffix}-1`, partIndex: 1 },
    ],
  };
  return {
    providerMessage,
    qmSessionId,
    qmEntrySequence: 7,
    resourceRevision: `revision-${qmSessionId}`,
  };
}

before(async () => {
  if (!databaseUrl) return;
  harness = await createCp1PostgresHarness(databaseUrl);
  admin = harness.pool;
  await harness.withClusterLock(() =>
    applyPgMigrations(admin!, [definePgMigration(PHOTON_STATE_MIGRATION.id, PHOTON_STATE_MIGRATION.statements)]),
  );
  await admin.query(
    `ALTER TABLE ${PHOTON_STATE_SCHEMA}.chat_session_bindings
       ADD COLUMN binding_version BIGINT NOT NULL DEFAULT 1
       CHECK (binding_version >= 1 AND binding_version <= 9007199254740991)`,
  );
  stores = createPhotonBindingStores(database(admin));
});

after(async () => {
  await harness?.close();
});

test("selection switches A to B without retargeting historical message parts", { skip }, async () => {
  const target = conversation("switch");
  const a = session(target, "session-a");
  const b = session(target, "session-b");
  const historical = message(target, "historical", a.qmSessionId);

  assert.equal(await stores.chatSessions.bind(a), "bound");
  assert.equal(await stores.chatSessions.bind(b), "conflict");
  assert.equal(await stores.messages.bind(historical), "bound");
  assert.deepEqual(await stores.chatSessions.readSelection(target), { binding: a, version: 1 });
  assert.deepEqual(await stores.chatSessions.compareAndSetSelection(target, 1, b), { binding: b, version: 2 });
  assert.deepEqual(await stores.chatSessions.find(target), b);
  assert.equal(await stores.chatSessions.bind(b), "duplicate");
  assert.equal(await stores.chatSessions.bind(a), "conflict");

  for (const part of historical.providerMessage.parts) {
    assert.deepEqual(await stores.messages.findByProviderPart({ ...target, ...part }), historical);
  }
  assert.deepEqual(await stores.messages.findByQmEntry(a.qmSessionId, historical.qmEntrySequence), [historical]);
});

test("one compare-and-set writer wins and the selected version survives restart", { skip }, async () => {
  const target = conversation("writers");
  const a = session(target, "writer-a");
  const b = session(target, "writer-b");
  const c = session(target, "writer-c");

  assert.equal(await stores.chatSessions.bind(a), "bound");
  const results = await Promise.all([
    stores.chatSessions.compareAndSetSelection(target, 1, b),
    stores.chatSessions.compareAndSetSelection(target, 1, c),
  ]);
  assert.equal(results.filter((result) => result !== undefined).length, 1);
  const winner = results.find((result) => result !== undefined)!;
  assert.equal(winner.version, 2);

  const restarted = createPhotonBindingStores(database(admin!));
  assert.deepEqual(await restarted.chatSessions.readSelection(target), winner);
});

test("selection versions prevent ABA and stale compare-and-set retries", { skip }, async () => {
  const target = conversation("aba");
  const a = session(target, "aba-a");
  const b = session(target, "aba-b");

  assert.equal(await stores.chatSessions.bind(a), "bound");
  assert.deepEqual(await stores.chatSessions.compareAndSetSelection(target, 1, b), { binding: b, version: 2 });
  assert.deepEqual(await stores.chatSessions.compareAndSetSelection(target, 2, a), { binding: a, version: 3 });
  assert.equal(await stores.chatSessions.compareAndSetSelection(target, 1, b), undefined);
  assert.deepEqual(await stores.chatSessions.readSelection(target), { binding: a, version: 3 });
});

test("selection compare-and-set does not create or cross line and project authority", { skip }, async () => {
  const target = conversation("authority");
  const a = session(target, "authority-a");
  const b = session(target, "authority-b");
  const missing = conversation("missing");
  const foreignLine = { ...target, lineId: "line-foreign" };
  const foreignProject = { ...target, projectId: "project-foreign" };

  assert.equal(await stores.chatSessions.compareAndSetSelection(missing, 1, session(missing, "missing")), undefined);
  assert.equal(await stores.chatSessions.readSelection(missing), undefined);
  assert.equal(await stores.chatSessions.bind(a), "bound");
  assert.equal(
    await stores.chatSessions.compareAndSetSelection(foreignLine, 1, session(foreignLine, "foreign-line")),
    undefined,
  );
  assert.equal(
    await stores.chatSessions.compareAndSetSelection(foreignProject, 1, session(foreignProject, "foreign-project")),
    undefined,
  );
  assert.equal(await stores.chatSessions.compareAndSetSelection(target, 0, b), undefined);
  assert.equal(await stores.chatSessions.compareAndSetSelection(target, Number.MAX_SAFE_INTEGER, b), undefined);
  assert.deepEqual(await stores.chatSessions.readSelection(target), { binding: a, version: 1 });
});
