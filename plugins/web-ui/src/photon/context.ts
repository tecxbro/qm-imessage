import { PHOTON_PROVIDER_NAMES, type ConversationReference } from "../../../chassis/src/photon-contract.ts";
import { PHOTON_EXISTING_QM_VIEWS, type ExistingQmViewMount, type PhotonExistingQmView } from "./contracts.ts";

export interface PhotonHostRequest {
  conversation: ConversationReference;
  sessionId: string;
  view: PhotonExistingQmView;
  resourceId: string;
}

export interface PhotonHostContext extends PhotonHostRequest {
  viewerId: string;
  contributionId: string;
  mount: ExistingQmViewMount;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid host context");
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Invalid host identifier");
  }
  return value;
}

export function photonWebPath(value: unknown): string {
  const path = identifier(value);
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/u.test(path)) throw new Error("Invalid view path");
  const url = new URL(path, "https://qm.invalid");
  if (url.origin !== "https://qm.invalid" || `${url.pathname}${url.search}` !== path) {
    throw new Error("Invalid view path");
  }
  if ([...url.searchParams.keys()].some((key) => key !== "scope")) throw new Error("Invalid view query");
  return path;
}

export function parsePhotonHostRequest(value: unknown): PhotonHostRequest {
  const input = record(value);
  const source = record(input.conversation);
  if (!PHOTON_PROVIDER_NAMES.includes(source.provider as ConversationReference["provider"])) {
    throw new Error("Invalid provider");
  }
  if (!PHOTON_EXISTING_QM_VIEWS.includes(input.view as PhotonExistingQmView)) throw new Error("Unavailable view");
  const conversation: ConversationReference = {
    provider: source.provider as ConversationReference["provider"],
    installationId: identifier(source.installationId),
    lineId: identifier(source.lineId),
    conversationId: identifier(source.conversationId),
    ...(source.projectId === undefined ? {} : { projectId: identifier(source.projectId) }),
  };
  return {
    conversation,
    sessionId: identifier(input.sessionId),
    view: input.view as PhotonExistingQmView,
    resourceId: identifier(input.resourceId),
  };
}

export function samePhotonConversation(a: ConversationReference, b: ConversationReference): boolean {
  return (
    a.provider === b.provider &&
    a.installationId === b.installationId &&
    a.projectId === b.projectId &&
    a.lineId === b.lineId &&
    a.conversationId === b.conversationId
  );
}

export function samePhotonRequest(a: PhotonHostRequest, b: PhotonHostRequest): boolean {
  return (
    samePhotonConversation(a.conversation, b.conversation) &&
    a.sessionId === b.sessionId &&
    a.view === b.view &&
    a.resourceId === b.resourceId
  );
}

export function parsePhotonHostContext(
  value: unknown,
  expected: PhotonHostRequest,
  viewerId?: string,
): PhotonHostContext {
  const input = record(value);
  const request = parsePhotonHostRequest(input);
  const viewer = identifier(input.viewerId);
  if (!samePhotonRequest(request, expected) || (viewerId !== undefined && viewer !== viewerId)) {
    throw new Error("Host context mismatch");
  }
  const mount = record(input.mount);
  if (
    mount.view !== request.view ||
    mount.resourceId !== request.resourceId ||
    (mount.audience !== "actor" && mount.audience !== "conversation")
  )
    throw new Error("View context mismatch");
  return {
    ...request,
    viewerId: viewer,
    contributionId: identifier(input.contributionId),
    mount: {
      view: request.view,
      resourceId: request.resourceId,
      title: identifier(mount.title),
      webPath: photonWebPath(mount.webPath),
      audience: mount.audience,
    },
  };
}

export const PHOTON_HOST_PATH = "/photon";
export const PHOTON_HOST_API_PATH = "/api/photon/host";
const queryKeys = [
  "provider",
  "installationId",
  "projectId",
  "lineId",
  "conversationId",
  "sessionId",
  "view",
  "resourceId",
];

export function photonHostQuery(input: PhotonHostRequest): string {
  const request = parsePhotonHostRequest(input);
  return new URLSearchParams({
    ...request.conversation,
    sessionId: request.sessionId,
    view: request.view,
    resourceId: request.resourceId,
  }).toString();
}

export function photonHostRequestFromQuery(params: URLSearchParams): PhotonHostRequest {
  for (const key of params.keys()) {
    if (!queryKeys.includes(key) || params.getAll(key).length !== 1) throw new Error("Invalid host query");
  }
  return parsePhotonHostRequest({
    conversation: {
      provider: params.get("provider"),
      installationId: params.get("installationId"),
      lineId: params.get("lineId"),
      conversationId: params.get("conversationId"),
      ...(params.has("projectId") ? { projectId: params.get("projectId") } : {}),
    },
    sessionId: params.get("sessionId"),
    view: params.get("view"),
    resourceId: params.get("resourceId"),
  });
}
