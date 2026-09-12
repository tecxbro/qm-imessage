import type {
  CheckedQmChannelOperation,
  JsonObject,
  QmChannelOperationRequest,
} from "../../plugins/chassis/src/photon-contract.ts";
import { assertJsonSafe, parseCheckedQmChannelOperation } from "../../plugins/chassis/src/photon-contract.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { parseScopeId, type SurfaceContextResult, type TurnRequest } from "../types.ts";

import type { App } from "./app.ts";
import type { AuthorizedPhotonOperation, PhotonAuthorizer, PhotonOperationSource } from "./photon-authorization.ts";
import { photonOperationIdempotencyKey, photonRedeliveryKey } from "./photon-authorization.ts";

type PhotonCoreApp = Pick<
  App,
  | "ackDelivery"
  | "activeRunForThread"
  | "fulfillContextRequest"
  | "getApproval"
  | "getContextRequest"
  | "getRun"
  | "listSessionApprovals"
  | "pendingContextRequests"
  | "pendingDeliveries"
  | "signalRun"
  | "turn"
  | "withdrawRun"
>;

export interface PhotonCoreClientDeps {
  app: PhotonCoreApp;
  authorization: PhotonAuthorizer;
  deliveries: Pick<DeliveryStore, "get">;
}

export class PhotonCoreClientError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "PhotonCoreClientError";
    this.code = code;
  }
}

function jsonObject(value: unknown): JsonObject {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new PhotonCoreClientError("invalid_qm_response");
  const decoded: unknown = JSON.parse(encoded);
  assertJsonSafe(decoded, "qmResponse");
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new PhotonCoreClientError("invalid_qm_response");
  }
  return decoded as JsonObject;
}

function unchecked(operation: CheckedQmChannelOperation): QmChannelOperationRequest {
  const { authorization: _authorization, ...request } = parseCheckedQmChannelOperation(operation);
  return request as QmChannelOperationRequest;
}

function textOf(resolution: AuthorizedPhotonOperation): string {
  if (resolution.source.input.kind !== "message") throw new PhotonCoreClientError("message_source_required");
  const attachments = resolution.source.input.content.filter((part) => part.kind === "attachment");
  if (attachments.length) throw new PhotonCoreClientError("photon_attachments_not_linked");
  const text = resolution.source.input.content
    .filter(
      (part): part is Extract<(typeof resolution.source.input.content)[number], { kind: "text" }> =>
        part.kind === "text",
    )
    .map((part) => part.text)
    .join("\n");
  if (!text.trim()) throw new PhotonCoreClientError("empty_photon_turn");
  return text;
}

function turnRequest(resolution: AuthorizedPhotonOperation): TurnRequest {
  if (resolution.checked.name !== "turn.start") throw new PhotonCoreClientError("turn_start_required");
  const parsedScope = parseScopeId(resolution.session.scopeId);
  const channelRef =
    (resolution.session.type === "channel" && parsedScope.kind === "channel") ||
    (resolution.session.type === "group" && parsedScope.kind === "group")
      ? parsedScope.ref
      : undefined;
  return {
    surface: "photon",
    actor: { externalId: resolution.checked.actorId },
    conversation: {
      kind: resolution.session.type,
      threadRef: resolution.session.threadRef,
      ...(channelRef ? { channelRef } : {}),
      ...(resolution.session.channelName ? { channelName: resolution.session.channelName } : {}),
    },
    text: textOf(resolution),
    origin: { kind: "human", messageTs: photonRedeliveryKey(resolution.source.event) },
    redeliveryKey: resolution.checked.input.redeliveryKey,
    async: true,
    clientSentAt: Date.parse(resolution.source.event.occurredAt),
  };
}

function runOperation(
  operation: QmChannelOperationRequest,
): operation is Extract<QmChannelOperationRequest, { name: "turn.steer" | "run.signal" }> {
  return operation.name === "turn.steer" || operation.name === "run.signal";
}

export interface PhotonCoreClient {
  check(source: PhotonOperationSource, operation: QmChannelOperationRequest): Promise<CheckedQmChannelOperation>;
  execute(source: PhotonOperationSource, operation: CheckedQmChannelOperation): Promise<JsonObject>;
  getRun(source: PhotonOperationSource, operation: QmChannelOperationRequest): Promise<JsonObject | null>;
  activeRun(source: PhotonOperationSource, operation: QmChannelOperationRequest): Promise<JsonObject>;
  withdrawRun(source: PhotonOperationSource, operation: QmChannelOperationRequest): Promise<JsonObject>;
  getApproval(source: PhotonOperationSource, operation: QmChannelOperationRequest): Promise<JsonObject | null>;
  listSessionApprovals(source: PhotonOperationSource, operation: QmChannelOperationRequest): Promise<JsonObject>;
  pendingDeliveries(claimMs?: number): Promise<JsonObject>;
  ackDelivery(id: string): Promise<JsonObject>;
  pendingContextRequests(): Promise<JsonObject>;
  fulfillContextRequest(id: string, outcome: { result?: SurfaceContextResult; error?: string }): Promise<JsonObject>;
}

