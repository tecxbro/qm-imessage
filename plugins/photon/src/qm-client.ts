import type {
  CheckedQmChannelOperation,
  JsonObject,
  NormalizedPhotonInput,
  QmChannelOperationRequest,
} from "../../chassis/src/photon-contract.ts";
import { parseCheckedQmChannelOperation, parseQmChannelOperationRequest } from "../../chassis/src/photon-contract.ts";
import { signedHeaders, withSourceAuthNonce } from "../../chassis/src/core-client.ts";

export type PhotonQmSource = NormalizedPhotonInput;

export interface PhotonQmClientDeps {
  coreUrl: string;
  signingSecret: string;
  fetch?: typeof fetch;
  readAttempts?: number;
}

export class PhotonQmClientError extends Error {
  readonly status: number | undefined;
  readonly code: string;
  readonly outcome: "confirmed-failure" | "unknown-outcome";

  constructor(
    code: string,
    message: string,
    options: { status?: number; outcome?: "confirmed-failure" | "unknown-outcome" } = {},
  ) {
    super(message);
    this.name = "PhotonQmClientError";
    this.code = code;
    this.status = options.status;
    this.outcome = options.outcome ?? "confirmed-failure";
  }
}

function record(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PhotonQmClientError("bad_core_response", "QM returned a non-object response");
  }
  return value as JsonObject;
}

function messageOf(value: JsonObject, fallback: string): string {
  return typeof value.message === "string" ? value.message : fallback;
}

export interface PhotonQmClient {
  check(operation: QmChannelOperationRequest): Promise<CheckedQmChannelOperation>;
  execute(operation: CheckedQmChannelOperation): Promise<JsonObject>;
  getRun(operation: QmChannelOperationRequest): Promise<JsonObject | null>;
  activeRun(operation: QmChannelOperationRequest): Promise<JsonObject>;
  withdrawRun(operation: QmChannelOperationRequest): Promise<JsonObject>;
  getApproval(operation: QmChannelOperationRequest): Promise<JsonObject | null>;
  listSessionApprovals(operation: QmChannelOperationRequest): Promise<JsonObject>;
  pendingDeliveries(claimMs?: number): Promise<JsonObject>;
  ackDelivery(id: string): Promise<JsonObject>;
  pendingContextRequests(): Promise<JsonObject>;
  fulfillContextRequest(id: string, outcome: JsonObject): Promise<JsonObject>;
}

