import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "../../chassis/src/http.ts";
import type { PhotonContributionProvider, PhotonExistingQmView } from "../src/photon/contracts.ts";
import {
  parsePhotonHostContext,
  parsePhotonHostRequest,
  samePhotonConversation,
  samePhotonRequest,
  type PhotonHostRequest,
} from "../src/photon/context.ts";
import { PHOTON_HOST_API_PATH, photonHostRequestFromQuery } from "../src/photon/context.ts";

export interface PhotonHostAuthority {
  viewerId: string;
  context: PhotonHostRequest;
}

export interface PhotonHostRouteOptions {
  registeredViews: readonly PhotonExistingQmView[];
  contributions: PhotonContributionProvider;
  resolveAuthority(
    req: IncomingMessage,
    request: PhotonHostRequest,
    viewerId: string,
  ): Promise<PhotonHostAuthority | null>;
}

export function createPhotonHostRoute(options: PhotonHostRouteOptions) {
  return {
    method: "GET",
    path: PHOTON_HOST_API_PATH,
    async handle({
      req,
      res,
      url,
      user,
    }: {
      req: IncomingMessage;
      res: ServerResponse;
      url: URL;
      user: string;
    }): Promise<void> {
      res.setHeader("cache-control", "no-store");
      res.setHeader("referrer-policy", "no-referrer");
      if (!user) return json(res, 401, { error: "sign in" });
      if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
      let request: PhotonHostRequest;
      try {
        request = photonHostRequestFromQuery(url.searchParams);
      } catch {
        return json(res, 400, { error: "invalid_host_context" });
      }
      if (!options.registeredViews.includes(request.view)) return json(res, 404, { error: "unavailable" });
      try {
        const authority = await options.resolveAuthority(req, request, user);
        if (
          !authority ||
          authority.viewerId !== user ||
          !samePhotonRequest(parsePhotonHostRequest(authority.context), request)
        ) {
          return json(res, 404, { error: "unavailable" });
        }
        const contribution = await options.contributions.forConversation(request.conversation, user);
        if (!samePhotonConversation(contribution.conversation, request.conversation))
          return json(res, 404, { error: "unavailable" });
        const matches = contribution.mounts.filter(
          (mount) => mount.view === request.view && mount.resourceId === request.resourceId,
        );
        if (matches.length !== 1) return json(res, 404, { error: "unavailable" });
        const context = parsePhotonHostContext(
          { ...authority.context, viewerId: user, contributionId: contribution.contributionId, mount: matches[0] },
          request,
          user,
        );
        return json(res, 200, context);
      } catch {
        return json(res, 503, { error: "host_unavailable" });
      }
    },
  };
}
