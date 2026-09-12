import type {
  ActionBindingConsumption,
  ActionBindingStorePort,
  AttachmentRecord,
  AttachmentStorePort,
  ChatSessionBindingStorePort,
  ContiguousCheckpoint,
  DeliveryOperationRecord,
  DeliveryOperationStorePort,
  EventReceipt,
  EventReceiptStorePort,
  InstallationStorePort,
  MessageBindingStorePort,
  PollReferenceStorePort,
  ProviderEventKey,
  ProviderLineScope,
  PublicCardHandleStorePort,
  ReceiptClaim,
  TextStreamSessionRecord,
  TextStreamSessionStorePort,
  VerifiedAddressChallenge,
  VerifiedAddressStorePort,
} from "../../photon/src/ports.ts";
import type {
  ActionBinding,
  ConversationReference,
  MessagePartReference,
  PhotonOperationOutcome,
  PhotonPresentationOperation,
} from "./photon-contract.ts";
import { parsePhotonReconciliationEvidence } from "./photon-contract.ts";
import {
  PHOTON_STATE_RECORD_VERSION,
  canonicalJson,
  canonicalSequence,
  operationReceiptMatches,
  parsePhotonStateRecord,
  plannedPartCount,
  sameConversation,
  sameJson,
  sameOperationPayload,
  sameOperationReference,
  samePart,
  serializePhotonStateRecord,
  type PhotonStateRecordKind,
} from "./photon-state-records.ts";
import { PHOTON_STATE_SCHEMA } from "./photon-state-schema.ts";

export interface PhotonStateQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export interface PhotonStateTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<PhotonStateQueryResult<Row>>;
}

export interface PhotonStateDatabase extends PhotonStateTransaction {
  transaction<T>(work: (transaction: PhotonStateTransaction) => Promise<T>): Promise<T>;
}

export interface PhotonStateStores {
  installations: InstallationStorePort;
  verifiedAddresses: VerifiedAddressStorePort;
  chatSessions: ChatSessionBindingStorePort;
  messages: MessageBindingStorePort;
  attachments: AttachmentStorePort;
  receipts: EventReceiptStorePort;
  deliveries: DeliveryOperationStorePort;
  textStreams: TextStreamSessionStorePort;
  polls: PollReferenceStorePort;
  cards: PublicCardHandleStorePort;
  actions: ActionBindingStorePort;
}

type RecordRow = { record: unknown; record_version: number };

function encoded<Kind extends PhotonStateRecordKind>(
  kind: Kind,
  value: Parameters<typeof serializePhotonStateRecord<Kind>>[1],
): string {
  return JSON.stringify(serializePhotonStateRecord(kind, value));
}

function decoded<Kind extends PhotonStateRecordKind>(
  kind: Kind,
  row: RecordRow | undefined,
): ReturnType<typeof parsePhotonStateRecord<Kind>> | undefined {
  if (row === undefined) return undefined;
  if (Number(row.record_version) !== PHOTON_STATE_RECORD_VERSION)
    throw new TypeError(`${kind} row version is unsupported`);
  return parsePhotonStateRecord(kind, row.record);
}

function resultCount(result: PhotonStateQueryResult): number {
  return Number(result.rowCount ?? result.rows.length);
}

function canonicalTimestamp(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return milliseconds;
}

function nonempty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`${label} must be a non-empty string`);
}

function conversationValues(conversation: ConversationReference): readonly string[] {
  return [conversation.provider, conversation.installationId, conversation.lineId, conversation.conversationId];
}

function operationValues(operation: PhotonPresentationOperation): readonly string[] {
  return [...conversationValues(operation.conversation), operation.idempotencyKey];
}

function eventValues(key: ProviderEventKey): readonly string[] {
  return [key.provider, key.installationId, key.lineId ?? "", key.eventId];
}

function scopeValues(scope: ProviderLineScope): readonly string[] {
  return [scope.provider, scope.installationId, scope.lineId];
}

function advisoryKey(scope: readonly string[]): string {
  return canonicalJson(scope);
}

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

