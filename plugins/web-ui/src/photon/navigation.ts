import { isPlainLeftClick } from "../deep-link.ts";
import {
  parsePhotonHostRequest,
  samePhotonConversation,
  samePhotonRequest,
  type PhotonHostRequest,
  PHOTON_HOST_PATH,
  photonHostQuery,
  photonHostRequestFromQuery,
} from "./context.ts";

export function photonHostHref(request: PhotonHostRequest, base = ""): string {
  if (base && (!base.startsWith("/") || base.startsWith("//") || /[\\?#]/u.test(base))) throw new Error("Invalid base");
  return `${base.replace(/\/$/u, "")}${PHOTON_HOST_PATH}?${photonHostQuery(request)}`;
}

export function createPhotonNavigation(options: {
  window: Window;
  root: HTMLElement;
  initial: PhotonHostRequest;
  base?: string;
  onNavigate(request: PhotonHostRequest | null): void;
  onBackChange(available: boolean): void;
}) {
  const { window: win, root } = options;
  const initial = parsePhotonHostRequest(options.initial);
  const pathname = photonHostHref(initial, options.base).split("?")[0];
  const history: PhotonHostRequest[] = [initial];
  let active = true;
  let position = 0;
  const owner = win.crypto.randomUUID();
  const entryState = (index: number) => ({
    ...(win.history.state && typeof win.history.state === "object" ? win.history.state : {}),
    photonHostNavigation: { owner, index },
  });
  win.history.replaceState(entryState(0), "");
  const navigate = (input: PhotonHostRequest) => {
    if (!active) return;
    const next = parsePhotonHostRequest(input);
    if (!samePhotonConversation(initial.conversation, next.conversation)) throw new Error("Conversation mismatch");
    if (samePhotonRequest(history[position]!, next)) return;
    win.history.pushState(entryState(position + 1), "", photonHostHref(next, options.base));
    history.splice(position + 1, history.length, next);
    position++;
    options.onBackChange(true);
    options.onNavigate(next);
  };
  const popstate = (event: PopStateEvent) => {
    try {
      if (win.location.pathname !== pathname) throw new Error("Outside host");
      const next = photonHostRequestFromQuery(new URLSearchParams(win.location.search));
      if (!samePhotonConversation(initial.conversation, next.conversation)) throw new Error("Conversation mismatch");
      const entry = event.state?.photonHostNavigation;
      const item = entry?.owner === owner && Number.isSafeInteger(entry.index) ? history[entry.index] : undefined;
      if (item && samePhotonRequest(item, next)) position = entry.index;
      else {
        history.splice(0, history.length, next);
        position = 0;
        win.history.replaceState(entryState(0), "");
      }
      options.onBackChange(position > 0);
      options.onNavigate(next);
    } catch {
      options.onBackChange(false);
      options.onNavigate(null);
    }
  };
  const click = (event: MouseEvent) => {
    if (!isPlainLeftClick(event)) return;
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[data-photon-navigation]");
    if (
      !anchor ||
      !root.contains(anchor) ||
      anchor.hasAttribute("download") ||
      (anchor.target && anchor.target !== "_self")
    )
      return;
    const url = new URL(anchor.href, win.location.href);
    if (url.origin !== win.location.origin || url.pathname !== pathname) return;
    event.preventDefault();
    try {
      navigate(photonHostRequestFromQuery(url.searchParams));
    } catch {
      options.onNavigate(null);
    }
  };
  root.addEventListener("click", click);
  win.addEventListener("popstate", popstate);
  options.onBackChange(false);
  return {
    navigate,
    back() {
      if (active && position > 0) win.history.back();
    },
    dispose() {
      active = false;
      root.removeEventListener("click", click);
      win.removeEventListener("popstate", popstate);
    },
  };
}

export { PHOTON_HOST_PATH, PHOTON_HOST_API_PATH, photonHostQuery, photonHostRequestFromQuery } from "./context.ts";
