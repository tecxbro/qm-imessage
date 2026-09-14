import { randomUUID } from "node:crypto";

import pg from "pg";

const databasePrefix = "qm_cp1_";
const clusterLock = "qm-cp1-postgres-cluster-setup";

export interface Cp1PostgresHarness {
  connectionString: string;
  databaseName: string;
  pool: pg.Pool;
  withClusterLock<T>(work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function cp1PostgresSkip(
  label: string,
  connectionString: string | undefined,
  required: boolean,
): false | string {
  if (connectionString) return false;
  if (required) throw new Error(`${label} requires CP1_POSTGRES_ADMIN_URL`);
  return `set CP1_POSTGRES_ADMIN_URL to run ${label}`;
}

export async function createCp1PostgresHarness(connectionString: string): Promise<Cp1PostgresHarness> {
  const sourceUrl = new URL(connectionString);
  if (sourceUrl.protocol !== "postgres:" && sourceUrl.protocol !== "postgresql:") {
    throw new TypeError("CP1_POSTGRES_ADMIN_URL must use the postgres protocol");
  }
  const expectedSourceDatabase = decodeURIComponent(sourceUrl.pathname.slice(1));
  if (expectedSourceDatabase.length === 0) throw new TypeError("CP1_POSTGRES_ADMIN_URL must name a source database");

  const databaseName = `${databasePrefix}${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString });
  let source: pg.QueryResult<{ database_name: string; is_superuser: boolean }>;
  try {
    source = await admin.query<{ database_name: string; is_superuser: boolean }>(
      `SELECT current_database() AS database_name,
              EXISTS(SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) AS is_superuser`,
    );
  } catch (error) {
    await admin.end();
    throw error;
  }
  if (source.rows[0]?.database_name !== expectedSourceDatabase || source.rows[0]?.is_superuser !== true) {
    await admin.end();
    throw new Error("CP1_POSTGRES_ADMIN_URL must resolve to its named database as a superuser");
  }

  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } catch (error) {
    await admin.end();
    throw error;
  }

  const isolatedUrl = new URL(sourceUrl);
  isolatedUrl.pathname = `/${databaseName}`;
  const pool = new pg.Pool({ connectionString: isolatedUrl.toString() });

  try {
    const selected = await pool.query<{ database_name: string }>("SELECT current_database() AS database_name");
    if (selected.rows[0]?.database_name !== databaseName) throw new Error("isolated database selection failed");
  } catch (error) {
    let cleanupError: unknown;
    try {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    } catch (caught) {
      cleanupError = caught;
    } finally {
      await admin.end();
    }
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], "isolated database validation and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }

  let poolEnded = false;
  let databaseDropped = false;
  let adminEnded = false;
  let closeInFlight: Promise<void> | undefined;

  return {
    connectionString: isolatedUrl.toString(),
    databaseName,
    pool,
    async withClusterLock<T>(work: () => Promise<T>): Promise<T> {
      const client = await admin.connect();
      try {
        await client.query("SELECT pg_advisory_lock(hashtext($1))", [clusterLock]);
        return await work();
      } finally {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtext($1))", [clusterLock]);
        } finally {
          client.release();
        }
      }
    },
    async close() {
      if (adminEnded) return;
      if (closeInFlight) return closeInFlight;
      closeInFlight = (async () => {
        if (!databaseName.startsWith(databasePrefix)) throw new Error("refusing to drop an unowned database");
        if (!poolEnded) {
          await pool.end();
          poolEnded = true;
        }
        if (!databaseDropped) {
          await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
          databaseDropped = true;
        }
        if (!adminEnded) {
          await admin.end();
          adminEnded = true;
        }
      })();
      try {
        await closeInFlight;
      } finally {
        closeInFlight = undefined;
      }
    },
  };
}
