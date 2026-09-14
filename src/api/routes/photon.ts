import type {
  CheckedQmChannelOperation,
  QmChannelOperationRequest,
} from "../../../plugins/chassis/src/photon-contract.ts";
import type { SurfaceContextResult } from "../../types.ts";
import { sendJson } from "../http.ts";
import {
  PhotonAuthorizationError,
  parsePhotonOperationEnvelope,
  type PhotonOperationSource,
} from "../photon-authorization.ts";
import { PhotonCoreClientError, type PhotonCoreClient } from "../photon-core-client.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

export interface PhotonRouteDeps {
  core: PhotonCoreClient | ((ctx: ApiCtx) => PhotonCoreClient | undefined);
}

class PhotonUnavailableError extends Error {}

function coreFor(deps: PhotonRouteDeps, ctx: ApiCtx): PhotonCoreClient {
  const core = typeof deps.core === "function" ? deps.core(ctx) : deps.core;
  if (core === undefined) throw new PhotonUnavailableError("photon_not_configured");
  return core;
}

type PhotonEnvelope = { source: PhotonOperationSource; operation: QmChannelOperationRequest };
type CheckedPhotonEnvelope = { source: PhotonOperationSource; operation: CheckedQmChannelOperation };

function envelope(body: unknown): PhotonEnvelope {
  return parsePhotonOperationEnvelope(body) as PhotonEnvelope;
}

function checkedEnvelope(body: unknown): CheckedPhotonEnvelope {
  return parsePhotonOperationEnvelope(body, true) as CheckedPhotonEnvelope;
}

function photonError(res: ApiCtx["res"], error: unknown): boolean {
  if (error instanceof PhotonUnavailableError) {
    sendJson(res, 503, { error: "unavailable", code: "photon_not_configured" });
    return true;
  }
  if (error instanceof PhotonAuthorizationError) {
    sendJson(res, 403, { error: "forbidden", code: error.code });
    return true;
  }
  if (error instanceof PhotonCoreClientError) {
    sendJson(res, 422, { error: "unprocessable", code: error.code });
    return true;
  }
  if (error instanceof TypeError) {
    sendJson(res, 400, { error: "bad_request", message: error.message });
    return true;
  }
  return false;
}

function handled(fn: (ctx: ApiCtx) => Promise<void>): (ctx: ApiCtx) => Promise<void> {
  return async (ctx) => {
    try {
      await fn(ctx);
    } catch (error) {
      if (!photonError(ctx.res, error)) throw error;
    }
  };
}

function runIdOf(operation: QmChannelOperationRequest): string | undefined {
  if (operation.name === "turn.steer" || operation.name === "run.signal") return operation.input.runId;
  return undefined;
}

function contextOutcome(body: unknown): { result?: SurfaceContextResult; error?: string } {
  const input = isObj(body) ? body : {};
  if (typeof input.error === "string") return { error: input.error };
  const fileInput = isObj(input.file) ? input.file : undefined;
  const file =
    fileInput &&
    typeof fileInput.blobId === "string" &&
    typeof fileInput.name === "string" &&
    typeof fileInput.sizeBytes === "number"
      ? {
          blobId: fileInput.blobId,
          name: fileInput.name,
          sizeBytes: fileInput.sizeBytes,
          ...(typeof fileInput.mimetype === "string" ? { mimetype: fileInput.mimetype } : {}),
          ...(typeof fileInput.author === "string" ? { author: fileInput.author } : {}),
        }
      : undefined;
  const groupInput = isObj(input.group) ? input.group : undefined;
  const group =
    groupInput && typeof groupInput.groupId === "string" && groupInput.groupId
      ? { groupId: groupInput.groupId }
      : undefined;
  return {
    result: {
      messages: Array.isArray(input.messages) ? input.messages : [],
      ...(typeof input.hasMore === "boolean" ? { hasMore: input.hasMore } : {}),
      ...(typeof input.nextBefore === "string" ? { nextBefore: input.nextBefore } : {}),
      ...(typeof input.note === "string" ? { note: input.note } : {}),
      ...(file ? { file } : {}),
      ...(group ? { group } : {}),
    },
  };
}

