import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";

import {
  createPhotonLineOwnerStore,
  type PhotonLineOwnerClaim,
} from "../plugins/chassis/src/photon-state/line-owner.ts";
import { PHOTON_STATE_SCHEMA } from "../plugins/chassis/src/photon-state-schema.ts";
import { createPhotonStateDatabase, type PhotonStatePool } from "../plugins/photon/src/state.ts";
import { cp1PostgresSkip, createCp1PostgresHarness, type Cp1PostgresHarness } from "./helpers/cp1-postgres.ts";

const databaseUrl = process.env.CP1_POSTGRES_ADMIN_URL;
const skip = cp1PostgresSkip(
  "Photon line-owner PostgreSQL tests",
  databaseUrl,
  process.env.CP1_REQUIRE_POSTGRES === "1",
);
let harness: Cp1PostgresHarness | undefined;
let pool: pg.Pool | undefined;

function database(target: pg.Pool) {
  return createPhotonStateDatabase(target as unknown as PhotonStatePool);
}

before(async () => {
  if (!databaseUrl) return;
  harness = await createCp1PostgresHarness(databaseUrl);
  pool = harness.pool;
  await pool.query(`CREATE SCHEMA ${PHOTON_STATE_SCHEMA}`);
  await pool.query(`CREATE TABLE ${PHOTON_STATE_SCHEMA}.line_owners(
    installation_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    fence BIGINT NOT NULL CHECK (fence > 0 AND fence <= 9007199254740991),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (installation_id, line_id)
  )`);
});

after(async () => {
  await harness?.close();
});

