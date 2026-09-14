import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer as createViteServer } from "vite";
import { photonHostHref, photonHostQuery } from "../src/photon/navigation.ts";
import type { PhotonHostRequest } from "../src/photon/context.ts";

const request: PhotonHostRequest = {
  conversation: {
    provider: "spectrum-imessage",
    installationId: "r12-installation",
    projectId: "r12-project",
    lineId: "r12-line",
    conversationId: "r12-conversation",
  },
  sessionId: "r12-session",
  view: "session",
  resourceId: "r12-resource",
};

process.env.NODE_ENV = "test";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "1";
process.env.WEB_UI_PRINCIPALS = "alice";
delete process.env.CORE_SIGNING_SECRET;
delete process.env.PORTAL_IDENTITY_SECRET;
process.env.CORE_API_URL = "http://127.0.0.1:9";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(surface.address() as AddressInfo).port}`;
const hostUrl = `${base}/api/photon/host?${photonHostQuery(request)}`;

test.after(() => {
  surface.closeAllConnections();
  surface.close();
});

test("the actual web handler authenticates Photon before its explicit unavailable registry", async () => {
  const unauthenticated = await fetch(hostUrl);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("x-frame-options"), "DENY");

  const malformed = await fetch(`${hostUrl}&viewerId=alice`, { headers: { cookie: "webuiuser=alice" } });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("cache-control"), "no-store");
  assert.equal(malformed.headers.get("referrer-policy"), "no-referrer");

  const unavailable = await fetch(hostUrl, { headers: { cookie: "webuiuser=alice" } });
  assert.equal(unavailable.status, 404);
  assert.deepEqual(await unavailable.json(), { error: "unavailable" });

  const unknownView = new URL(hostUrl);
  unknownView.searchParams.set("view", "search");
  const invalidView = await fetch(unknownView, { headers: { cookie: "webuiuser=alice" } });
  assert.equal(invalidView.status, 400);
  assert.doesNotMatch(await invalidView.text(), /r12-|alice|secret/i);
});

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

interface BrowserHarnessOptions {
  path: string;
  me?: Record<string, unknown>;
  holdMe?: boolean;
}

interface BrowserHarness {
  requests: string[];
  eventSources: { created: number; closed: number };
  app: HTMLElement;
  boot: () => Promise<void>;
  signOut: () => Promise<void>;
  releaseMe: () => void;
  close: () => Promise<void>;
}

async function browserHarness(options: BrowserHarnessOptions): Promise<BrowserHarness> {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: `http://localhost${options.path}`,
  });
  const requests: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const eventSources = { created: 0, closed: 0 };
  const meResponse = Response.json(options.me ?? { user: "alice", org: "test", permissions: [], mode: "dev" });
  let releaseMe = (): void => {};
  const meGate = new Promise<void>((resolve) => {
    releaseMe = resolve;
  });

  class CountingEventSource {
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    static readonly CONNECTING = 0;
    readyState = CountingEventSource.OPEN;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor() {
      eventSources.created++;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {
      eventSources.closed++;
      this.readyState = CountingEventSource.CLOSED;
    }
  }

  const respond = async (input: RequestInfo | URL): Promise<Response> => {
    let raw: string;
    if (typeof input === "string") raw = input;
    else if (input instanceof URL) raw = input.href;
    else raw = input.url;
    const url = new URL(raw, dom.window.location.href);
    const path = `${url.pathname}${url.search}`;
    requests.push(path);
    if (url.pathname === "/me") {
      if (options.holdMe) await meGate;
      return meResponse.clone();
    }
    if (url.pathname === "/auth/logout") return new Response(null, { status: 401 });
    if (url.pathname === "/signout") return Response.json({ ok: true });
    if (url.pathname === "/api/user-model-auth/status") {
      return Response.json({ individualModelAuth: false, connections: [] });
    }
    if (url.pathname === "/api/photon/host") return Response.json({ error: "host_unavailable" }, { status: 503 });
    return Response.json({});
  };

  const globals: Record<string, unknown> = {
    fetch: respond,
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    PointerEvent: dom.window.PointerEvent,
    MouseEvent: dom.window.MouseEvent,
    customElements: dom.window.customElements,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    EventSource: CountingEventSource,
    ResizeObserver: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
    IntersectionObserver: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
    cancelAnimationFrame: clearTimeout,
    setTimeout: ((...args: Parameters<typeof setTimeout>) => {
      const id = realSetTimeout(...args);
      timers.add(id);
      return id;
    }) as typeof setTimeout,
    setInterval: ((...args: Parameters<typeof setInterval>) => {
      const id = realSetInterval(...args);
      timers.add(id);
      return id;
    }) as typeof setInterval,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = realSetTimeout(() => callback(Date.now()), 0);
      timers.add(id);
      return id as unknown as number;
    },
  };
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.window, "fetch", { configurable: true, writable: true, value: respond });
  Object.defineProperty(dom.window, "EventSource", { configurable: true, writable: true, value: CountingEventSource });
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  if (typeof dom.window.crypto.randomUUID !== "function") {
    Object.defineProperty(dom.window.crypto, "randomUUID", { configurable: true, value: () => "r12-test-owner" });
  }

  const vite = await createViteServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  const shell = await vite.ssrLoadModule("/src/shell.ts");
  const app = dom.window.document.getElementById("app")!;
  return {
    requests,
    eventSources,
    app,
    boot: shell.boot as () => Promise<void>,
    signOut: shell.signOut as () => Promise<void>,
    releaseMe,
    close: async () => {
      releaseMe();
      await vite.close();
      dom.window.close();
      for (const id of timers) {
        clearTimeout(id);
        clearInterval(id);
      }
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

function assertNoOrdinaryWork(harness: BrowserHarness): void {
  assert.deepEqual(
    harness.requests.filter((path) =>
      /^\/api\/(sessions|runtime-config|ui-state|inbox|deliveries|loops)(?:\/|\?|$)/.test(path),
    ),
    [],
    "Photon boot must not prefetch ordinary sessions, runtime config, split state, inbox, or delivery routes",
  );
  assert.equal(harness.eventSources.created, 0, "Photon boot must not open the ordinary delivery stream");
}

test("main registers Photon CSS and a valid Photon entry stays on its dedicated unavailable host", async () => {
  assert.match(mainSource, /import ["']\.\/photon\/host\.css["'];/);
  const harness = await browserHarness({ path: photonHostHref(request) });
  try {
    await harness.boot();
    assertNoOrdinaryWork(harness);
    assert.ok(harness.app.querySelector(".photon-entry"));
    assert.ok(harness.app.querySelector(".photon-host"));
    assert.match(harness.app.textContent ?? "", /This view is unavailable/);
    assert.equal(harness.app.querySelector(".layout"), null);
    harness.app.ownerDocument.defaultView!.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertNoOrdinaryWork(harness);
  } finally {
    await harness.close();
  }
});

test("malformed Photon context is visible and does not fall through to the ordinary shell", async () => {
  const harness = await browserHarness({ path: "/photon?view=session" });
  try {
    await harness.boot();
    assertNoOrdinaryWork(harness);
    assert.ok(harness.app.querySelector(".photon-entry"));
    assert.match(harness.app.textContent ?? "", /Photon view is unavailable/);
    assert.equal(harness.app.querySelector(".layout"), null);
  } finally {
    await harness.close();
  }
});

test("the model-auth gate completes before Photon can mount", async () => {
  const harness = await browserHarness({
    path: photonHostHref(request),
    me: { user: "alice", org: "test", mode: "dev", individualModelAuth: true, modelAuthConnected: false },
  });
  try {
    await harness.boot();
    assertNoOrdinaryWork(harness);
    assert.equal(harness.app.querySelector(".photon-entry"), null);
    assert.equal(harness.app.querySelector(".layout"), null);
    assert.match(harness.app.textContent ?? "", /Connect|model|sign-in/i);
  } finally {
    await harness.close();
  }
});

test("sign-out invalidates delayed Photon boot and reopening replaces the host once", async () => {
  const harness = await browserHarness({ path: photonHostHref(request), holdMe: true });
  try {
    const booted = harness.boot();
    while (!harness.requests.includes("/me")) await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.signOut();
    harness.releaseMe();
    await booted;
    assert.equal(harness.app.querySelector(".photon-entry"), null);
    assert.equal(harness.app.querySelector(".layout"), null);

    await harness.boot();
    const first = harness.app.querySelector(".photon-host");
    await harness.boot();
    assert.ok(first);
    assert.equal(harness.app.querySelectorAll(".photon-host").length, 1);
    assert.notEqual(harness.app.querySelector(".photon-host"), first);
    assertNoOrdinaryWork(harness);
  } finally {
    await harness.close();
  }
});
