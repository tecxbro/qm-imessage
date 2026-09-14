import type {
  ActionBindingConsumption,
  ActionBindingStorePort,
  AttachmentRecord,
  AttachmentStorePort,
  ChatSessionBindingStorePort,
  MessageBindingStorePort,
  PhotonInstallationCiphertextStore,
  PhotonLineOwnerStore,
  PollReferenceStorePort,
  PublicCardHandleStorePort,
  RecoverableEventReceiptStorePort,
  RecoverableDeliveryOperationStorePort,
  TextStreamSessionRecord,
  TextStreamSessionStorePort,
  VerifiedAddressChallenge,
  VerifiedAddressStorePort,
} from "../../photon/src/ports.ts";
import type { ActionBinding, PhotonPresentationOperation } from "./photon-contract.ts";
import { sameConversation, sameOperationPayload } from "./photon-state-records.ts";
import { PHOTON_STATE_SCHEMA } from "./photon-state-schema.ts";
import { createPhotonBindingStores } from "./photon-state/bindings.ts";
import { createPhotonDeliveryStore } from "./photon-state/deliveries.ts";
import type { PhotonStateDatabase, PhotonStateTransaction } from "./photon-state/db.ts";
import { createPhotonReceiptStore } from "./photon-state/receipts.ts";
import { createPhotonLineOwnerStore } from "./photon-state/line-owner.ts";
import {
  PHOTON_STATE_RECORD_VERSION,
  canonicalTimestamp,
  conversationValues,
  decoded,
  encoded,
  nonempty,
  operationValues,
  resultCount,
  sameJson,
  selectRecord,
  type RecordRow,
} from "./photon-state/shared.ts";

export type { PhotonStateDatabase, PhotonStateQueryResult, PhotonStateTransaction } from "./photon-state/db.ts";

export interface PhotonStateStores {
  installations: PhotonInstallationCiphertextStore;
  verifiedAddresses: VerifiedAddressStorePort;
  chatSessions: ChatSessionBindingStorePort;
  messages: MessageBindingStorePort;
  attachments: AttachmentStorePort;
  receipts: RecoverableEventReceiptStorePort;
  deliveries: RecoverableDeliveryOperationStorePort;
  textStreams: TextStreamSessionStorePort;
  polls: PollReferenceStorePort;
  cards: PublicCardHandleStorePort;
  actions: ActionBindingStorePort;
  lineOwners: PhotonLineOwnerStore;
}

export function createPostgresPhotonStateStores(database: PhotonStateDatabase): PhotonStateStores {
  const installations: PhotonInstallationCiphertextStore = {
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
        [record.installationId, record.version, PHOTON_STATE_RECORD_VERSION, serialized],
      );
      return resultCount(result) === 1;
    },
    async compareAndSet(installationId, expectedVersion, next) {
      const serialized = encoded("installation", next);
      if (next.installationId !== installationId || next.version !== expectedVersion + 1) return false;
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

  const { chatSessions, messages } = createPhotonBindingStores(database);
  const receipts = createPhotonReceiptStore(database);
  const deliveries = createPhotonDeliveryStore(database);

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
    lineOwners: createPhotonLineOwnerStore(database),
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