export function createPhotonQmClient(deps: PhotonQmClientDeps, source: PhotonQmSource): PhotonQmClient {
  const coreUrl = deps.coreUrl.replace(/\/$/, "");
  const requestFetch = deps.fetch ?? fetch;
  const readAttempts = Math.max(1, deps.readAttempts ?? 3);

  async function request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    options: { attempts?: number; unknownOnTransportFailure?: boolean } = {},
  ): Promise<{ status: number; body: JsonObject }> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const attempts = Math.max(1, options.attempts ?? 1);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const signedPath = withSourceAuthNonce(path, deps.signingSecret);
      try {
        const response = await requestFetch(`${coreUrl}${signedPath}`, {
          method,
          headers: signedHeaders(deps.signingSecret, method, signedPath, raw),
          ...(raw ? { body: raw } : {}),
        });
        const text = await response.text();
        let parsed: JsonObject | undefined;
        try {
          parsed = record(text ? JSON.parse(text) : {});
        } catch {
          parsed = undefined;
        }
        if (response.ok) {
          if (!parsed) {
            throw new PhotonQmClientError("bad_core_response", "QM returned invalid JSON", {
              status: response.status,
              outcome: options.unknownOnTransportFailure ? "unknown-outcome" : "confirmed-failure",
            });
          }
          return { status: response.status, body: parsed };
        }
        if (response.status >= 500 && attempt + 1 < attempts) continue;
        let code = "qm_error";
        if (typeof parsed?.code === "string") code = parsed.code;
        else if (typeof parsed?.error === "string") code = parsed.error;
        throw new PhotonQmClientError(code, messageOf(parsed ?? {}, `QM request failed with ${response.status}`), {
          status: response.status,
          outcome:
            response.status >= 500 && options.unknownOnTransportFailure ? "unknown-outcome" : "confirmed-failure",
        });
      } catch (error) {
        if (error instanceof PhotonQmClientError) throw error;
        if (attempt + 1 < attempts) continue;
      }
    }
    throw new PhotonQmClientError("transport_error", "QM request outcome is unknown", {
      outcome: options.unknownOnTransportFailure ? "unknown-outcome" : "confirmed-failure",
    });
  }

  const envelope = (operation: QmChannelOperationRequest | CheckedQmChannelOperation) => ({ source, operation });
  const runId = (operation: QmChannelOperationRequest): string => {
    if (operation.name !== "turn.steer" && operation.name !== "run.signal") {
      throw new PhotonQmClientError("run_operation_required", "A run operation is required");
    }
    return operation.input.runId;
  };

  return {
    async check(operation) {
      const parsed = parseQmChannelOperationRequest(operation);
      const response = await request("POST", "/v1/photon/channel/check", envelope(parsed), { attempts: readAttempts });
      return parseCheckedQmChannelOperation(response.body);
    },

    async execute(operation) {
      const parsed = parseCheckedQmChannelOperation(operation);
      const retryable = parsed.name === "turn.start" || parsed.name === "turn.steer" || parsed.name === "run.signal";
      return (
        await request("POST", "/v1/photon/channel/execute", envelope(parsed), {
          attempts: retryable ? readAttempts : 1,
          unknownOnTransportFailure: true,
        })
      ).body;
    },

    async getRun(operation) {
      const parsed = parseQmChannelOperationRequest(operation);
      try {
        return (
          await request("POST", `/v1/photon/runs/${encodeURIComponent(runId(parsed))}/read`, envelope(parsed), {
            attempts: readAttempts,
          })
        ).body;
      } catch (error) {
        if (error instanceof PhotonQmClientError && error.status === 404) return null;
        throw error;
      }
    },

    async activeRun(operation) {
      const parsed = parseQmChannelOperationRequest(operation);
      return (await request("POST", "/v1/photon/runs/active", envelope(parsed), { attempts: readAttempts })).body;
    },

    async withdrawRun(operation) {
      const parsed = parseQmChannelOperationRequest(operation);
      return (
        await request("POST", `/v1/photon/runs/${encodeURIComponent(runId(parsed))}/withdraw`, envelope(parsed), {
          unknownOnTransportFailure: true,
        })
      ).body;
    },

    async getApproval(operation) {
      const parsed = parseQmChannelOperationRequest(operation);
      try {
        return (await request("POST", "/v1/photon/approvals/read", envelope(parsed), { attempts: readAttempts })).body;
      } catch (error) {
        if (error instanceof PhotonQmClientError && error.status === 404) return null;
        throw error;
      }
    },

    async listSessionApprovals(operation) {
      const parsed = parseQmChannelOperationRequest(operation);
      if (!parsed.sessionId) throw new PhotonQmClientError("session_required", "A session id is required");
      return (
        await request(
          "POST",
          `/v1/photon/sessions/${encodeURIComponent(parsed.sessionId)}/approvals`,
          envelope(parsed),
          { attempts: readAttempts },
        )
      ).body;
    },

    async pendingDeliveries(claimMs) {
      const path =
        claimMs !== undefined
          ? `/v1/photon/deliveries?claimMs=${encodeURIComponent(String(claimMs))}`
          : "/v1/photon/deliveries";
      return (await request("GET", path, undefined, { attempts: readAttempts })).body;
    },

    async ackDelivery(id) {
      return (
        await request(
          "POST",
          `/v1/photon/deliveries/${encodeURIComponent(id)}/ack`,
          {},
          {
            unknownOnTransportFailure: true,
          },
        )
      ).body;
    },

    async pendingContextRequests() {
      return (await request("GET", "/v1/photon/context-requests", undefined, { attempts: readAttempts })).body;
    },

    async fulfillContextRequest(id, outcome) {
      return (
        await request("POST", `/v1/photon/context-requests/${encodeURIComponent(id)}/result`, outcome, {
          unknownOnTransportFailure: true,
        })
      ).body;
    },
  };
}
