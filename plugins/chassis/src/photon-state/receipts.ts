import type {
  ContiguousCheckpoint,
  EventReceipt,
  ProviderEventKey,
  ProviderLineScope,
  RecoverableEventReceiptStorePort,
  ReceiptClaim,
} from "../../../photon/src/ports.ts";
import { canonicalSequence } from "../photon-state-records.ts";
import { PHOTON_STATE_SCHEMA } from "../photon-state-schema.ts";

import type { PhotonStateDatabase } from "./db.ts";
import {
  PHOTON_STATE_RECORD_VERSION,
  advisoryKey,
  canonicalTimestamp,
  decoded,
  encoded,
  eventValues,
  nonempty,
  resultCount,
  sameJson,
  scopeValues,
  selectRecord,
  type RecordRow,
} from "./shared.ts";

type ReceiptRecoveryRow = RecordRow & {
  captured_at: Date | string;
  claim_expires_at: Date | string | null;
  claim_fence: number | string;
  event_id: string;
  installation_id: string;
  line_id: string;
  provider: string;
  sequence: number | string | null;
  state: string;
};

function activeClaim(current: ReceiptClaim | undefined, expected: ReceiptClaim, now: string): boolean {
  const nowMilliseconds = canonicalTimestamp(now, "now");
  return (
    current !== undefined &&
    current.claimId === expected.claimId &&
    current.fence === expected.fence &&
    current.leaseExpiresAt === expected.leaseExpiresAt &&
    Date.parse(current.leaseExpiresAt) > nowMilliseconds
  );
}

function receiptScope(key: ProviderEventKey & ProviderLineScope): ProviderLineScope {
  return { provider: key.provider, installationId: key.installationId, lineId: key.lineId };
}

