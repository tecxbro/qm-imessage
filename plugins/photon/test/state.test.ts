import assert from "node:assert/strict";
import test from "node:test";

import { parsePhotonStateRecord, serializePhotonStateRecord } from "../../chassis/src/photon-state-records.ts";
import type {
  PhotonStateDatabase,
  PhotonStateQueryResult,
  PhotonStateTransaction,
} from "../../chassis/src/photon-state.ts";
import {
  createPhotonStateDatabase,
  createPhotonStateRuntime,
  type PhotonStatePool,
  type PhotonStatePoolClient,
} from "../src/state.ts";

test("pool adaptation commits successful transactions and releases their client", async () => {
  const calls: string[] = [];
  const client: PhotonStatePoolClient = {
    async query(text) {
      calls.push(text);
      return { rows: text === "work" ? [{ value: 7 }] : [], rowCount: text === "work" ? 1 : 0 };
    },
    release() {
      calls.push("release");
    },
  };
  const pool: PhotonStatePool = {
    async query(text) {
      calls.push(`pool:${text}`);
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      calls.push("connect");
      return client;
    },
  };
  const database = createPhotonStateDatabase(pool);
  const value = await database.transaction(async (transaction) =>
    Number((await transaction.query<{ value: number }>("work")).rows[0]?.value),
  );
  assert.equal(value, 7);
  assert.deepEqual(calls, ["connect", "BEGIN", "work", "COMMIT", "release"]);
});

test("pool adaptation rolls back failed transactions and releases their client", async () => {
  const calls: string[] = [];
  const pool: PhotonStatePool = {
    async query() {
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        async query(text) {
          calls.push(text);
          return { rows: [], rowCount: 0 };
        },
        release() {
          calls.push("release");
        },
      };
    },
  };
  const database = createPhotonStateDatabase(pool);
  await assert.rejects(
    database.transaction(async () => {
      throw new Error("failed work");
    }),
    /failed work/u,
  );
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK", "release"]);
});

test("runtime exposes only stores, closes once, and rejects use after shutdown", async () => {
  let closes = 0;
  const empty = <Row extends Record<string, unknown>>(): PhotonStateQueryResult<Row> => ({ rows: [], rowCount: 0 });
  const database: PhotonStateDatabase = {
    async query<Row extends Record<string, unknown>>() {
      return empty<Row>();
    },
    async transaction<T>(work: (transaction: PhotonStateTransaction) => Promise<T>): Promise<T> {
      return work({
        async query<Row extends Record<string, unknown>>() {
          return empty<Row>();
        },
      });
    },
  };
  const runtime = createPhotonStateRuntime({
    database,
    async close() {
      closes += 1;
    },
  });
  assert.equal("database" in runtime, false);
  assert.equal(await runtime.stores.installations.read("installation-a"), undefined);
  await runtime.close();
  await runtime.close();
  assert.equal(closes, 1);
  await assert.rejects(runtime.stores.installations.read("installation-a"), /runtime is closed/u);
});

test("serialized installation records retain only ciphertext metadata", () => {
  const valid = {
    installationId: "installation-a",
    ownerRevision: "owner-revision-1",
    version: 1,
    wrappingKeyId: "installation-key-1",
    ciphertext: "ciphertext",
  };
  const serialized = serializePhotonStateRecord("installation", valid);
  assert.deepEqual(parsePhotonStateRecord("installation", serialized), valid);
  assert.throws(
    () =>
      serializePhotonStateRecord("installation", {
        ...valid,
        status: { management: { accessToken: "plaintext" } },
      } as never),
    /unsupported fields/u,
  );
  assert.throws(
    () => parsePhotonStateRecord("installation", { ...serialized, recordVersion: 2 }),
    /version is unsupported/u,
  );
  assert.throws(
    () =>
      serializePhotonStateRecord("installation", {
        ...valid,
        wrappingKeyId: "",
      }),
    /non-empty string/u,
  );
  assert.throws(
    () =>
      serializePhotonStateRecord("installation", {
        ...valid,
        version: 0,
      }),
    /safe integer/u,
  );
});
