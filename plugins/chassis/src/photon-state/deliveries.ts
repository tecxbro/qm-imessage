import type {
  DeliveryDispatchClaim,
  DeliveryOperationRecord,
  DeliveryOperationStorePort,
  RecoverableDeliveryOperationRecord,
  RecoverableDeliveryOperationStorePort,
} from "../../../photon/src/ports.ts";
import type { MessagePartReference, PhotonOperationOutcome, PhotonPresentationOperation } from "../photon-contract.ts";
import { parsePhotonOperationOutcome, parsePhotonReconciliationEvidence } from "../photon-contract.ts";
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
  canonicalTimestamp,
  decoded,
  encoded,
  nonempty,
  operationValues,
  resultCount,
  sameJson,
} from "./shared.ts";

type TransitionalDeliveryOperationStorePort = RecoverableDeliveryOperationStorePort & DeliveryOperationStorePort;

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

function exactOperation(current: PhotonPresentationOperation, operation: PhotonPresentationOperation): boolean {
  return (
    sameOperationReference(current, operation) &&
    current.attemptId === operation.attemptId &&
    sameOperationPayload(current, operation)
  );
}

function activeClaim(
  current: DeliveryDispatchClaim | undefined,
  expected: DeliveryDispatchClaim,
  now: string,
): boolean {
  const nowMilliseconds = canonicalTimestamp(now, "now");
  return (
    current !== undefined &&
    current.ownerId === expected.ownerId &&
    current.fence === expected.fence &&
    current.leaseExpiresAt === expected.leaseExpiresAt &&
    Date.parse(current.leaseExpiresAt) > nowMilliseconds
  );
}

function withoutClaim(record: RecoverableDeliveryOperationRecord): DeliveryOperationRecord {
  const { dispatchClaim: _dispatchClaim, ...persisted } = record;
  return persisted;
}

function databaseTimestamp(value: Date | string, label: string): string {
  const timestamp = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  canonicalTimestamp(timestamp, label);
  return timestamp;
}

async function persistDelivery(
  transaction: PhotonStateTransaction,
  record: RecoverableDeliveryOperationRecord,
): Promise<void> {
  const values = operationValues(record.operation);
  const claim = record.state === "dispatched" ? record.dispatchClaim : undefined;
  const updated = await transaction.query(
    `UPDATE ${PHOTON_STATE_SCHEMA}.delivery_operations
       SET operation_id = $6,
           attempt_id = $7,
           state = $8,
           dispatch_fence = $9,
           entity_version = $10,
           updated_at = date_trunc('milliseconds', clock_timestamp()),
           record_version = $11,
           record = $12::jsonb,
           dispatch_owner_id = $13,
           dispatch_lease_expires_at = $14::timestamptz
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
      encoded("delivery-operation", withoutClaim(record)),
      claim?.ownerId ?? null,
      claim?.leaseExpiresAt ?? null,
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
): Promise<RecoverableDeliveryOperationRecord | undefined> {
  const parent = await database.query<{
    record: unknown;
    record_version: number;
    operation_id: string;
    attempt_id: string;
    state: DeliveryOperationRecord["state"];
    dispatch_fence: string | number;
    entity_version: number;
    dispatch_owner_id: string | null;
    dispatch_lease_expires_at: Date | string | null;
  }>(
    `SELECT record, record_version, operation_id, attempt_id, state, dispatch_fence,
            entity_version, dispatch_owner_id, dispatch_lease_expires_at
       FROM ${PHOTON_STATE_SCHEMA}.delivery_operations
      WHERE provider = $1 AND installation_id = $2 AND line_id = $3
        AND conversation_id = $4 AND idempotency_key = $5${locked ? " FOR UPDATE" : ""}`,
    operationValues(operation),
  );
  const row = parent.rows[0];
  if (row === undefined) return undefined;
  const persisted = decoded("delivery-operation", row);
  if (persisted === undefined) return undefined;
  if (
    !sameConversation(persisted.operation.conversation, operation.conversation) ||
    persisted.operation.idempotencyKey !== operation.idempotencyKey ||
    row.operation_id !== persisted.operation.operationId ||
    row.attempt_id !== persisted.operation.attemptId ||
    row.state !== persisted.state ||
    Number(row.dispatch_fence) !== persisted.dispatchFence ||
    Number(row.entity_version) !== persisted.version
  ) {
    throw new TypeError("delivery operation parent columns disagree");
  }
  if ((row.dispatch_owner_id === null) !== (row.dispatch_lease_expires_at === null)) {
    throw new TypeError("delivery dispatch claim columns disagree");
  }
  let dispatchClaim: DeliveryDispatchClaim | undefined;
  if (row.dispatch_owner_id !== null && row.dispatch_lease_expires_at !== null) {
    if (persisted.state !== "dispatched") throw new TypeError("terminal delivery retains a dispatch claim");
    nonempty(row.dispatch_owner_id, "dispatchOwnerId");
    dispatchClaim = {
      ownerId: row.dispatch_owner_id,
      fence: persisted.dispatchFence,
      leaseExpiresAt: databaseTimestamp(row.dispatch_lease_expires_at, "dispatchLeaseExpiresAt"),
    };
  }
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
      ORDER BY part_index${locked ? " FOR UPDATE" : ""}`,
    operationValues(operation),
  );
  const persistedParts = rows.rows.map((row) => ({
    partId: row.part_id,
    partIndex: Number(row.part_index),
    state: row.state,
    dispatchFence: Number(row.dispatch_fence),
    ...(row.provider_part === null ? {} : { providerPart: row.provider_part }),
  }));
  if (!sameJson(persisted.parts, persistedParts)) throw new TypeError("delivery operation and part rows disagree");
  return dispatchClaim === undefined ? persisted : { ...persisted, dispatchClaim };
}

