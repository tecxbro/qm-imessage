import type { PhotonExistingQmView } from "./contracts.ts";
import { parsePhotonHostContext, type PhotonHostContext, type PhotonHostRequest } from "./context.ts";
import { createPhotonNavigation, PHOTON_HOST_API_PATH, photonHostQuery } from "./navigation.ts";
import { SIGNIN_REQUIRED_EVENT } from "../signin-return.ts";

export interface PhotonViewMountOptions {
  root: HTMLElement;
  context: PhotonHostContext;
  signal: AbortSignal;
  navigate(request: PhotonHostRequest): void;
}

export interface PhotonViewRegistration {
  view: PhotonExistingQmView;
  mount(options: PhotonViewMountOptions): (() => void) | Promise<() => void>;
}

export async function loadPhotonHostContext(request: PhotonHostRequest, signal: AbortSignal): Promise<unknown> {
  const { api } = await import("../core-bridge.ts");
  return api(`${PHOTON_HOST_API_PATH}?${photonHostQuery(request)}`, { signal, cache: "no-store" });
}

const activeHosts = new WeakMap<HTMLElement, () => void>();

export function mountPhotonHost(options: {
  root: HTMLElement;
  initial: PhotonHostRequest;
  viewerId: string;
  registrations: readonly PhotonViewRegistration[];
  base?: string;
  layout?: "compact" | "expanded";
  loadContext?: typeof loadPhotonHostContext;
}) {
  const { root } = options;
  const document = root.ownerDocument;
  const win = document.defaultView;
  if (!win) throw new Error("Host requires a window");
  const registrations = new Map<PhotonExistingQmView, PhotonViewRegistration>();
  for (const registration of options.registrations) {
    if (registrations.has(registration.view)) throw new Error("Duplicate view registration");
    registrations.set(registration.view, registration);
  }
  activeHosts.get(root)?.();
  const container = document.createElement("section");
  container.className = "photon-host";
  container.dataset.layout = options.layout ?? "compact";
  container.setAttribute("aria-label", "QM view");
  const header = document.createElement("header");
  header.className = "photon-host-header";
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "Back";
  const title = document.createElement("h1");
  title.textContent = "QM";
  title.tabIndex = -1;
  const open = document.createElement("a");
  open.textContent = "Open in QM";
  open.hidden = true;
  header.append(back, title, open);
  const status = document.createElement("p");
  status.className = "photon-host-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const content = document.createElement("div");
  content.className = "photon-host-content";
  container.append(header, status, content);
  root.replaceChildren(container);
  let disposed = false;
  let sequence = 0;
  let controller: AbortController | null = null;
  let unmount: (() => void) | null = null;
  let current: PhotonHostRequest | null = options.initial;
  const cleanup = () => {
    controller?.abort();
    controller = null;
    const release = unmount;
    unmount = null;
    content.replaceChildren();
    content.removeAttribute("aria-busy");
    title.textContent = "QM";
    open.hidden = true;
    open.removeAttribute("href");
    release?.();
  };
  const show = async (request: PhotonHostRequest | null): Promise<void> => {
    if (disposed) return;
    current = request;
    const version = ++sequence;
    try {
      cleanup();
    } catch {
      status.textContent = "This view could not be closed. Reopen QM to continue.";
      return;
    }
    if (!request) {
      status.textContent = "This view is unavailable.";
      return;
    }
    const registration = registrations.get(request.view);
    if (!registration) {
      status.textContent = "This view is unavailable.";
      return;
    }
    const pending = new win.AbortController();
    controller = pending;
    status.textContent = "Loading QM…";
    content.setAttribute("aria-busy", "true");
    try {
      const context = parsePhotonHostContext(
        await (options.loadContext ?? loadPhotonHostContext)(request, pending.signal),
        request,
        options.viewerId,
      );
      if (disposed || sequence !== version) return;
      const viewRoot = document.createElement("div");
      viewRoot.className = "photon-host-view";
      content.replaceChildren(viewRoot);
      const release = await registration.mount({
        root: viewRoot,
        context,
        signal: pending.signal,
        navigate: (next) => {
          if (!disposed && sequence === version && !pending.signal.aborted) navigation.navigate(next);
        },
      });
      if (disposed || sequence !== version) {
        release();
        return;
      }
      unmount = release;
      title.textContent = context.mount.title;
      open.href = context.mount.webPath;
      open.hidden = false;
      status.textContent = "";
      title.focus({ preventScroll: true });
    } catch {
      if (disposed || sequence !== version) return;
      cleanup();
      status.textContent = "This view is unavailable. Reopen QM to check your access.";
    } finally {
      if (sequence === version) content.removeAttribute("aria-busy");
    }
  };
  const navigation = createPhotonNavigation({
    window: win,
    root: container,
    initial: options.initial,
    base: options.base,
    onNavigate: (request) => {
      void show(request);
    },
    onBackChange: (available) => {
      back.disabled = !available;
    },
  });
  const goBack = () => navigation.back();
  const reconnect = () => {
    void show(current);
  };
  const visibility = () => {
    if (document.visibilityState === "visible") reconnect();
  };
  const suspend = () => {
    ++sequence;
    cleanup();
    status.textContent = "Reconnecting to QM…";
  };
  const signedOut = () => {
    current = null;
    suspend();
    status.textContent = "Sign in to QM to continue.";
  };
  const pageShow = (event: PageTransitionEvent) => {
    if (event.persisted) reconnect();
  };
  back.addEventListener("click", goBack);
  win.addEventListener("online", reconnect);
  win.addEventListener("offline", suspend);
  win.addEventListener("pagehide", suspend);
  win.addEventListener("pageshow", pageShow);
  win.addEventListener(SIGNIN_REQUIRED_EVENT, signedOut);
  document.addEventListener("visibilitychange", visibility);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ++sequence;
    navigation.dispose();
    back.removeEventListener("click", goBack);
    win.removeEventListener("online", reconnect);
    win.removeEventListener("offline", suspend);
    win.removeEventListener("pagehide", suspend);
    win.removeEventListener("pageshow", pageShow);
    win.removeEventListener(SIGNIN_REQUIRED_EVENT, signedOut);
    document.removeEventListener("visibilitychange", visibility);
    activeHosts.delete(root);
    try {
      cleanup();
    } finally {
      container.remove();
    }
  };
  activeHosts.set(root, dispose);
  return {
    ready: show(current),
    navigate: navigation.navigate,
    back: navigation.back,
    reconnect: () => show(current),
    setLayout(layout: "compact" | "expanded") {
      container.dataset.layout = layout;
    },
    dispose,
  };
}
