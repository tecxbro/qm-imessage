import type { DeliveryOperationRecord, DeliveryOperationStorePort } from "../../../photon/src/ports.ts";
import type { MessagePartReference, PhotonOperationOutcome, PhotonPresentationOperation } from "../photon-contract.ts";
import { parsePhotonReconciliationEvidence } from "../photon-contract.ts";
import {
  canonicalJson,
  operationReceiptMatches,
  plannedPartCount,
  sameConversation,
  sameOperationPayload,
  sameOperationReference,
  samePart,
} from "../photon-state-records.ts";
import { PHOTON_STATE_SCHEMA } from "../photon-state-schema.ts";

import type { PhotonStateDatabase, PhotonStateTransaction } from "./db.ts";
import {
  PHOTON_STATE_RECORD_VERSION,
  encoded,
  operationValues,
  resultCount,
  sameJson,
  selectRecord,
} from "./shared.ts";

function partId(operation: PhotonPresentationOperation, index: number): string {
  return canonicalJson([...operationValues(operation), index]);
}

function confirmedParts(
  outcome: PhotonOperationOutcome,
): readonly { logicalPartIndex: number; part: MessagePartReference }[] {
  return outcome.kind === "confirmed-no-message" || outcome.kind === "unsupported" ? [] : outcome.confirmedParts;
}

function preservesConfirmedParts(
  current: DeliveryOperationRecord,
  evidence: readonly { logicalPartIndex: number; part: MessagePartReference }[],
): boolean {
  return current.parts
    .filter((part) => part.state === "confirmed")
    .every(
      (part) =>
        part.providerPart !== undefined &&
        evidence.some(
          (candidate) => candidate.logicalPartIndex === part.partIndex && samePart(candidate.part, part.providerPart!),
        ),
    );
}

function validConfirmedPartSet(
  current: DeliveryOperationRecord,
  evidence: readonly { logicalPartIndex: number; part: MessagePartReference }[],
): boolean {
  const indexes = evidence.map((part) => part.logicalPartIndex);
  return (
    new Set(indexes).size === indexes.length &&
    indexes.every((index) => Number.isSafeInteger(index) && index >= 0 && index < current.parts.length) &&
    evidence.every((part) => sameConversation(part.part, current.operation.conversation))
  );
}

function completedDeliveryRecord(
  current: DeliveryOperationRecord,
  operation: PhotonPresentationOperation,
  outcome: PhotonOperationOutcome,
): DeliveryOperationRecord | undefined {
  if (
    !sameOperationReference(current.operation, operation) ||
    !sameOperationReference(current.operation, outcome.operation)
  )
    return undefined;
  if (!operationReceiptMatches(operation, outcome)) return undefined;
  const evidence = confirmedParts(outcome);
  if (!validConfirmedPartSet(current, evidence) || !preservesConfirmedParts(current, evidence)) return undefined;
  if (outcome.kind === "confirmed-message") {
    if (evidence.length !== current.parts.length) return undefined;
    const indexes = new Set(evidence.map((part) => part.logicalPartIndex));
    if (current.parts.some((part) => !indexes.has(part.partIndex))) return undefined;
  }
  if (outcome.kind === "confirmed-no-message" && current.parts.length !== 0) return undefined;
  const state =
    outcome.kind === "confirmed-message" || outcome.kind === "confirmed-no-message" ? "confirmed" : outcome.kind;
  const parts = current.parts.map((part) => {
    const providerPart = evidence.find((candidate) => candidate.logicalPartIndex === part.partIndex)?.part;
    if (providerPart !== undefined) return { ...part, state: "confirmed" as const, providerPart };
    if (part.state === "confirmed") return part;
    if (outcome.kind === "unsupported") return { ...part, state: "unsupported" as const };
    if (outcome.kind === "ambiguous") return { ...part, state: "ambiguous" as const };
    if (outcome.kind === "failed") return { ...part, state: "failed" as const };
    return part;
  });
  return { ...current, parts, state, outcome, version: current.version + 1 };
}

