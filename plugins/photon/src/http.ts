import type { NormalizedPhotonInput } from "../../chassis/src/photon-contract.ts";

import { createPhotonQmClient, type PhotonQmClient, type PhotonQmClientDeps } from "./qm-client.ts";

export interface PhotonCoreHttpFactory {
  forSource(source: NormalizedPhotonInput): PhotonQmClient;
}

export function createPhotonCoreHttpFactory(deps: PhotonQmClientDeps): PhotonCoreHttpFactory {
  if (!deps.coreUrl.trim() || !deps.signingSecret.trim()) throw new Error("PHOTON_CORE_LINK_UNAVAILABLE");
  return {
    forSource(source) {
      return createPhotonQmClient(deps, source);
    },
  };
}
