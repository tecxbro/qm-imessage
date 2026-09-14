export const PHOTON_STATE_SCHEMA = "qm_photon_state";
export const PHOTON_ADAPTER_DATABASE_ROLE = "qm_photon_adapter";
export const PHOTON_CORE_LINK_DATABASE_ROLE = "qm_photon_core_link";

export interface PhotonStateMigrationDefinition {
  id: string;
  statements: readonly string[];
}

export const PHOTON_STATE_MIGRATION: PhotonStateMigrationDefinition = {
  id: "photon/state/0001",
  statements: [
    `DO $role$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PHOTON_ADAPTER_DATABASE_ROLE}') THEN
        CREATE ROLE ${PHOTON_ADAPTER_DATABASE_ROLE} NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PHOTON_CORE_LINK_DATABASE_ROLE}') THEN
        CREATE ROLE ${PHOTON_CORE_LINK_DATABASE_ROLE} NOLOGIN;
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_roles
        WHERE rolname IN ('${PHOTON_ADAPTER_DATABASE_ROLE}', '${PHOTON_CORE_LINK_DATABASE_ROLE}')
          AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
      ) THEN
        RAISE EXCEPTION 'Photon state group roles have unsafe attributes';
      END IF;
    END $role$`,
    `CREATE SCHEMA IF NOT EXISTS ${PHOTON_STATE_SCHEMA}`,
    `REVOKE ALL ON SCHEMA ${PHOTON_STATE_SCHEMA} FROM PUBLIC`,
    `CREATE TABLE IF NOT EXISTS ${PHOTON_STATE_SCHEMA}.installations(
      installation_id TEXT PRIMARY KEY,
      entity_version INTEGER NOT NULL CHECK (entity_version > 0),
      record_version SMALLINT NOT NULL CHECK (record_version > 0),
      record JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${PHOTON_STATE_SCHEMA}.verified_address_challenges(
      challenge_id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      entity_version INTEGER NOT NULL CHECK (entity_version > 0),
      expires_at TIMESTAMPTZ NOT NULL,
      verified_at TIMESTAMPTZ,
      record_version SMALLINT NOT NULL CHECK (record_version > 0),
      record JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS verified_address_challenges_installation_expiry
      ON ${PHOTON_STATE_SCHEMA}.verified_address_challenges(installation_id, expires_at, challenge_id)`,
    `CREATE TABLE IF NOT EXISTS ${PHOTON_STATE_SCHEMA}.chat_session_bindings(
      provider TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      record_version SMALLINT NOT NULL CHECK (record_version > 0),
      record JSONB NOT NULL,
      PRIMARY KEY(provider, installation_id, line_id, conversation_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${PHOTON_STATE_SCHEMA}.message_bindings(
      provider TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      provider_message_id TEXT NOT NULL,
      qm_session_id TEXT NOT NULL,
      qm_entry_sequence INTEGER NOT NULL CHECK (qm_entry_sequence >= 0),
      record_version SMALLINT NOT NULL CHECK (record_version > 0),
      record JSONB NOT NULL,
      PRIMARY KEY(provider, installation_id, line_id, conversation_id, provider_message_id)
    )`,
    `CREATE INDEX IF NOT EXISTS message_bindings_qm_entry
      ON ${PHOTON_STATE_SCHEMA}.message_bindings(qm_session_id, qm_entry_sequence)`,
    `CREATE TABLE IF NOT EXISTS ${PHOTON_STATE_SCHEMA}.message_binding_parts(
      provider TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      part_message_id TEXT NOT NULL,
      part_index INTEGER NOT NULL CHECK (part_index >= 0),
      provider_message_id TEXT NOT NULL,
      PRIMARY KEY(provider, installation_id, line_id, conversation_id, part_message_id, part_index),
      FOREIGN KEY(provider, installation_id, line_id, conversation_id, provider_message_id)
        REFERENCES ${PHOTON_STATE_SCHEMA}.message_bindings(
          provider, installation_id, line_id, conversation_id, provider_message_id
        ) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ${PHOTON_STATE_SCHEMA}.attachments(
      provider TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      part_index INTEGER NOT NULL CHECK (part_index >= 0),
      attachment_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('available', 'released')),
      record_version SMALLINT NOT NULL CHECK (record_version > 0),
      record JSONB NOT NULL,
      PRIMARY KEY(provider, installation_id, line_id, conversation_id, message_id, part_index, attachment_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${PHOTON_STATE_SCHEMA}.event_receipts(
      provider TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      sequence BIGINT CHECK (sequence >= 0 AND sequence <= 9007199254740991),
      state TEXT NOT NULL CHECK (state IN ('captured', 'processing', 'checkpointed', 'rejected')),
      claim_fence BIGINT NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
      claim_expires_at TIMESTAMPTZ,
      captured_at TIMESTAMPTZ NOT NULL,
      terminal_at TIMESTAMPTZ,
      record_version SMALLINT NOT NULL CHECK (record_version > 0),
      record JSONB NOT NULL,
      PRIMARY KEY(provider, installation_id, line_id, event_id)
    )`,
    `CREATE INDEX IF NOT EXISTS event_receipts_discovery
      ON ${PHOTON_STATE_SCHEMA}.event_receipts(
        provider, installation_id, line_id, state, sequence, captured_at, event_id
      )`,
    `CREATE INDEX IF NOT EXISTS event_receipts_expired_claims
      ON ${PHOTON_STATE_SCHEMA}.event_receipts(claim_expires_at)
      WHERE state = 'processing'`,
    `CREATE TABLE IF NOT EXISTS ${PHOTON_STATE_SCHEMA}.checkpoints(
      provider TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      sequence BIGINT NOT NULL CHECK (sequence >= 0 AND sequence <= 9007199254740991),
      entity_version INTEGER NOT NULL CHECK (entity_version > 0),
      record_version SMALLINT NOT NULL CHECK (record_version > 0),
      record JSONB NOT NULL,
      PRIMARY KEY(provider, installation_id, line_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${PHOTON_STATE_SCHEMA}.delivery_operations(
      provider TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatched', 'confirmed', 'unsupported', 'ambiguous', 'failed')),
      dispatch_fence BIGINT NOT NULL CHECK (dispatch_fence >= 0),
      entity_version INTEGER NOT NULL CHECK (entity_version > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      record_version SMALLINT NOT NULL CHECK (record_version > 0),
      record JSONB NOT NULL,
      PRIMARY KEY(provider, installation_id, line_id, conversation_id, idempotency_key)
    )`,
    `CREATE INDEX IF NOT EXISTS delivery_operations_discovery
      ON ${PHOTON_STATE_SCHEMA}.delivery_operations(
        provider, installation_id, line_id, state, updated_at, idempotency_key
      )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS delivery_operations_attempt
      ON ${PHOTON_STATE_SCHEMA}.delivery_operations(
        provider, installation_id, line_id, conversation_id, operation_id, attempt_id
      )`,
    `CREATE TABLE IF NOT EXISTS ${PHOTON_STATE_SCHEMA}.delivery_parts(
      provider TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      part_index INTEGER NOT NULL CHECK (part_index >= 0),
      part_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatched', 'confirmed', 'unsupported', 'ambiguous', 'failed')),
      dispatch_fence BIGINT NOT NULL CHECK (dispatch_fence >= 0),
      provider_part JSONB,
      PRIMARY KEY(provider, installation_id, line_id, conversation_id, idempotency_key, part_index),
      FOREIGN KEY(provider, installation_id, line_id, conversation_id, idempotency_key)
        REFERENCES ${PHOTON_STATE_SCHEMA}.delivery_operations(
          provider, installation_id, line_id, conversation_id, idempotency_key
        ) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ${PHOTON_STATE_SCHEMA}.text_stream_sessions(
      provider TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'finalized')),
      entity_version INTEGER NOT NULL CHECK (entity_version > 0),
      record_version SMALLINT NOT NULL CHECK (record_version > 0),
      record JSONB NOT NULL,
      PRIMARY KEY(provider, installation_id, line_id, conversation_id, idempotency_key)
    )`,
    `CREATE TABLE IF NOT EXISTS ${PHOTON_STATE_SCHEMA}.text_stream_chunks(
      provider TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
      chunk TEXT NOT NULL CHECK (length(chunk) > 0),
      PRIMARY KEY(provider, installation_id, line_id, conversation_id, idempotency_key, chunk_index),
      FOREIGN KEY(provider, installation_id, line_id, conversation_id, idempotency_key)
        REFERENCES ${PHOTON_STATE_SCHEMA}.text_stream_sessions(
          provider, installation_id, line_id, conversation_id, idempotency_key
        ) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ${PHOTON_STATE_SCHEMA}.poll_references(
      provider TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      poll_message_guid TEXT NOT NULL,
      entity_version INTEGER NOT NULL CHECK (entity_version > 0),
      record_version SMALLINT NOT NULL CHECK (record_version > 0),
      record JSONB NOT NULL,
      PRIMARY KEY(provider, installation_id, line_id, conversation_id, poll_message_guid)
    )`,
    `CREATE TABLE IF NOT EXISTS ${PHOTON_STATE_SCHEMA}.card_handles(
      provider TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      entity_version INTEGER NOT NULL CHECK (entity_version > 0),
      record_version SMALLINT NOT NULL CHECK (record_version > 0),
      record JSONB NOT NULL,
      PRIMARY KEY(provider, installation_id, line_id, conversation_id, card_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${PHOTON_STATE_SCHEMA}.action_bindings(
      provider TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      record_version SMALLINT NOT NULL CHECK (record_version > 0),
      record JSONB NOT NULL,
      PRIMARY KEY(provider, installation_id, line_id, conversation_id, binding_id)
    )`,
    `CREATE INDEX IF NOT EXISTS action_bindings_expiry
      ON ${PHOTON_STATE_SCHEMA}.action_bindings(expires_at) WHERE consumed_at IS NULL`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${PHOTON_STATE_SCHEMA} FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA ${PHOTON_STATE_SCHEMA}
      TO ${PHOTON_ADAPTER_DATABASE_ROLE}, ${PHOTON_CORE_LINK_DATABASE_ROLE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${PHOTON_STATE_SCHEMA}
      TO ${PHOTON_ADAPTER_DATABASE_ROLE}`,
    `GRANT SELECT, INSERT, UPDATE ON
      ${PHOTON_STATE_SCHEMA}.chat_session_bindings,
      ${PHOTON_STATE_SCHEMA}.message_bindings,
      ${PHOTON_STATE_SCHEMA}.message_binding_parts
      TO ${PHOTON_CORE_LINK_DATABASE_ROLE}`,
  ],
};

export const PHOTON_STATE_REPAIR_MIGRATION: PhotonStateMigrationDefinition = {
  id: "photon/state/0002",
  statements: [
    `ALTER TABLE ${PHOTON_STATE_SCHEMA}.chat_session_bindings
      ADD COLUMN binding_version BIGINT NOT NULL DEFAULT 1
      CHECK (binding_version >= 1 AND binding_version <= 9007199254740991)`,
    `ALTER TABLE ${PHOTON_STATE_SCHEMA}.delivery_operations
      ADD COLUMN dispatch_owner_id TEXT,
      ADD COLUMN dispatch_lease_expires_at TIMESTAMPTZ,
      ADD CONSTRAINT delivery_operations_dispatch_claim_complete CHECK (
        (dispatch_owner_id IS NULL AND dispatch_lease_expires_at IS NULL)
        OR (dispatch_owner_id IS NOT NULL AND dispatch_lease_expires_at IS NOT NULL)
      )`,
    `CREATE INDEX IF NOT EXISTS delivery_operations_recovery
      ON ${PHOTON_STATE_SCHEMA}.delivery_operations(
        provider, installation_id, line_id, updated_at, conversation_id, idempotency_key
      )
      WHERE state = 'reserved' OR state = 'dispatched'`,
    `CREATE TABLE ${PHOTON_STATE_SCHEMA}.line_owners(
      installation_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      fence BIGINT NOT NULL CHECK (fence > 0 AND fence <= 9007199254740991),
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(installation_id, line_id)
    )`,
    `REVOKE ALL ON ${PHOTON_STATE_SCHEMA}.line_owners FROM PUBLIC`,
    `GRANT SELECT, INSERT, UPDATE ON ${PHOTON_STATE_SCHEMA}.line_owners TO ${PHOTON_ADAPTER_DATABASE_ROLE}`,
    `GRANT SELECT, INSERT, UPDATE ON
      ${PHOTON_STATE_SCHEMA}.chat_session_bindings,
      ${PHOTON_STATE_SCHEMA}.delivery_operations,
      ${PHOTON_STATE_SCHEMA}.delivery_parts
      TO ${PHOTON_ADAPTER_DATABASE_ROLE}`,
    `GRANT SELECT ON ${PHOTON_STATE_SCHEMA}.action_bindings TO ${PHOTON_CORE_LINK_DATABASE_ROLE}`,
    `GRANT UPDATE(consumed_at) ON ${PHOTON_STATE_SCHEMA}.action_bindings TO ${PHOTON_CORE_LINK_DATABASE_ROLE}`,
  ],
};

export const PHOTON_STATE_MIGRATIONS: readonly PhotonStateMigrationDefinition[] = [
  PHOTON_STATE_MIGRATION,
  PHOTON_STATE_REPAIR_MIGRATION,
];