export function createPhotonCoreClient(deps: PhotonCoreClientDeps): PhotonCoreClient {
  return {
    check(source, operation) {
      return deps.authorization.check(source, operation);
    },

    async execute(source, supplied) {
      const operation = unchecked(supplied);
      const authorized = await deps.authorization.authorize(source, operation, {
        consumeAction: operation.name === "approval.resolve",
      });
      if (authorized.checked.name === "turn.start") return jsonObject(await deps.app.turn(turnRequest(authorized)));
      if (authorized.checked.name === "turn.steer") {
        return jsonObject(
          await deps.app.signalRun(
            authorized.checked.input.runId,
            {
              kind: "steer",
              text: authorized.checked.input.text,
              ts: photonRedeliveryKey(authorized.source.event),
              dedupeKey: photonOperationIdempotencyKey(authorized.source, authorized.checked.idempotencyKey),
            },
            authorized.checked.actorId,
          ),
        );
      }
      if (authorized.checked.name === "run.signal") {
        return jsonObject(
          await deps.app.signalRun(
            authorized.checked.input.runId,
            {
              kind: authorized.checked.input.signal,
              ...(authorized.checked.input.text ? { text: authorized.checked.input.text } : {}),
              ts: photonRedeliveryKey(authorized.source.event),
              dedupeKey: photonOperationIdempotencyKey(authorized.source, authorized.checked.idempotencyKey),
            },
            authorized.checked.actorId,
          ),
        );
      }
      if (authorized.checked.name === "approval.resolve") {
        const approval = authorized.approval;
        const action = authorized.action;
        if (!approval?.request || !action) throw new PhotonCoreClientError("approval_not_authorized");
        return jsonObject(
          await deps.app.turn({
            ...approval.request,
            surface: "photon",
            actor: { externalId: authorized.checked.actorId },
            conversation: {
              kind: authorized.session.type,
              threadRef: authorized.session.threadRef,
              ...(approval.request.conversation.channelRef
                ? { channelRef: approval.request.conversation.channelRef }
                : {}),
            },
            approval: {
              requestId: action.resource.resourceId,
              approved: authorized.checked.input.decision === "approve",
            },
            idempotencyKey: photonOperationIdempotencyKey(authorized.source, authorized.checked.idempotencyKey),
            redeliveryKey: undefined,
            async: true,
          }),
        );
      }
      throw new PhotonCoreClientError("operation_not_implemented");
    },

    async getRun(source, operation) {
      if (!runOperation(operation)) throw new PhotonCoreClientError("run_operation_required");
      await deps.authorization.authorize(source, operation);
      const found = await deps.app.getRun(operation.input.runId, operation.actorId);
      return found ? jsonObject(found) : null;
    },

    async activeRun(source, operation) {
      const authorized = await deps.authorization.authorize(source, operation);
      const active = await deps.app.activeRunForThread(authorized.session.threadRef, operation.actorId);
      return jsonObject({
        runId: active?.runId ?? null,
        ...(active?.queued ? { queued: active.queued } : {}),
      });
    },

    async withdrawRun(source, operation) {
      if (!runOperation(operation)) throw new PhotonCoreClientError("run_operation_required");
      await deps.authorization.authorize(source, operation);
      return jsonObject(await deps.app.withdrawRun(operation.input.runId, operation.actorId));
    },

    async getApproval(source, operation) {
      if (operation.name !== "approval.resolve") throw new PhotonCoreClientError("approval_operation_required");
      const authorized = await deps.authorization.authorize(source, operation);
      const approval = authorized.approval;
      if (!approval || !authorized.action) return null;
      return jsonObject({
        requestId: authorized.action.resource.resourceId,
        command: approval.command,
        ...(approval.reason ? { reason: approval.reason } : {}),
        ...(approval.purpose ? { purpose: approval.purpose } : {}),
        ...(approval.summary ? { summary: approval.summary } : {}),
        ...(approval.summaryDetail ? { summaryDetail: approval.summaryDetail } : {}),
        ...(approval.grantModes ? { grantModes: approval.grantModes } : {}),
        ...(approval.blocksInput !== undefined ? { blocksInput: approval.blocksInput } : {}),
        ...(approval.kind ? { kind: approval.kind } : {}),
      });
    },

    async listSessionApprovals(source, operation) {
      const authorized = await deps.authorization.authorize(source, operation);
      return jsonObject({
        approvals: await deps.app.listSessionApprovals(authorized.session.id, operation.actorId),
      });
    },

    async pendingDeliveries(claimMs) {
      return jsonObject({ deliveries: await deps.app.pendingDeliveries("photon", claimMs) });
    },

    async ackDelivery(id) {
      const delivery = await deps.deliveries.get(id);
      if (!delivery || delivery.destination.type !== "photon") {
        throw new PhotonCoreClientError("delivery_not_authorized");
      }
      await deps.app.ackDelivery(id);
      return jsonObject({ ok: true });
    },

    async pendingContextRequests() {
      return jsonObject({ requests: await deps.app.pendingContextRequests("photon") });
    },

    async fulfillContextRequest(id, outcome) {
      const request = await deps.app.getContextRequest(id);
      if (!request || request.source !== "photon") {
        throw new PhotonCoreClientError("context_request_not_authorized");
      }
      return jsonObject({ fulfilled: await deps.app.fulfillContextRequest(id, outcome) });
    },
  };
}
