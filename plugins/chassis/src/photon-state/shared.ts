import type { ProviderEventKey, ProviderLineScope } from "../../../photon/src/ports.ts";
import type { ConversationReference, PhotonPresentationOperation } from "../photon-contract.ts";
import {
  PHOTON_STATE_RECORD_VERSION,
  canonicalJson,
  parsePhotonStateRecord,
  sameJson,
  serializePhotonStateRecord,
  type PhotonStateRecordKind,
} from "../photon-state-records.ts";

import type { PhotonStateQueryResult, PhotonStateTransaction } from "./db.ts";

export { PHOTON_STATE_RECORD_VERSION, sameJson };

export type RecordRow = { record: unknown; record_version: number };

export function encoded<Kind extends PhotonStateRecordKind>(
  kind: Kind,
  value: Parameters<typeof serializePhotonStateRecord<Kind>>[1],
): string {
  return JSON.stringify(serializePhotonStateRecord(kind, value));
}

export function decoded<Kind extends PhotonStateRecordKind>(
  kind: Kind,
  row: RecordRow | undefined,
): ReturnType<typeof parsePhotonStateRecord<Kind>> | undefined {
  if (row === undefined) return undefined;
  if (Number(row.record_version) !== PHOTON_STATE_RECORD_VERSION)
    throw new TypeError(`${kind} row version is unsupported`);
  return parsePhotonStateRecord(kind, row.record);
}

export function resultCount(result: PhotonStateQueryResult): number {
  return Number(result.rowCount ?? result.rows.length);
}

export function canonicalTimestamp(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return milliseconds;
}

export function nonempty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`${label} must be a non-empty string`);
}

export function conversationValues(conversation: ConversationReference): readonly string[] {
  return [conversation.provider, conversation.installationId, conversation.lineId, conversation.conversationId];
}

export function operationValues(operation: PhotonPresentationOperation): readonly string[] {
  return [...conversationValues(operation.conversation), operation.idempotencyKey];
}

export function eventValues(key: ProviderEventKey): readonly string[] {
  return [key.provider, key.installationId, key.lineId ?? "", key.eventId];
}

export function scopeValues(scope: ProviderLineScope): readonly string[] {
  return [scope.provider, scope.installationId, scope.lineId];
}

export function advisoryKey(scope: readonly string[]): string {
  return canonicalJson(scope);
}

export async function selectRecord<Kind extends PhotonStateRecordKind>(
  database: PhotonStateTransaction,
  kind: Kind,
  text: string,
  params: readonly unknown[],
): Promise<ReturnType<typeof parsePhotonStateRecord<Kind>> | undefined> {
  const result = await database.query<RecordRow>(text, params);
  return decoded(kind, result.rows[0]);
}
