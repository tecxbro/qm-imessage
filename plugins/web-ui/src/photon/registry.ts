import { UI_BASE } from "../deep-link.ts";
import type { PhotonHostRequest } from "./context.ts";
import { mountPhotonHost, type PhotonViewRegistration } from "./host.ts";

export const photonViewRegistrations: readonly PhotonViewRegistration[] = Object.freeze([]);

let mounted: ReturnType<typeof mountPhotonHost> | undefined;

export function disposePhotonEntry(): void {
  const previous = mounted;
  mounted = undefined;
  previous?.dispose();
}

export function mountPhotonEntry(root: HTMLElement, request: PhotonHostRequest, viewerId: string) {
  disposePhotonEntry();
  mounted = mountPhotonHost({
    root,
    initial: request,
    viewerId,
    registrations: photonViewRegistrations,
    base: UI_BASE,
  });
  return mounted;
}
