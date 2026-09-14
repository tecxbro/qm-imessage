import type { ChatSessionBindingStorePort, MessageBindingStorePort } from "../../../photon/src/ports.ts";
import { PHOTON_STATE_SCHEMA } from "../photon-state-schema.ts";

import type { PhotonStateDatabase } from "./db.ts";
import {
  PHOTON_STATE_RECORD_VERSION,
  advisoryKey,
  conversationValues,
  decoded,
  encoded,
  nonempty,
  resultCount,
  sameJson,
  selectRecord,
  type RecordRow,
} from "./shared.ts";

export interface PhotonBindingStores {
  chatSessions: ChatSessionBindingStorePort;
  messages: MessageBindingStorePort;
}

export function createPhotonBindingStores(database: PhotonStateDatabase): PhotonBindingStores {
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

  return { chatSessions, messages };
}
