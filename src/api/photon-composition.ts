import type { PhotonInstallationCiphertextStore } from "../../plugins/photon/src/ports.ts";
import {
  createEncryptedPhotonInstallationStore,
  type PhotonInstallationSecretCodec,
} from "../../plugins/photon/src/setup/installation-store.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import type { RunStore } from "../runs/run-store.ts";

import type { App } from "./app.ts";
import {
  createPhotonAuthorization,
  type PhotonActionAuthorizationPort,
  type PhotonCanonicalIdentityAuthorizationPort,
  type PhotonConversationAuthorizationPort,
  type PhotonMessageAuthorizationPort,
} from "./photon-authorization.ts";
import { createPhotonCoreClient, type PhotonCoreClient } from "./photon-core-client.ts";

export interface PhotonCoreCompositionInputs {
  persistedInstallations: PhotonInstallationCiphertextStore;
  installationCodec: PhotonInstallationSecretCodec;
  identities: PhotonCanonicalIdentityAuthorizationPort;
  conversations: PhotonConversationAuthorizationPort;
  messages: PhotonMessageAuthorizationPort;
  actions: PhotonActionAuthorizationPort;
  now?: () => number;
}

export interface PhotonCoreCompositionDeps extends PhotonCoreCompositionInputs {
  app: App;
  runs: Pick<RunStore, "get">;
  deliveries: Pick<DeliveryStore, "get">;
}

export interface PhotonCoreComposition {
  core: PhotonCoreClient;
  installations: ReturnType<typeof createEncryptedPhotonInstallationStore>;
}

export function createPhotonCoreComposition(deps: PhotonCoreCompositionDeps): PhotonCoreComposition {
  const installations = createEncryptedPhotonInstallationStore(deps.persistedInstallations, deps.installationCodec);
  const authorization = createPhotonAuthorization({
    app: deps.app,
    installations,
    identities: deps.identities,
    conversations: deps.conversations,
    messages: deps.messages,
    actions: deps.actions,
    runs: deps.runs,
    ...(deps.now ? { now: deps.now } : {}),
  });
  return {
    installations,
    core: createPhotonCoreClient({ app: deps.app, authorization, deliveries: deps.deliveries }),
  };
}