export function createPhotonReceiptStore(database: PhotonStateDatabase): RecoverableEventReceiptStorePort {
  async function finishSequenced(
    key: ProviderEventKey & ProviderLineScope,
    expectedVersion: number,
    nextSequence: string,
    claim: ReceiptClaim,
    now: string,
    state: "checkpointed" | "rejected",
    safeCode?: string,
  ): Promise<boolean> {
    canonicalSequence(nextSequence, "nextSequence");
    canonicalTimestamp(now, "now");
    if (state === "rejected") nonempty(safeCode!, "safeCode");
    return database.transaction(async (transaction) => {
      const scope = receiptScope(key);
      await transaction.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        advisoryKey(["receipt-checkpoint", ...scopeValues(scope)]),
      ]);
      const receipt = await selectRecord(
        transaction,
        "event-receipt",
        `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.event_receipts
          WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND event_id = $4 FOR UPDATE`,
        eventValues(key),
      );
      if (
        receipt === undefined ||
        receipt.state !== "processing" ||
        receipt.sequence !== nextSequence ||
        !activeClaim(receipt.claim, claim, now)
      )
        return false;
      const checkpoint = await selectRecord(
        transaction,
        "checkpoint",
        `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.checkpoints
          WHERE provider = $1 AND installation_id = $2 AND line_id = $3 FOR UPDATE`,
        scopeValues(scope),
      );
      if ((checkpoint?.version ?? 0) !== expectedVersion) return false;
      if (checkpoint !== undefined && BigInt(nextSequence) !== BigInt(checkpoint.sequence) + 1n) return false;
      if (checkpoint === undefined) {
        const predecessor = await transaction.query(
          `SELECT 1 FROM ${PHOTON_STATE_SCHEMA}.event_receipts
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3
              AND sequence IS NOT NULL AND sequence < $4::bigint LIMIT 1`,
          [...scopeValues(scope), nextSequence],
        );
        if (predecessor.rows.length > 0) return false;
      }
      const nextCheckpoint: ContiguousCheckpoint = {
        scope,
        sequence: nextSequence,
        version: (checkpoint?.version ?? 0) + 1,
      };
      if (checkpoint === undefined) {
        await transaction.query(
          `INSERT INTO ${PHOTON_STATE_SCHEMA}.checkpoints(
             provider, installation_id, line_id, sequence, entity_version, record_version, record
           ) VALUES ($1, $2, $3, $4::bigint, $5, $6, $7::jsonb)`,
          [
            ...scopeValues(scope),
            nextSequence,
            nextCheckpoint.version,
            PHOTON_STATE_RECORD_VERSION,
            encoded("checkpoint", nextCheckpoint),
          ],
        );
      } else {
        const changed = await transaction.query(
          `UPDATE ${PHOTON_STATE_SCHEMA}.checkpoints
              SET sequence = $4::bigint, entity_version = $5, record = $6::jsonb
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND entity_version = $7`,
          [
            ...scopeValues(scope),
            nextSequence,
            nextCheckpoint.version,
            encoded("checkpoint", nextCheckpoint),
            expectedVersion,
          ],
        );
        if (resultCount(changed) !== 1) return false;
      }
      const nextReceipt: EventReceipt = {
        ...receipt,
        state,
        checkpoint: nextSequence,
        ...(state === "rejected" ? { rejectionCode: safeCode! } : {}),
      };
      const changed = await transaction.query(
        `UPDATE ${PHOTON_STATE_SCHEMA}.event_receipts
            SET state = $5, terminal_at = $6::timestamptz, record = $7::jsonb
          WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND event_id = $4
            AND state = 'processing' AND claim_fence = $8`,
        [...eventValues(key), state, now, encoded("event-receipt", nextReceipt), claim.fence],
      );
      if (resultCount(changed) !== 1) throw new Error("receipt claim changed during checkpoint transition");
      return true;
    });
  }

  const receipts: RecoverableEventReceiptStorePort = {
    async capture(receipt) {
      const serialized = encoded("event-receipt", receipt as EventReceipt);
      return database.transaction(async (transaction) => {
        const inserted = await transaction.query(
          `INSERT INTO ${PHOTON_STATE_SCHEMA}.event_receipts(
             provider, installation_id, line_id, event_id, sequence, state, claim_fence,
             captured_at, record_version, record
           ) VALUES ($1, $2, $3, $4, $5::bigint, 'captured', 0, $6::timestamptz, $7, $8::jsonb)
           ON CONFLICT (provider, installation_id, line_id, event_id) DO NOTHING`,
          [
            ...eventValues(receipt.key),
            receipt.sequence ?? null,
            receipt.capturedAt,
            PHOTON_STATE_RECORD_VERSION,
            serialized,
          ],
        );
        if (resultCount(inserted) === 1) return "captured";
        const current = await selectRecord(
          transaction,
          "event-receipt",
          `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.event_receipts
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND event_id = $4 FOR UPDATE`,
          eventValues(receipt.key),
        );
        return current !== undefined &&
          current.sequence === receipt.sequence &&
          sameJson(current.payload, receipt.payload)
          ? "duplicate"
          : "conflict";
      });
    },
    async claim(key, claimantId, now, leaseExpiresAt) {
      nonempty(claimantId, "claimantId");
      const nowMilliseconds = canonicalTimestamp(now, "now");
      const leaseMilliseconds = canonicalTimestamp(leaseExpiresAt, "leaseExpiresAt");
      if (leaseMilliseconds <= nowMilliseconds) return undefined;
      return database.transaction(async (transaction) => {
        const current = await selectRecord(
          transaction,
          "event-receipt",
          `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.event_receipts
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND event_id = $4 FOR UPDATE`,
          eventValues(key),
        );
        if (current === undefined || current.state === "checkpointed" || current.state === "rejected") return undefined;
        if (
          current.state === "processing" &&
          current.claim !== undefined &&
          Date.parse(current.claim.leaseExpiresAt) > nowMilliseconds
        ) {
          return undefined;
        }
        const claim: ReceiptClaim = {
          claimId: claimantId,
          fence: (current.claim?.fence ?? 0) + 1,
          leaseExpiresAt,
        };
        const next: EventReceipt = { ...current, state: "processing", claim };
        const changed = await transaction.query(
          `UPDATE ${PHOTON_STATE_SCHEMA}.event_receipts
              SET state = 'processing', claim_fence = $5, claim_expires_at = $6::timestamptz, record = $7::jsonb
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND event_id = $4`,
          [...eventValues(key), claim.fence, claim.leaseExpiresAt, encoded("event-receipt", next)],
        );
        return resultCount(changed) === 1 ? next : undefined;
      });
    },
    async completeWithoutSequence(key, claim, now) {
      canonicalTimestamp(now, "now");
      return database.transaction(async (transaction) => {
        const current = await selectRecord(
          transaction,
          "event-receipt",
          `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.event_receipts
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND event_id = $4 FOR UPDATE`,
          eventValues(key),
        );
        if (
          current === undefined ||
          current.state !== "processing" ||
          current.sequence !== undefined ||
          !activeClaim(current.claim, claim, now)
        )
          return false;
        const next: EventReceipt = { ...current, state: "checkpointed" };
        const changed = await transaction.query(
          `UPDATE ${PHOTON_STATE_SCHEMA}.event_receipts
              SET state = 'checkpointed', terminal_at = $5::timestamptz, record = $6::jsonb
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND event_id = $4
              AND state = 'processing' AND claim_fence = $7`,
          [...eventValues(key), now, encoded("event-receipt", next), claim.fence],
        );
        return resultCount(changed) === 1;
      });
    },
    async rejectWithoutSequence(key, claim, now, safeCode) {
      canonicalTimestamp(now, "now");
      nonempty(safeCode, "safeCode");
      return database.transaction(async (transaction) => {
        const current = await selectRecord(
          transaction,
          "event-receipt",
          `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.event_receipts
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND event_id = $4 FOR UPDATE`,
          eventValues(key),
        );
        if (
          current === undefined ||
          current.state !== "processing" ||
          current.sequence !== undefined ||
          !activeClaim(current.claim, claim, now)
        )
          return false;
        const next: EventReceipt = { ...current, state: "rejected", rejectionCode: safeCode };
        const changed = await transaction.query(
          `UPDATE ${PHOTON_STATE_SCHEMA}.event_receipts
              SET state = 'rejected', terminal_at = $5::timestamptz, record = $6::jsonb
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND event_id = $4
              AND state = 'processing' AND claim_fence = $7`,
          [...eventValues(key), now, encoded("event-receipt", next), claim.fence],
        );
        return resultCount(changed) === 1;
      });
    },
    rejectAndAdvanceContiguousCheckpoint(key, expectedVersion, nextSequence, claim, now, safeCode) {
      return finishSequenced(key, expectedVersion, nextSequence, claim, now, "rejected", safeCode);
    },
    async read(key) {
      return selectRecord(
        database,
        "event-receipt",
        `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.event_receipts
          WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND event_id = $4`,
        eventValues(key),
      );
    },
    async readContiguousCheckpoint(scope) {
      return selectRecord(
        database,
        "checkpoint",
        `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.checkpoints
          WHERE provider = $1 AND installation_id = $2 AND line_id = $3`,
        scopeValues(scope),
      );
    },
    async discoverRecoverable(query) {
      if (query.provider !== "spectrum-imessage" && query.provider !== "advanced-imessage")
        throw new TypeError("provider is unsupported");
      nonempty(query.installationId, "installationId");
      if (query.lineId !== undefined) nonempty(query.lineId, "lineId");
      canonicalTimestamp(query.now, "now");
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 128)
        throw new TypeError("limit must be an integer from 1 through 128");
      if (query.after !== undefined) {
        canonicalTimestamp(query.after.capturedAt, "after.capturedAt");
        nonempty(query.after.eventId, "after.eventId");
      }
      const result = await database.query<ReceiptRecoveryRow>(
        `SELECT record, record_version, provider, installation_id, line_id, event_id,
                sequence, state, claim_fence, claim_expires_at, captured_at
           FROM ${PHOTON_STATE_SCHEMA}.event_receipts
          WHERE provider = $1
            AND installation_id = $2
            AND line_id = $3
            AND (
              state = 'captured'
              OR (state = 'processing' AND claim_expires_at IS NOT NULL AND claim_expires_at <= $4::timestamptz)
            )
            AND (
              $5::timestamptz IS NULL
              OR (captured_at, event_id) > ($5::timestamptz, $6::text)
            )
          ORDER BY captured_at, event_id
          LIMIT $7`,
        [
          query.provider,
          query.installationId,
          query.lineId ?? "",
          query.now,
          query.after?.capturedAt ?? null,
          query.after?.eventId ?? null,
          query.limit + 1,
        ],
      );
      const discovered = result.rows.slice(0, query.limit).map((row) => {
        const receipt = decoded("event-receipt", row);
        if (receipt === undefined) throw new Error("recoverable receipt row is missing");
        const capturedAt = row.captured_at instanceof Date ? row.captured_at.toISOString() : row.captured_at;
        const claimExpiresAt =
          row.claim_expires_at instanceof Date ? row.claim_expires_at.toISOString() : row.claim_expires_at;
        canonicalTimestamp(capturedAt, "capturedAt");
        if (
          receipt.key.provider !== row.provider ||
          receipt.key.installationId !== row.installation_id ||
          (receipt.key.lineId ?? "") !== row.line_id ||
          receipt.key.eventId !== row.event_id ||
          receipt.sequence !== (row.sequence === null ? undefined : String(row.sequence)) ||
          receipt.state !== row.state ||
          receipt.capturedAt !== capturedAt
        )
          throw new Error("recoverable receipt columns disagree with record");
        if (
          (receipt.state === "processing" &&
            (claimExpiresAt === null ||
              receipt.claim?.leaseExpiresAt !== claimExpiresAt ||
              receipt.claim.fence !== Number(row.claim_fence))) ||
          (receipt.state === "captured" && (claimExpiresAt !== null || Number(row.claim_fence) !== 0))
        )
          throw new Error("recoverable receipt claim columns disagree with record");
        return receipt;
      });
      const last = discovered.at(-1);
      return {
        receipts: discovered,
        ...(result.rows.length > query.limit && last
          ? { next: { capturedAt: last.capturedAt, eventId: last.key.eventId } }
          : {}),
      };
    },
    advanceContiguousCheckpoint(key, expectedVersion, nextSequence, claim, now) {
      return finishSequenced(key, expectedVersion, nextSequence, claim, now, "checkpointed");
    },
  };

  return receipts;
}