async function selectRecord<Kind extends PhotonStateRecordKind>(
  database: PhotonStateTransaction,
  kind: Kind,
  text: string,
  params: readonly unknown[],
): Promise<ReturnType<typeof parsePhotonStateRecord<Kind>> | undefined> {
  const result = await database.query<RecordRow>(text, params);
  return decoded(kind, result.rows[0]);
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

export function createPostgresPhotonStateStores(database: PhotonStateDatabase): PhotonStateStores {
  const installations: InstallationStorePort = {
    async read(installationId) {
      nonempty(installationId, "installationId");
      return selectRecord(
        database,
        "installation",
        `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.installations WHERE installation_id = $1`,
        [installationId],
      );
    },
    async create(record) {
      const serialized = encoded("installation", record);
      if (record.version !== 1) return false;
      const result = await database.query(
        `INSERT INTO ${PHOTON_STATE_SCHEMA}.installations(
           installation_id, entity_version, record_version, record
         ) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (installation_id) DO NOTHING`,
        [record.installation.installationId, record.version, PHOTON_STATE_RECORD_VERSION, serialized],
      );
      return resultCount(result) === 1;
    },
    async compareAndSet(installationId, expectedVersion, next) {
      const serialized = encoded("installation", next);
      if (next.installation.installationId !== installationId || next.version !== expectedVersion + 1) return false;
      const result = await database.query(
        `UPDATE ${PHOTON_STATE_SCHEMA}.installations
            SET entity_version = $3, record_version = $4, record = $5::jsonb
          WHERE installation_id = $1 AND entity_version = $2`,
        [installationId, expectedVersion, next.version, PHOTON_STATE_RECORD_VERSION, serialized],
      );
      return resultCount(result) === 1;
    },
  };

  const verifiedAddresses: VerifiedAddressStorePort = {
    async create(challenge) {
      const serialized = encoded("verified-address-challenge", challenge);
      if (challenge.version !== 1 || challenge.verifiedAt !== undefined) return "conflict";
      return database.transaction(async (transaction) => {
        const inserted = await transaction.query(
          `INSERT INTO ${PHOTON_STATE_SCHEMA}.verified_address_challenges(
             challenge_id, installation_id, entity_version, expires_at, verified_at, record_version, record
           ) VALUES ($1, $2, $3, $4::timestamptz, NULL, $5, $6::jsonb)
           ON CONFLICT (challenge_id) DO NOTHING`,
          [
            challenge.challengeId,
            challenge.installationId,
            challenge.version,
            challenge.expiresAt,
            PHOTON_STATE_RECORD_VERSION,
            serialized,
          ],
        );
        if (resultCount(inserted) === 1) return "created";
        const current = await selectRecord(
          transaction,
          "verified-address-challenge",
          `SELECT record, record_version
             FROM ${PHOTON_STATE_SCHEMA}.verified_address_challenges
            WHERE challenge_id = $1 FOR UPDATE`,
          [challenge.challengeId],
        );
        return sameJson(current, challenge) ? "duplicate" : "conflict";
      });
    },
    async verify(challengeId, expectedVersion, verifiedAt) {
      nonempty(challengeId, "challengeId");
      const verifiedMilliseconds = canonicalTimestamp(verifiedAt, "verifiedAt");
      return database.transaction(async (transaction) => {
        const current = await selectRecord(
          transaction,
          "verified-address-challenge",
          `SELECT record, record_version
             FROM ${PHOTON_STATE_SCHEMA}.verified_address_challenges
            WHERE challenge_id = $1 FOR UPDATE`,
          [challengeId],
        );
        if (
          current === undefined ||
          current.version !== expectedVersion ||
          current.verifiedAt !== undefined ||
          verifiedMilliseconds >= Date.parse(current.expiresAt)
        )
          return false;
        const next: VerifiedAddressChallenge = { ...current, verifiedAt, version: current.version + 1 };
        const changed = await transaction.query(
          `UPDATE ${PHOTON_STATE_SCHEMA}.verified_address_challenges
              SET entity_version = $3, verified_at = $4::timestamptz, record_version = $5, record = $6::jsonb
            WHERE challenge_id = $1 AND entity_version = $2 AND verified_at IS NULL`,
          [
            challengeId,
            expectedVersion,
            next.version,
            verifiedAt,
            PHOTON_STATE_RECORD_VERSION,
            encoded("verified-address-challenge", next),
          ],
        );
        return resultCount(changed) === 1;
      });
    },
    async read(challengeId) {
      nonempty(challengeId, "challengeId");
      return selectRecord(
        database,
        "verified-address-challenge",
        `SELECT record, record_version
           FROM ${PHOTON_STATE_SCHEMA}.verified_address_challenges WHERE challenge_id = $1`,
        [challengeId],
      );
    },
  };

  const chatSessions: ChatSessionBindingStorePort = {
    async bind(binding) {
      const serialized = encoded("chat-session-binding", binding);
      return database.transaction(async (transaction) => {
        const inserted = await transaction.query(
          `INSERT INTO ${PHOTON_STATE_SCHEMA}.chat_session_bindings(
             provider, installation_id, line_id, conversation_id, record_version, record
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (provider, installation_id, line_id, conversation_id) DO NOTHING`,
          [...conversationValues(binding.conversation), PHOTON_STATE_RECORD_VERSION, serialized],
        );
        if (resultCount(inserted) === 1) return "bound";
        const current = await selectRecord(
          transaction,
          "chat-session-binding",
          `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.chat_session_bindings
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND conversation_id = $4 FOR UPDATE`,
          conversationValues(binding.conversation),
        );
        return sameJson(current, binding) ? "duplicate" : "conflict";
      });
    },
    async find(conversation) {
      return selectRecord(
        database,
        "chat-session-binding",
        `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.chat_session_bindings
          WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND conversation_id = $4`,
        conversationValues(conversation),
      );
    },
  };

  const messages: MessageBindingStorePort = {
    async bind(binding) {
      const serialized = encoded("message-binding", binding);
      const conversation = binding.providerMessage.conversation;
      return database.transaction(async (transaction) => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          advisoryKey(["message-binding", ...conversationValues(conversation)]),
        ]);
        const params: unknown[] = [...conversationValues(conversation), binding.providerMessage.messageId];
        const partPredicates = binding.providerMessage.parts.map((part) => {
          params.push(part.messageId, part.partIndex);
          return `(p.part_message_id = $${params.length - 1} AND p.part_index = $${params.length})`;
        });
        const existing = await transaction.query<RecordRow>(
          `SELECT DISTINCT b.record, b.record_version
             FROM ${PHOTON_STATE_SCHEMA}.message_bindings b
             LEFT JOIN ${PHOTON_STATE_SCHEMA}.message_binding_parts p
               ON p.provider = b.provider AND p.installation_id = b.installation_id
              AND p.line_id = b.line_id AND p.conversation_id = b.conversation_id
              AND p.provider_message_id = b.provider_message_id
            WHERE b.provider = $1 AND b.installation_id = $2 AND b.line_id = $3 AND b.conversation_id = $4
              AND (b.provider_message_id = $5 OR ${partPredicates.join(" OR ")})`,
          params,
        );
        if (existing.rows.length > 0) {
          const records = existing.rows.map((row) => decoded("message-binding", row));
          return records.length === 1 && sameJson(records[0], binding) ? "duplicate" : "conflict";
        }
        const inserted = await transaction.query(
          `INSERT INTO ${PHOTON_STATE_SCHEMA}.message_bindings(
             provider, installation_id, line_id, conversation_id, provider_message_id,
             qm_session_id, qm_entry_sequence, record_version, record
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            ...conversationValues(conversation),
            binding.providerMessage.messageId,
            binding.qmSessionId,
            binding.qmEntrySequence,
            PHOTON_STATE_RECORD_VERSION,
            serialized,
          ],
        );
        if (resultCount(inserted) !== 1) throw new Error("message binding insert failed");
        for (const part of binding.providerMessage.parts) {
          await transaction.query(
            `INSERT INTO ${PHOTON_STATE_SCHEMA}.message_binding_parts(
               provider, installation_id, line_id, conversation_id,
               part_message_id, part_index, provider_message_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [...conversationValues(conversation), part.messageId, part.partIndex, binding.providerMessage.messageId],
          );
        }
        return "bound";
      });
    },
    async findByProviderPart(part) {
      return selectRecord(
        database,
        "message-binding",
        `SELECT b.record, b.record_version
           FROM ${PHOTON_STATE_SCHEMA}.message_binding_parts p
           JOIN ${PHOTON_STATE_SCHEMA}.message_bindings b
             ON b.provider = p.provider AND b.installation_id = p.installation_id
            AND b.line_id = p.line_id AND b.conversation_id = p.conversation_id
            AND b.provider_message_id = p.provider_message_id
          WHERE p.provider = $1 AND p.installation_id = $2 AND p.line_id = $3 AND p.conversation_id = $4
            AND p.part_message_id = $5 AND p.part_index = $6`,
        [...conversationValues(part), part.messageId, part.partIndex],
      );
    },
    async findByQmEntry(qmSessionId, qmEntrySequence) {
      nonempty(qmSessionId, "qmSessionId");
      if (!Number.isSafeInteger(qmEntrySequence) || qmEntrySequence < 0)
        throw new TypeError("qmEntrySequence is invalid");
      const result = await database.query<RecordRow>(
        `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.message_bindings
          WHERE qm_session_id = $1 AND qm_entry_sequence = $2
          ORDER BY provider, installation_id, line_id, conversation_id, provider_message_id`,
        [qmSessionId, qmEntrySequence],
      );
      return result.rows.map((row) => decoded("message-binding", row)!);
    },
  };

  const attachments: AttachmentStorePort = {
    async put(record) {
      const serialized = encoded("attachment", record);
      return database.transaction(async (transaction) => {
        const reference = record.reference;
        const values = [
          ...conversationValues(reference),
          reference.messageId,
          reference.partIndex,
          reference.attachmentId,
        ];
        const inserted = await transaction.query(
          `INSERT INTO ${PHOTON_STATE_SCHEMA}.attachments(
             provider, installation_id, line_id, conversation_id, message_id, part_index,
             attachment_id, state, record_version, record
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           ON CONFLICT (provider, installation_id, line_id, conversation_id, message_id, part_index, attachment_id)
           DO NOTHING`,
          [...values, record.state, PHOTON_STATE_RECORD_VERSION, serialized],
        );
        if (resultCount(inserted) === 1) return "stored";
        const current = await selectRecord(
          transaction,
          "attachment",
          `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.attachments
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND conversation_id = $4
              AND message_id = $5 AND part_index = $6 AND attachment_id = $7 FOR UPDATE`,
          values,
        );
        return sameJson(current, record) ? "duplicate" : "conflict";
      });
    },
    async read(reference) {
      return selectRecord(
        database,
        "attachment",
        `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.attachments
          WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND conversation_id = $4
            AND message_id = $5 AND part_index = $6 AND attachment_id = $7`,
        [...conversationValues(reference), reference.messageId, reference.partIndex, reference.attachmentId],
      );
    },
    async release(reference) {
      return database.transaction(async (transaction) => {
        const values = [
          ...conversationValues(reference),
          reference.messageId,
          reference.partIndex,
          reference.attachmentId,
        ];
        const current = await selectRecord(
          transaction,
          "attachment",
          `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.attachments
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND conversation_id = $4
              AND message_id = $5 AND part_index = $6 AND attachment_id = $7 FOR UPDATE`,
          values,
        );
        if (current === undefined || current.state !== "available") return false;
        const next: AttachmentRecord = { ...current, state: "released" };
        const changed = await transaction.query(
          `UPDATE ${PHOTON_STATE_SCHEMA}.attachments SET state = 'released', record = $8::jsonb
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3 AND conversation_id = $4
              AND message_id = $5 AND part_index = $6 AND attachment_id = $7 AND state = 'available'`,
          [...values, encoded("attachment", next)],
        );
        return resultCount(changed) === 1;
      });
    },
  };

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

  const receipts: EventReceiptStorePort = {
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
    advanceContiguousCheckpoint(key, expectedVersion, nextSequence, claim, now) {
      return finishSequenced(key, expectedVersion, nextSequence, claim, now, "checkpointed");
    },
  };

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

  async function loadStream(
    database: PhotonStateTransaction,
    operation: Extract<PhotonPresentationOperation, { name: "message.text.stream" }>,
    locked = false,
  ): Promise<TextStreamSessionRecord | undefined> {
    const record = await selectRecord(
      database,
      "text-stream-session",
      `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.text_stream_sessions
        WHERE provider = $1 AND installation_id = $2 AND line_id = $3
          AND conversation_id = $4 AND idempotency_key = $5${locked ? " FOR UPDATE" : ""}`,
      operationValues(operation),
    );
    if (record === undefined) return undefined;
    const chunks = await database.query<{ chunk: string }>(
      `SELECT chunk FROM ${PHOTON_STATE_SCHEMA}.text_stream_chunks
        WHERE provider = $1 AND installation_id = $2 AND line_id = $3
          AND conversation_id = $4 AND idempotency_key = $5 ORDER BY chunk_index`,
      operationValues(operation),
    );
    if (
      !sameJson(
        record.chunks,
        chunks.rows.map((row) => row.chunk),
      )
    )
      throw new TypeError("text stream record and chunk rows disagree");
    return record;
  }

  const textStreams: TextStreamSessionStorePort = {
    async create(operation) {
      const record: TextStreamSessionRecord = { operation, chunks: [], state: "open", version: 1 };
      const serialized = encoded("text-stream-session", record);
      return database.transaction(async (transaction) => {
        const inserted = await transaction.query(
          `INSERT INTO ${PHOTON_STATE_SCHEMA}.text_stream_sessions(
             provider, installation_id, line_id, conversation_id, idempotency_key,
             state, entity_version, record_version, record
           ) VALUES ($1, $2, $3, $4, $5, 'open', 1, $6, $7::jsonb)
           ON CONFLICT (provider, installation_id, line_id, conversation_id, idempotency_key) DO NOTHING`,
          [...operationValues(operation), PHOTON_STATE_RECORD_VERSION, serialized],
        );
        if (resultCount(inserted) === 1) return "created";
        const current = await loadStream(transaction, operation, true);
        return current !== undefined && sameOperationPayload(current.operation, operation) ? "duplicate" : "conflict";
      });
    },
    async append(operation, expectedVersion, chunk) {
      if (chunk.length === 0) return undefined;
      return database.transaction(async (transaction) => {
        const current = await loadStream(transaction, operation, true);
        if (
          current === undefined ||
          current.state !== "open" ||
          current.version !== expectedVersion ||
          !sameOperationPayload(current.operation, operation)
        )
          return undefined;
        const next: TextStreamSessionRecord = {
          ...current,
          chunks: [...current.chunks, chunk],
          version: current.version + 1,
        };
        await transaction.query(
          `INSERT INTO ${PHOTON_STATE_SCHEMA}.text_stream_chunks(
             provider, installation_id, line_id, conversation_id, idempotency_key, chunk_index, chunk
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [...operationValues(operation), current.chunks.length, chunk],
        );
        const changed = await transaction.query(
          `UPDATE ${PHOTON_STATE_SCHEMA}.text_stream_sessions
              SET entity_version = $6, record = $7::jsonb
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3
              AND conversation_id = $4 AND idempotency_key = $5 AND entity_version = $8`,
          [...operationValues(operation), next.version, encoded("text-stream-session", next), expectedVersion],
        );
        if (resultCount(changed) !== 1) throw new Error("text stream changed during append");
        return next;
      });
    },
    async finalize(operation, expectedVersion) {
      return database.transaction(async (transaction) => {
        const current = await loadStream(transaction, operation, true);
        if (
          current === undefined ||
          current.state !== "open" ||
          current.version !== expectedVersion ||
          current.chunks.length === 0 ||
          !sameOperationPayload(current.operation, operation)
        )
          return undefined;
        const next: TextStreamSessionRecord = { ...current, state: "finalized", version: current.version + 1 };
        const changed = await transaction.query(
          `UPDATE ${PHOTON_STATE_SCHEMA}.text_stream_sessions
              SET state = 'finalized', entity_version = $6, record = $7::jsonb
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3
              AND conversation_id = $4 AND idempotency_key = $5 AND entity_version = $8 AND state = 'open'`,
          [...operationValues(operation), next.version, encoded("text-stream-session", next), expectedVersion],
        );
        return resultCount(changed) === 1 ? next : undefined;
      });
    },
    read(operation) {
      return loadStream(database, operation);
    },
  };

  const polls: PollReferenceStorePort = {
    async put(reference) {
      const serialized = encoded("poll-reference", reference);
      if (reference.version !== 1) return "conflict";
      return database.transaction(async (transaction) => {
        const values = [...conversationValues(reference.conversation), reference.pollMessageGuid];
        const inserted = await transaction.query(
          `INSERT INTO ${PHOTON_STATE_SCHEMA}.poll_references(
             provider, installation_id, line_id, conversation_id, poll_message_guid,
             entity_version, record_version, record
           ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7::jsonb)
           ON CONFLICT (provider, installation_id, line_id, conversation_id, poll_message_guid) DO NOTHING`,
          [...values, PHOTON_STATE_RECORD_VERSION, serialized],
        );
        if (resultCount(inserted) === 1) return "stored";
        const current = await selectRecord(
          transaction,
          "poll-reference",
          `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.poll_references
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3
              AND conversation_id = $4 AND poll_message_guid = $5 FOR UPDATE`,
          values,
        );
        return sameJson(current, reference) ? "duplicate" : "conflict";
      });
    },
    async replace(reference, expectedVersion) {
      const serialized = encoded("poll-reference", reference);
      if (reference.version !== expectedVersion + 1) return false;
      const result = await database.query(
        `UPDATE ${PHOTON_STATE_SCHEMA}.poll_references
            SET entity_version = $6, record = $7::jsonb
          WHERE provider = $1 AND installation_id = $2 AND line_id = $3
            AND conversation_id = $4 AND poll_message_guid = $5 AND entity_version = $8`,
        [
          ...conversationValues(reference.conversation),
          reference.pollMessageGuid,
          reference.version,
          serialized,
          expectedVersion,
        ],
      );
      return resultCount(result) === 1;
    },
    read(conversation, pollMessageGuid) {
      return selectRecord(
        database,
        "poll-reference",
        `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.poll_references
          WHERE provider = $1 AND installation_id = $2 AND line_id = $3
            AND conversation_id = $4 AND poll_message_guid = $5`,
        [...conversationValues(conversation), pollMessageGuid],
      );
    },
  };

  const cards: PublicCardHandleStorePort = {
    async put(handle) {
      const serialized = encoded("card-handle", handle);
      if (handle.version !== 1) return "conflict";
      return database.transaction(async (transaction) => {
        const values = [...conversationValues(handle.conversation), handle.cardId];
        const inserted = await transaction.query(
          `INSERT INTO ${PHOTON_STATE_SCHEMA}.card_handles(
             provider, installation_id, line_id, conversation_id, card_id,
             entity_version, record_version, record
           ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7::jsonb)
           ON CONFLICT (provider, installation_id, line_id, conversation_id, card_id) DO NOTHING`,
          [...values, PHOTON_STATE_RECORD_VERSION, serialized],
        );
        if (resultCount(inserted) === 1) return "stored";
        const current = await selectRecord(
          transaction,
          "card-handle",
          `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.card_handles
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3
              AND conversation_id = $4 AND card_id = $5 FOR UPDATE`,
          values,
        );
        return sameJson(current, handle) ? "duplicate" : "conflict";
      });
    },
    async replace(handle, expectedVersion) {
      const serialized = encoded("card-handle", handle);
      if (handle.version !== expectedVersion + 1) return false;
      return database.transaction(async (transaction) => {
        const current = await selectRecord(
          transaction,
          "card-handle",
          `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.card_handles
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3
              AND conversation_id = $4 AND card_id = $5 FOR UPDATE`,
          [...conversationValues(handle.conversation), handle.cardId],
        );
        if (
          current === undefined ||
          current.version !== expectedVersion ||
          handle.handle.session.sessionId !== current.handle.session.sessionId ||
          handle.handle.session.targetMessageGuid !== current.handle.session.targetMessageGuid
        )
          return false;
        const changed = await transaction.query(
          `UPDATE ${PHOTON_STATE_SCHEMA}.card_handles
              SET entity_version = $6, record = $7::jsonb
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3
              AND conversation_id = $4 AND card_id = $5 AND entity_version = $8`,
          [...conversationValues(handle.conversation), handle.cardId, handle.version, serialized, expectedVersion],
        );
        return resultCount(changed) === 1;
      });
    },
    read(conversation, cardId) {
      return selectRecord(
        database,
        "card-handle",
        `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.card_handles
          WHERE provider = $1 AND installation_id = $2 AND line_id = $3
            AND conversation_id = $4 AND card_id = $5`,
        [...conversationValues(conversation), cardId],
      );
    },
  };

  const actions: ActionBindingStorePort = {
    async create(binding) {
      const serialized = encoded("action-binding", binding);
      return database.transaction(async (transaction) => {
        const values = [...conversationValues(binding.conversation), binding.bindingId];
        const inserted = await transaction.query(
          `INSERT INTO ${PHOTON_STATE_SCHEMA}.action_bindings(
             provider, installation_id, line_id, conversation_id, binding_id,
             expires_at, consumed_at, record_version, record
           ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, NULL, $7, $8::jsonb)
           ON CONFLICT (provider, installation_id, line_id, conversation_id, binding_id) DO NOTHING`,
          [...values, binding.expiresAt, PHOTON_STATE_RECORD_VERSION, serialized],
        );
        if (resultCount(inserted) === 1) return "created";
        const current = await selectRecord(
          transaction,
          "action-binding",
          `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.action_bindings
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3
              AND conversation_id = $4 AND binding_id = $5 FOR UPDATE`,
          values,
        );
        return sameJson(current, binding) ? "duplicate" : "conflict";
      });
    },
    async consume(request) {
      canonicalTimestamp(request.now, "now");
      return database.transaction(async (transaction) => {
        const values = [...conversationValues(request.conversation), request.bindingId];
        const row = await transaction.query<RecordRow & { consumed_at: string | null }>(
          `SELECT record, record_version, consumed_at FROM ${PHOTON_STATE_SCHEMA}.action_bindings
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3
              AND conversation_id = $4 AND binding_id = $5 FOR UPDATE`,
          values,
        );
        const binding = decoded("action-binding", row.rows[0]);
        if (binding === undefined || row.rows[0]?.consumed_at !== null || !actionMatches(binding, request))
          return undefined;
        const changed = await transaction.query(
          `UPDATE ${PHOTON_STATE_SCHEMA}.action_bindings SET consumed_at = $6::timestamptz
            WHERE provider = $1 AND installation_id = $2 AND line_id = $3
              AND conversation_id = $4 AND binding_id = $5 AND consumed_at IS NULL`,
          [...values, request.now],
        );
        return resultCount(changed) === 1 ? binding : undefined;
      });
    },
    read(conversation, bindingId) {
      return selectRecord(
        database,
        "action-binding",
        `SELECT record, record_version FROM ${PHOTON_STATE_SCHEMA}.action_bindings
          WHERE provider = $1 AND installation_id = $2 AND line_id = $3
            AND conversation_id = $4 AND binding_id = $5`,
        [...conversationValues(conversation), bindingId],
      );
    },
  };

  return {
    installations,
    verifiedAddresses,
    chatSessions,
    messages,
    attachments,
    receipts,
    deliveries,
    textStreams,
    polls,
    cards,
    actions,
  };
}

function actionMatches(binding: ActionBinding, request: ActionBindingConsumption): boolean {
  return (
    binding.actor.actorId === request.actor.actorId &&
    binding.actor.kind === request.actor.kind &&
    binding.actor.canonicalIdentityId === request.actor.canonicalIdentityId &&
    binding.actor.providerAddress === request.actor.providerAddress &&
    binding.resource.resourceType === request.resourceType &&
    binding.resource.resourceId === request.resourceId &&
    binding.resourceRevision === request.resourceRevision &&
    binding.allowedAction === request.allowedAction &&
    binding.session.sessionId === request.sessionId &&
    sameConversation(binding.conversation, request.conversation) &&
    Date.parse(binding.expiresAt) > Date.parse(request.now)
  );
}