function connectionProcess(input: {
  installationId: string;
  lineId: string;
  ownerId: string;
  provider: "advanced-imessage" | "spectrum-imessage";
  ttlMs: number;
}) {
  const stateUrl = pathToFileURL(new URL("../plugins/photon/src/state.ts", import.meta.url).pathname).href;
  const ownerUrl = pathToFileURL(
    new URL("../plugins/chassis/src/photon-state/line-owner.ts", import.meta.url).pathname,
  ).href;
  const lifecycleUrl = pathToFileURL(
    new URL("../plugins/photon/src/provider/line-owner.ts", import.meta.url).pathname,
  ).href;
  const connectionUrl = pathToFileURL(
    new URL("../plugins/photon/src/provider/connection.ts", import.meta.url).pathname,
  ).href;
  const script = `
    import pg from "pg";
    import { createPhotonStateDatabase } from ${JSON.stringify(stateUrl)};
    import { createPhotonLineOwnerStore } from ${JSON.stringify(ownerUrl)};
    import { createProviderLineOwnership } from ${JSON.stringify(lifecycleUrl)};
    import { createConnectionManager } from ${JSON.stringify(connectionUrl)};
    const input = JSON.parse(process.env.R14_CLAIM);
    const pool = new pg.Pool({ connectionString: process.env.R14_DATABASE_URL });
    const store = createPhotonLineOwnerStore(createPhotonStateDatabase(pool));
    const ownership = createProviderLineOwnership(store, {
      leaseTtlMs: input.ttlMs,
      renewAfterMs: Math.floor(input.ttlMs / 3),
      ownerId: () => input.ownerId,
    });
    const manager = createConnectionManager(
      {
        advanced: () => ({ close: async () => undefined }),
        spectrum: async () => ({
          messages: { async *[Symbol.asyncIterator]() {} },
          stop: async () => undefined,
        }),
      },
      ownership,
    );
    try {
      const connection = await manager.replace(
        {
          reference: {
            provider: input.provider,
            installationId: input.installationId,
            lineId: input.lineId,
            projectId: "project",
          },
          phone: "+15550000001",
          kind: "dedicated",
        },
        { address: "offline", token: "offline" },
      );
      connection.addConsumer(async () => undefined);
      process.stdout.write(JSON.stringify({ owned: true }) + "\\n");
      await new Promise(() => undefined);
    } catch (error) {
      process.stdout.write(JSON.stringify({ owned: false, code: error instanceof Error ? error.message : "unknown" }) + "\\n");
      await manager.stop();
      await pool.end();
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      R14_DATABASE_URL: harness!.connectionString,
      R14_CLAIM: JSON.stringify(input),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const ready = new Promise<{ owned: boolean; code?: string }>((resolve, reject) => {
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) resolve(JSON.parse(stdout.slice(0, newline)));
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (!stdout.includes("\n")) reject(new Error(`connection child exited ${String(code)}: ${stderr}`));
    });
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => void (stderr += chunk));
  const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve([code, signal]));
  });
  return { child, ready, closed };
}

async function terminateConnectionProcess(process: ReturnType<typeof connectionProcess>, expectRunning = false) {
  const running = process.child.exitCode === null && process.child.signalCode === null;
  if (expectRunning) assert.equal(running, true);
  if (running) process.child.kill("SIGKILL");
  const [, signal] = await process.closed;
  if (expectRunning) assert.equal(signal, "SIGKILL");
}

test("separate adapter processes fence one physical line across provider modes", { skip }, async () => {
  const spectrum = connectionProcess({
    installationId: "cross-mode",
    lineId: "physical-line",
    ownerId: "spectrum",
    provider: "spectrum-imessage",
    ttlMs: 900,
  });
  const advanced = connectionProcess({
    installationId: "cross-mode",
    lineId: "physical-line",
    ownerId: "advanced",
    provider: "advanced-imessage",
    ttlMs: 900,
  });
  let crossMode: Awaited<typeof spectrum.ready>[] | undefined;
  try {
    crossMode = await Promise.all([spectrum.ready, advanced.ready]);
    assert.equal(crossMode.filter((result) => result.owned).length, 1);
    assert.equal(crossMode.find((result) => !result.owned)?.code, "PROVIDER_LINE_ALREADY_OWNED");
  } finally {
    await Promise.all([
      terminateConnectionProcess(spectrum, crossMode?.[0]?.owned === true),
      terminateConnectionProcess(advanced, crossMode?.[1]?.owned === true),
    ]);
  }

  const firstLine = connectionProcess({
    installationId: "different-lines",
    lineId: "line-a",
    ownerId: "process-a",
    provider: "spectrum-imessage",
    ttlMs: 900,
  });
  const secondLine = connectionProcess({
    installationId: "different-lines",
    lineId: "line-b",
    ownerId: "process-b",
    provider: "advanced-imessage",
    ttlMs: 900,
  });
  let differentLines: Awaited<typeof firstLine.ready>[] | undefined;
  try {
    differentLines = await Promise.all([firstLine.ready, secondLine.ready]);
    assert.equal(
      differentLines.every((result) => result.owned),
      true,
    );
  } finally {
    await Promise.all([
      terminateConnectionProcess(firstLine, differentLines?.[0]?.owned === true),
      terminateConnectionProcess(secondLine, differentLines?.[1]?.owned === true),
    ]);
  }
});

test("process death permits fenced takeover and rejects stale renewal and release", { skip }, async () => {
  const originalProcess = connectionProcess({
    installationId: "takeover",
    lineId: "physical-line",
    ownerId: "dead-process",
    provider: "spectrum-imessage",
    ttlMs: 300,
  });
  let successorProcess: ReturnType<typeof connectionProcess> | undefined;
  try {
    assert.equal((await originalProcess.ready).owned, true);
    const originalRow = await pool!.query(
      `SELECT installation_id, line_id, owner_id, fence, expires_at
         FROM ${PHOTON_STATE_SCHEMA}.line_owners
        WHERE installation_id = $1 AND line_id = $2`,
      ["takeover", "physical-line"],
    );
    const original: PhotonLineOwnerClaim = {
      key: { installationId: originalRow.rows[0]!.installation_id, lineId: originalRow.rows[0]!.line_id },
      ownerId: originalRow.rows[0]!.owner_id,
      fence: Number(originalRow.rows[0]!.fence),
      leaseExpiresAt: originalRow.rows[0]!.expires_at.toISOString(),
    };
    await terminateConnectionProcess(originalProcess, true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    successorProcess = connectionProcess({
      installationId: "takeover",
      lineId: "physical-line",
      ownerId: "successor-process",
      provider: "advanced-imessage",
      ttlMs: 900,
    });
    assert.equal((await successorProcess.ready).owned, true);
    const successorRow = await pool!.query(
      `SELECT installation_id, line_id, owner_id, fence, expires_at
         FROM ${PHOTON_STATE_SCHEMA}.line_owners
        WHERE installation_id = $1 AND line_id = $2`,
      ["takeover", "physical-line"],
    );
    const successor: PhotonLineOwnerClaim = {
      key: { installationId: successorRow.rows[0]!.installation_id, lineId: successorRow.rows[0]!.line_id },
      ownerId: successorRow.rows[0]!.owner_id,
      fence: Number(successorRow.rows[0]!.fence),
      leaseExpiresAt: successorRow.rows[0]!.expires_at.toISOString(),
    };
    assert.equal(successor.fence, original.fence + 1);

    const store = createPhotonLineOwnerStore(database(pool!));
    const now = new Date().toISOString();
    assert.equal(await store.renew(original, now, new Date(Date.now() + 2_000).toISOString()), undefined);
    assert.equal(await store.release(original, now), false);
    const row = await pool!.query(
      `SELECT owner_id, fence FROM ${PHOTON_STATE_SCHEMA}.line_owners
        WHERE installation_id = $1 AND line_id = $2`,
      [successor.key.installationId, successor.key.lineId],
    );
    assert.deepEqual(row.rows[0], { owner_id: successor.ownerId, fence: String(successor.fence) });
  } finally {
    await terminateConnectionProcess(originalProcess);
    if (successorProcess !== undefined) await terminateConnectionProcess(successorProcess, true);
  }
});

test("lock contention never exposes a lease that expired before its query returned", { skip }, async () => {
  const contenderPool = new pg.Pool({ connectionString: harness!.connectionString });
  const store = createPhotonLineOwnerStore(database(contenderPool));
  const key = { installationId: "contention", lineId: "physical-line" };
  try {
    const initialNow = Date.now();
    const initial = await store.claim(
      key,
      "initial-owner",
      new Date(initialNow).toISOString(),
      new Date(initialNow + 100).toISOString(),
    );
    assert.ok(initial);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const lock = await pool!.connect();
    try {
      await lock.query("BEGIN");
      await lock.query(
        `SELECT 1 FROM ${PHOTON_STATE_SCHEMA}.line_owners
          WHERE installation_id = $1 AND line_id = $2 FOR UPDATE`,
        [key.installationId, key.lineId],
      );
      const requestNow = Date.now();
      let settled = false;
      const pending = store
        .claim(key, "contending-owner", new Date(requestNow).toISOString(), new Date(requestNow + 100).toISOString())
        .finally(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(settled, false);
      await lock.query("COMMIT");
      assert.equal(await pending, undefined);
    } finally {
      await lock.query("ROLLBACK").catch(() => undefined);
      lock.release();
    }
  } finally {
    await contenderPool.end();
  }
});

test("renewal blocked past expiry cannot resurrect an expired generation", { skip }, async () => {
  const contenderPool = new pg.Pool({ connectionString: harness!.connectionString });
  const store = createPhotonLineOwnerStore(database(contenderPool));
  const key = { installationId: "renew-contention", lineId: "physical-line" };
  try {
    const initialNow = Date.now();
    const initial = await store.claim(
      key,
      "initial-owner",
      new Date(initialNow).toISOString(),
      new Date(initialNow + 500).toISOString(),
    );
    assert.ok(initial);
    const lock = await pool!.connect();
    try {
      await lock.query("BEGIN");
      await lock.query(
        `SELECT 1 FROM ${PHOTON_STATE_SCHEMA}.line_owners
          WHERE installation_id = $1 AND line_id = $2 FOR UPDATE`,
        [key.installationId, key.lineId],
      );
      const requestNow = Date.now();
      let settled = false;
      const pending = store
        .renew(initial, new Date(requestNow).toISOString(), new Date(requestNow + 1_000).toISOString())
        .finally(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(settled, false);
      await lock.query("COMMIT");
      assert.equal(await pending, undefined);
    } finally {
      await lock.query("ROLLBACK").catch(() => undefined);
      lock.release();
    }
  } finally {
    await contenderPool.end();
  }
});

test("release expires rather than deletes and an exhausted fence cannot wrap", { skip }, async () => {
  const store = createPhotonLineOwnerStore(database(pool!));
  const now = Date.now();
  const claim = await store.claim(
    { installationId: "release", lineId: "physical-line" },
    "owner",
    new Date(now).toISOString(),
    new Date(now + 2_000).toISOString(),
  );
  assert.ok(claim);
  assert.equal(await store.release(claim, new Date().toISOString()), true);
  const retained = await pool!.query(
    `SELECT owner_id, fence, expires_at <= clock_timestamp() AS expired
       FROM ${PHOTON_STATE_SCHEMA}.line_owners
      WHERE installation_id = $1 AND line_id = $2`,
    [claim.key.installationId, claim.key.lineId],
  );
  assert.deepEqual(retained.rows[0], { owner_id: claim.ownerId, fence: String(claim.fence), expired: true });

  await pool!.query(
    `INSERT INTO ${PHOTON_STATE_SCHEMA}.line_owners(installation_id, line_id, owner_id, fence, expires_at)
     VALUES ($1, $2, $3, 9007199254740991, clock_timestamp() - interval '1 second')`,
    ["max-fence", "physical-line", "previous"],
  );
  assert.equal(
    await store.claim(
      { installationId: "max-fence", lineId: "physical-line" },
      "next",
      new Date(now).toISOString(),
      new Date(now + 2_000).toISOString(),
    ),
    undefined,
  );
});

test("database time controls activity while request timestamps only determine duration", { skip }, async () => {
  const store = createPhotonLineOwnerStore(database(pool!));
  const claim = await store.claim(
    { installationId: "database-time", lineId: "physical-line" },
    "owner",
    "2000-01-01T00:00:00.000Z",
    "2000-01-01T00:00:01.000Z",
  );
  assert.ok(claim);
  assert.ok(Date.parse(claim.leaseExpiresAt) > Date.now());
});
