import {
  createPostgresPhotonStateStores,
  type PhotonStateDatabase,
  type PhotonStateQueryResult,
  type PhotonStateStores,
  type PhotonStateTransaction,
} from "../../chassis/src/photon-state.ts";

export interface PhotonStatePoolClient {
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}

export interface PhotonStatePool {
  query(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  connect(): Promise<PhotonStatePoolClient>;
}

export interface PhotonStateRuntime {
  stores: PhotonStateStores;
  close(): Promise<void>;
}

function normalized<Row extends Record<string, unknown>>(result: {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}): PhotonStateQueryResult<Row> {
  return { rows: result.rows as Row[], rowCount: result.rowCount ?? result.rows.length };
}

export function createPhotonStateDatabase(pool: PhotonStatePool): PhotonStateDatabase {
  return {
    async query<Row extends Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      return normalized<Row>(await pool.query(text, params));
    },
    async transaction<T>(work: (transaction: PhotonStateTransaction) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work({
          async query<Row extends Record<string, unknown>>(text: string, params?: readonly unknown[]) {
            return normalized<Row>(await client.query(text, params));
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export function createPhotonStateRuntime(dependencies: {
  database: PhotonStateDatabase;
  close?: () => Promise<void>;
}): PhotonStateRuntime {
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("Photon state runtime is closed");
  };
  const database: PhotonStateDatabase = {
    async query(text, params) {
      assertOpen();
      return dependencies.database.query(text, params);
    },
    async transaction(work) {
      assertOpen();
      return dependencies.database.transaction(async (transaction) => {
        assertOpen();
        return work({
          async query(text, params) {
            assertOpen();
            return transaction.query(text, params);
          },
        });
      });
    },
  };
  return {
    stores: createPostgresPhotonStateStores(database),
    async close() {
      if (closed) return;
      closed = true;
      await dependencies.close?.();
    },
  };
}