async function persistDelivery(transaction: PhotonStateTransaction, record: DeliveryOperationRecord): Promise<void> {
  const values = operationValues(record.operation);
  const updated = await transaction.query(
    `UPDATE ${PHOTON_STATE_SCHEMA}.delivery_operations
       SET operation_id = $6,
           attempt_id = $7,
           state = $8,
           dispatch_fence = $9,
           entity_version = $10,
           updated_at = clock_timestamp(),
           record_version = $11,
           record = $12::jsonb
     WHERE provider = $1 AND installation_id = $2 AND line_id = $3
       AND conversation_id = $4 AND idempotency_key = $5`,
    [
      ...values,
      record.operation.operationId,
      record.operation.attemptId,
      record.state,
      record.dispatchFence,
      record.version,
      PHOTON_STATE_RECORD_VERSION,
      encoded("delivery-operation", record),
    ],
  );
  if (resultCount(updated) !== 1) throw new Error("delivery operation disappeared during transition");
  for (const part of record.parts) {
    const changed = await transaction.query(
      `UPDATE ${PHOTON_STATE_SCHEMA}.delivery_parts
         SET part_id = $7, state = $8, dispatch_fence = $9, provider_part = $10::jsonb
       WHERE provider = $1 AND installation_id = $2 AND line_id = $3
         AND conversation_id = $4 AND idempotency_key = $5 AND part_index = $6`,
      [
        ...values,
        part.partIndex,
        part.partId,
        part.state,
        part.dispatchFence,
        part.providerPart === undefined ? null : JSON.stringify(part.providerPart),
      ],
    );
    if (resultCount(changed) !== 1) throw new Error("delivery part disappeared during transition");
  }
}

async function loadDelivery(
  database: PhotonStateTransaction,
  operation: PhotonPresentationOperation,
  locked = false,
): Promise<DeliveryOperationRecord | undefined> {
  const record = await selectRecord(
    database,
    "delivery-operation",
    `SELECT record, record_version
       FROM ${PHOTON_STATE_SCHEMA}.delivery_operations
      WHERE provider = $1 AND installation_id = $2 AND line_id = $3
        AND conversation_id = $4 AND idempotency_key = $5${locked ? " FOR UPDATE" : ""}`,
    operationValues(operation),
  );
  if (record === undefined) return undefined;
  const rows = await database.query<{
    part_id: string;
    part_index: number;
    state: DeliveryOperationRecord["parts"][number]["state"];
    dispatch_fence: string | number;
    provider_part: MessagePartReference | null;
  }>(
    `SELECT part_id, part_index, state, dispatch_fence, provider_part
       FROM ${PHOTON_STATE_SCHEMA}.delivery_parts
      WHERE provider = $1 AND installation_id = $2 AND line_id = $3
        AND conversation_id = $4 AND idempotency_key = $5
      ORDER BY part_index`,
    operationValues(operation),
  );
  const persistedParts = rows.rows.map((row) => ({
    partId: row.part_id,
    partIndex: Number(row.part_index),
    state: row.state,
    dispatchFence: Number(row.dispatch_fence),
    ...(row.provider_part === null ? {} : { providerPart: row.provider_part }),
  }));
  if (!sameJson(record.parts, persistedParts)) throw new TypeError("delivery operation and part rows disagree");
  return record;
}