export function createPhotonRoutes(deps: PhotonRouteDeps): ReadonlyArray<Route<ApiCtx>> {
  return [
    {
      method: "POST",
      path: "/v1/photon/channel/check",
      auth: "source",
      handle: handled(async (ctx) => {
        const request = envelope(ctx.body);
        sendJson(ctx.res, 200, await coreFor(deps, ctx).check(request.source, request.operation));
      }),
    },
    {
      method: "POST",
      path: "/v1/photon/channel/execute",
      auth: "source",
      handle: handled(async (ctx) => {
        const request = checkedEnvelope(ctx.body);
        sendJson(ctx.res, 200, await coreFor(deps, ctx).execute(request.source, request.operation));
      }),
    },
    {
      method: "POST",
      path: "/v1/photon/runs/:id/read",
      auth: "source",
      handle: handled(async (ctx) => {
        const request = envelope(ctx.body);
        if (runIdOf(request.operation) !== ctx.params.id) throw new TypeError("run id does not match operation");
        const run = await coreFor(deps, ctx).getRun(request.source, request.operation);
        if (!run) return sendJson(ctx.res, 404, { error: "not_found" });
        sendJson(ctx.res, 200, run);
      }),
    },
    {
      method: "POST",
      path: "/v1/photon/runs/active",
      auth: "source",
      handle: handled(async (ctx) => {
        const request = envelope(ctx.body);
        sendJson(ctx.res, 200, await coreFor(deps, ctx).activeRun(request.source, request.operation));
      }),
    },
    {
      method: "POST",
      path: "/v1/photon/runs/:id/withdraw",
      auth: "source",
      handle: handled(async (ctx) => {
        const request = envelope(ctx.body);
        if (runIdOf(request.operation) !== ctx.params.id) throw new TypeError("run id does not match operation");
        sendJson(ctx.res, 200, await coreFor(deps, ctx).withdrawRun(request.source, request.operation));
      }),
    },
    {
      method: "POST",
      path: "/v1/photon/approvals/read",
      auth: "source",
      handle: handled(async (ctx) => {
        const request = envelope(ctx.body);
        const approval = await coreFor(deps, ctx).getApproval(request.source, request.operation);
        if (!approval) return sendJson(ctx.res, 404, { error: "not_found" });
        sendJson(ctx.res, 200, approval);
      }),
    },
    {
      method: "POST",
      path: "/v1/photon/sessions/:id/approvals",
      auth: "source",
      handle: handled(async (ctx) => {
        const request = envelope(ctx.body);
        if (request.operation.sessionId !== ctx.params.id) throw new TypeError("session id does not match operation");
        sendJson(ctx.res, 200, await coreFor(deps, ctx).listSessionApprovals(request.source, request.operation));
      }),
    },
    {
      method: "GET",
      path: "/v1/photon/deliveries",
      auth: "source",
      handle: handled(async (ctx) => {
        const raw = Number(ctx.url.searchParams.get("claimMs") ?? 0);
        const claimMs = Number.isFinite(raw) && raw > 0 ? raw : undefined;
        sendJson(ctx.res, 200, await coreFor(deps, ctx).pendingDeliveries(claimMs));
      }),
    },
    {
      method: "POST",
      path: "/v1/photon/deliveries/:id/ack",
      auth: "source",
      handle: handled(async (ctx) => {
        sendJson(ctx.res, 200, await coreFor(deps, ctx).ackDelivery(ctx.params.id!));
      }),
    },
    {
      method: "GET",
      path: "/v1/photon/context-requests",
      auth: "source",
      handle: handled(async (ctx) => {
        sendJson(ctx.res, 200, await coreFor(deps, ctx).pendingContextRequests());
      }),
    },
    {
      method: "POST",
      path: "/v1/photon/context-requests/:id/result",
      auth: "source",
      handle: handled(async (ctx) => {
        const result = await coreFor(deps, ctx).fulfillContextRequest(ctx.params.id!, contextOutcome(ctx.body));
        sendJson(ctx.res, result.fulfilled === true ? 200 : 404, result);
      }),
    },
  ];
}