export function createPhotonDeliveryStore(database: PhotonStateDatabase): TransitionalDeliveryOperationStorePort {
  const deliveries: TransitionalDeliveryOperationStorePort = {
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
             operation_id, attempt_id, state, dispatch_fence, entity_version, updated_at, record_version, record
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, 'reserved', 0, 1,
             date_trunc('milliseconds', clock_timestamp()), $8, $9::jsonb
           )
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
    async acquireDispatch(operation, expectedVersion, ownerId, now, leaseExpiresAt) {
      nonempty(ownerId, "ownerId");
      const nowMilliseconds = canonicalTimestamp(now, "now");
      const leaseMilliseconds = canonicalTimestamp(leaseExpiresAt, "leaseExpiresAt");
      if (leaseMilliseconds <= nowMilliseconds) return undefined;
      return database.transaction(async (transaction) => {
        const current = await loadDelivery(transaction, operation, true);
        if (
          current === undefined ||
          current.state !== "reserved" ||
          current.version !== expectedVersion ||
          !exactOperation(current.operation, operation)
        )
          return undefined;
        const dispatchFence = current.dispatchFence + 1;
        const dispatchClaim: DeliveryDispatchClaim = { ownerId, fence: dispatchFence, leaseExpiresAt };
        const next: RecoverableDeliveryOperationRecord = {
          ...current,
          operation,
          state: "dispatched",
          dispatchFence,
          dispatchClaim,
          parts: current.parts.map((part) =>
            part.state === "confirmed" ? part : { ...part, state: "dispatched", dispatchFence },
          ),
          version: current.version + 1,
        };
        await persistDelivery(transaction, next);
        return next;
      });
    },
    async renewDispatch(operation, claim, now, leaseExpiresAt) {
      nonempty(claim.ownerId, "claim.ownerId");
      canonicalTimestamp(claim.leaseExpiresAt, "claim.leaseExpiresAt");
      const nowMilliseconds = canonicalTimestamp(now, "now");
      const leaseMilliseconds = canonicalTimestamp(leaseExpiresAt, "leaseExpiresAt");
      if (leaseMilliseconds <= nowMilliseconds || leaseMilliseconds <= Date.parse(claim.leaseExpiresAt))
        return undefined;
      return database.transaction(async (transaction) => {
        const current = await loadDelivery(transaction, operation, true);
        if (
          current === undefined ||
          current.state !== "dispatched" ||
          !exactOperation(current.operation, operation) ||
          !activeClaim(current.dispatchClaim, claim, now)
        )
          return undefined;
        const next: RecoverableDeliveryOperationRecord = {
          ...current,
          dispatchClaim: { ...claim, leaseExpiresAt },
          version: current.version + 1,
        };
        await persistDelivery(transaction, next);
        return next;
      });
    },
    async expireDispatch(operation, claim, now) {
      nonempty(claim.ownerId, "claim.ownerId");
      const nowMilliseconds = canonicalTimestamp(now, "now");
      const claimExpiry = canonicalTimestamp(claim.leaseExpiresAt, "claim.leaseExpiresAt");
      return database.transaction(async (transaction) => {
        const current = await loadDelivery(transaction, operation, true);
        if (current === undefined || current.state !== "dispatched" || !exactOperation(current.operation, operation)) {
          return undefined;
        }
        const expires =
          current.dispatchClaim === undefined
            ? current.dispatchFence === claim.fence && claimExpiry <= nowMilliseconds
            : current.dispatchClaim.ownerId === claim.ownerId &&
              current.dispatchClaim.fence === claim.fence &&
              current.dispatchClaim.leaseExpiresAt === claim.leaseExpiresAt &&
              Date.parse(current.dispatchClaim.leaseExpiresAt) <= nowMilliseconds;
        if (!expires) return undefined;
        const confirmed = current.parts.flatMap((part) =>
          part.state === "confirmed" && part.providerPart !== undefined
            ? [{ logicalPartIndex: part.partIndex, part: part.providerPart }]
            : [],
        );
        const outcome: Extract<PhotonOperationOutcome, { kind: "ambiguous" }> = {
          kind: "ambiguous",
          operation: {
            operationId: current.operation.operationId,
            name: current.operation.name,
            conversation: current.operation.conversation,
            idempotencyKey: current.operation.idempotencyKey,
          },
          reconciliationKey: canonicalJson([
            ...operationValues(current.operation),
            current.operation.operationId,
            current.operation.attemptId,
            current.dispatchFence,
            "abandoned",
          ]),
          confirmedParts: confirmed,
        };
        const completed = completedDeliveryRecord(current, current.operation, outcome);
        if (completed === undefined) throw new Error("abandoned delivery could not retain confirmed progress");
        const next = withoutClaim(completed);
        await persistDelivery(transaction, next);
        return next;
      });
    },
    async recordConfirmedPart(operation, claim, logicalPartIndex, part, now) {
      nonempty(claim.ownerId, "claim.ownerId");
      canonicalTimestamp(claim.leaseExpiresAt, "claim.leaseExpiresAt");
      canonicalTimestamp(now, "now");
      if (!Number.isSafeInteger(logicalPartIndex) || logicalPartIndex < 0) return undefined;
      return database.transaction(async (transaction) => {
        const current = await loadDelivery(transaction, operation, true);
        if (
          current === undefined ||
          current.state !== "dispatched" ||
          !exactOperation(current.operation, operation) ||
          !activeClaim(current.dispatchClaim, claim, now) ||
          !sameConversation(part, current.operation.conversation)
        )
          return undefined;
        const storedPart = current.parts[logicalPartIndex];
        if (storedPart === undefined) return undefined;
        if (
          current.parts.some(
            (candidate) =>
              candidate.partIndex !== logicalPartIndex &&
              candidate.providerPart !== undefined &&
              samePart(candidate.providerPart, part),
          )
        )
          return undefined;
        if (storedPart.state === "confirmed") {
          return storedPart.providerPart !== undefined && samePart(storedPart.providerPart, part) ? current : undefined;
        }
        if (storedPart.state !== "dispatched" || storedPart.dispatchFence !== claim.fence) return undefined;
        const next: RecoverableDeliveryOperationRecord = {
          ...current,
          parts: current.parts.map((candidate) =>
            candidate.partIndex === logicalPartIndex
              ? { ...candidate, state: "confirmed" as const, providerPart: part }
              : candidate,
          ),
          version: current.version + 1,
        };
        await persistDelivery(transaction, next);
        return next;
      });
    },
    async markDispatched() {
      throw new Error("delivery dispatch requires an owner and lease");
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
        const { dispatchClaim: _dispatchClaim, outcome: _outcome, ...retryable } = current;
        const next: RecoverableDeliveryOperationRecord = {
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
    async complete(
      operation: PhotonPresentationOperation,
      claim: DeliveryDispatchClaim | number,
      outcome: PhotonOperationOutcome,
      now?: string,
    ) {
      if (typeof claim === "number" || now === undefined) return false;
      nonempty(claim.ownerId, "claim.ownerId");
      canonicalTimestamp(claim.leaseExpiresAt, "claim.leaseExpiresAt");
      canonicalTimestamp(now, "now");
      try {
        parsePhotonOperationOutcome(outcome);
      } catch {
        return false;
      }
      return database.transaction(async (transaction) => {
        const current = await loadDelivery(transaction, operation, true);
        if (
          current === undefined ||
          current.state !== "dispatched" ||
          !exactOperation(current.operation, operation) ||
          !activeClaim(current.dispatchClaim, claim, now)
        )
          return false;
        const next = completedDeliveryRecord(current, operation, outcome);
        if (next === undefined) return false;
        await persistDelivery(transaction, withoutClaim(next));
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
        await persistDelivery(transaction, withoutClaim(completed));
        return true;
      });
    },
    async discoverRecoverable(query) {
      nonempty(query.installationId, "installationId");
      nonempty(query.lineId, "lineId");
      canonicalTimestamp(query.now, "now");
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000) {
        throw new TypeError("limit must be a safe integer from 1 through 1000");
      }
      if (query.after !== undefined) {
        canonicalTimestamp(query.after.updatedAt, "after.updatedAt");
        nonempty(query.after.conversationId, "after.conversationId");
        nonempty(query.after.idempotencyKey, "after.idempotencyKey");
      }
      return database.transaction(async (transaction) => {
        const after = query.after;
        const rows = await transaction.query<{
          record: unknown;
          record_version: number;
          updated_at: Date | string;
          conversation_id: string;
          idempotency_key: string;
        }>(
          `SELECT record, record_version,
                  date_trunc('milliseconds', updated_at) AS updated_at,
                  conversation_id, idempotency_key
             FROM ${PHOTON_STATE_SCHEMA}.delivery_operations
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3
              AND (
                state = 'reserved'
                OR (
                  state = 'dispatched'
                  AND (dispatch_owner_id IS NULL OR dispatch_lease_expires_at IS NULL
                    OR dispatch_lease_expires_at <= $4::timestamptz)
                )
              )
              AND (
                $5::timestamptz IS NULL
                OR (date_trunc('milliseconds', updated_at), conversation_id, idempotency_key)
                  > ($5::timestamptz, $6, $7)
              )
            ORDER BY date_trunc('milliseconds', updated_at), conversation_id, idempotency_key
            LIMIT $8
            FOR UPDATE`,
          [
            query.provider,
            query.installationId,
            query.lineId,
            query.now,
            after?.updatedAt ?? null,
            after?.conversationId ?? "",
            after?.idempotencyKey ?? "",
            query.limit + 1,
          ],
        );
        const pageRows = rows.rows.slice(0, query.limit);
        const found: RecoverableDeliveryOperationRecord[] = [];
        for (const row of pageRows) {
          const record = decoded("delivery-operation", row);
          if (record === undefined) throw new TypeError("delivery recovery record disappeared");
          const loaded = await loadDelivery(
            transaction,
            {
              ...record.operation,
              conversation: {
                ...record.operation.conversation,
                provider: query.provider,
                installationId: query.installationId,
                lineId: query.lineId,
                conversationId: row.conversation_id,
              },
              idempotencyKey: row.idempotency_key,
            },
            true,
          );
          if (loaded === undefined) throw new TypeError("delivery recovery record disappeared");
          found.push(loaded);
        }
        const last = pageRows.at(-1);
        const next =
          rows.rows.length > query.limit && last !== undefined
            ? {
                updatedAt: databaseTimestamp(last.updated_at, "updatedAt"),
                conversationId: last.conversation_id,
                idempotencyKey: last.idempotency_key,
              }
            : undefined;
        return next === undefined ? { deliveries: found } : { deliveries: found, next };
      });
    },
    read(operation) {
      return database.transaction((transaction) => loadDelivery(transaction, operation, true));
    },
  };

  return deliveries;
}