export function createPhotonDeliveryStore(database: PhotonStateDatabase): DeliveryOperationStorePort {
  const deliveries: DeliveryOperationStorePort = {
    async reserve(operation) {
      const parts = Array.from({ length: plannedPartCount(operation) }, (_, partIndex) => ({
        partId: partId(operation, partIndex),
        partIndex,
        state: "reserved" as const,
        dispatchFence: 0,
      }));
      const record: DeliveryOperationRecord = {
        operation,
        attempts: [{ operationId: operation.operationId, attemptId: operation.attemptId }],
        parts,
        state: "reserved",
        dispatchFence: 0,
        version: 1,
      };
      const serialized = encoded("delivery-operation", record);
      return database.transaction(async (transaction) => {
        const inserted = await transaction.query(
          `INSERT INTO ${PHOTON_STATE_SCHEMA}.delivery_operations(
             provider, installation_id, line_id, conversation_id, idempotency_key,
             operation_id, attempt_id, state, dispatch_fence, entity_version, record_version, record
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', 0, 1, $8, $9::jsonb)
           ON CONFLICT DO NOTHING`,
          [
            ...operationValues(operation),
            operation.operationId,
            operation.attemptId,
            PHOTON_STATE_RECORD_VERSION,
            serialized,
          ],
        );
        if (resultCount(inserted) === 0) {
          const current = await loadDelivery(transaction, operation, true);
          return current !== undefined && sameOperationPayload(current.operation, operation) ? "duplicate" : "conflict";
        }
        for (const part of record.parts) {
          await transaction.query(
            `INSERT INTO ${PHOTON_STATE_SCHEMA}.delivery_parts(
               provider, installation_id, line_id, conversation_id, idempotency_key,
               part_index, part_id, state, dispatch_fence, provider_part
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', 0, NULL)`,
            [...operationValues(operation), part.partIndex, part.partId],
          );
        }
        return "reserved";
      });
    },
    async markDispatched(operation, expectedVersion) {
      return database.transaction(async (transaction) => {
        const current = await loadDelivery(transaction, operation, true);
        if (
          current === undefined ||
          current.state !== "reserved" ||
          current.version !== expectedVersion ||
          !sameOperationReference(current.operation, operation) ||
          !sameOperationPayload(current.operation, operation)
        )
          return undefined;
        const dispatchFence = current.dispatchFence + 1;
        const next: DeliveryOperationRecord = {
          ...current,
          operation,
          state: "dispatched",
          dispatchFence,
          parts: current.parts.map((part) =>
            part.state === "confirmed" ? part : { ...part, state: "dispatched", dispatchFence },
          ),
          version: current.version + 1,
        };
        await persistDelivery(transaction, next);
        return next;
      });
    },
    async retry(operation, expectedVersion) {
      return database.transaction(async (transaction) => {
        const current = await loadDelivery(transaction, operation, true);
        if (
          current === undefined ||
          current.state !== "failed" ||
          current.version !== expectedVersion ||
          current.outcome?.kind !== "failed" ||
          !current.outcome.retryable ||
          current.attempts.some(
            (attempt) => attempt.operationId === operation.operationId || attempt.attemptId === operation.attemptId,
          ) ||
          !sameOperationPayload(current.operation, operation)
        )
          return undefined;
        const { outcome: _outcome, ...retryable } = current;
        const next: DeliveryOperationRecord = {
          ...retryable,
          operation,
          attempts: [...current.attempts, { operationId: operation.operationId, attemptId: operation.attemptId }],
          state: "reserved",
          parts: current.parts.map((part) => {
            if (part.state === "confirmed") return part;
            const { providerPart: _providerPart, ...unconfirmed } = part;
            return { ...unconfirmed, state: "reserved" };
          }),
          version: current.version + 1,
        };
        await persistDelivery(transaction, next);
        return next;
      });
    },
    async complete(operation, dispatchFence, outcome) {
      return database.transaction(async (transaction) => {
        const current = await loadDelivery(transaction, operation, true);
        if (current === undefined || current.state !== "dispatched" || current.dispatchFence !== dispatchFence)
          return false;
        const next = completedDeliveryRecord(current, operation, outcome);
        if (next === undefined) return false;
        await persistDelivery(transaction, next);
        return true;
      });
    },
    async reconcile(evidence, expectedVersion) {
      try {
        parsePhotonReconciliationEvidence(evidence);
      } catch {
        return false;
      }
      return database.transaction(async (transaction) => {
        const operation = evidence.operation as PhotonPresentationOperation;
        const current = await loadDelivery(transaction, operation, true);
        if (
          current === undefined ||
          current.state !== "ambiguous" ||
          current.version !== expectedVersion ||
          !sameOperationReference(evidence.operation, evidence.outcome.operation)
        )
          return false;
        const completed = completedDeliveryRecord(current, current.operation, evidence.outcome);
        if (completed === undefined || completed.state === "ambiguous" || completed.state === "unsupported")
          return false;
        await persistDelivery(transaction, completed);
        return true;
      });
    },
    read(operation) {
      return loadDelivery(database, operation);
    },
  };

  return deliveries;
}
