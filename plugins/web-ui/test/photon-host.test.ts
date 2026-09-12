import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { registerHooks } from "node:module";
import { JSDOM } from "jsdom";
import { mintPortalIdentity, verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { createPhotonHostRoute } from "../server/photon-host.ts";
import {
  parsePhotonHostContext,
  samePhotonRequest,
  photonWebPath,
  type PhotonHostContext,
  type PhotonHostRequest,
} from "../src/photon/context.ts";
import { photonHostHref, photonHostQuery, photonHostRequestFromQuery } from "../src/photon/navigation.ts";
import { mountPhotonHost, type PhotonViewRegistration } from "../src/photon/host.ts";

const request: PhotonHostRequest = {
  conversation: {
    provider: "spectrum-imessage",
    installationId: "test-installation",
    projectId: "test-project",
    lineId: "test-line",
    conversationId: "test-conversation",
  },
  sessionId: "test-session",
  view: "session",
  resourceId: "test-resource",
};

function testContext(input = request, viewerId = "alice"): PhotonHostContext {
  return {
    ...input,
    viewerId,
    contributionId: "test-only-contribution",
    mount: {
      view: input.view,
      resourceId: input.resourceId,
      title: `TEST DATA · ${viewerId}'s QM view`,
      webPath: `/s/${encodeURIComponent(input.sessionId)}`,
      audience: "actor",
    },
  };
}

const signingSecret = "wt06-test-only-source-secret";
const identitySecret = "wt06-test-only-identity-secret";
const revoked = new Set<string>();
const coreCalls: Array<{ viewer: string; method: string; body: unknown; signed: boolean }> = [];
const core = createServer(async (req, res) => {
  const token = req.headers[PORTAL_IDENTITY_HEADER];
  const identity = typeof token === "string" ? verifyPortalIdentity(token, identitySecret, Date.now()) : null;
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!identity || revoked.has(identity.p)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }
  coreCalls.push({
    viewer: identity.p,
    method: req.method!,
    body: body ? JSON.parse(body) : null,
    signed: typeof req.headers["x-signature"] === "string",
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ projects: [{ id: "test-resource", name: `TEST DATA · ${identity.p}'s project` }] }));
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = signingSecret;
process.env.PORTAL_IDENTITY_SECRET = identitySecret;
process.env.WEB_UI_PRINCIPALS = "alice,bob";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "0";
let surfaceBase = "";
let providerCalls = 0;
let malformedContribution = false;
const route = createPhotonHostRoute({
  registeredViews: ["session"],
  async resolveAuthority(req, input, viewerId) {
    if (!samePhotonRequest(input, request)) return null;
    const identity = req.headers[PORTAL_IDENTITY_HEADER];
    const response = await fetch(`${surfaceBase}/api/sessions`, {
      headers: { [PORTAL_IDENTITY_HEADER]: String(identity) },
    });
    if (!response.ok) return null;
    return { viewerId, context: input };
  },
  contributions: {
    async forConversation(conversation, actorId) {
      providerCalls++;
      const context = testContext(request, actorId);
      return {
        contributionId: "test-only-contribution",
        conversation: { ...conversation, ...(malformedContribution ? { installationId: "wrong" } : {}) },
        mounts: [
          context.mount,
          { ...context.mount, resourceId: "unrequested-private-resource", title: "Must never leave server" },
        ],
        actions: [],
        sourceSecret: signingSecret,
      };
    },
  },
});

const routeSymbol = Symbol.for("wt06-test-only-route");
Object.defineProperty(globalThis, routeSymbol, { value: route, configurable: true });
const serverModule = new URL("../server/index.ts", import.meta.url).href;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== serverModule) return result;
    const source = String(result.source);
    const anchor = "const apiRoutes: readonly WebRoute[] = [";
    assert.equal(source.split(anchor).length, 2, "test-only integration registration must match baseline exactly");
    return {
      ...result,
      source: source.replace(anchor, `${anchor}\n  globalThis[Symbol.for("wt06-test-only-route")],`),
    };
  },
});
const { handler } = await import("../server/index.ts");
hooks.deregister();
Reflect.deleteProperty(globalThis, routeSymbol);
const surface = createServer((req, res) => {
  void handler(req, res);
});
await new Promise<void>((resolve) => surface.listen(0, "127.0.0.1", resolve));
surfaceBase = `http://127.0.0.1:${(surface.address() as AddressInfo).port}`;
const endpoint = `${surfaceBase}/api/photon/host?${photonHostQuery(request)}`;

function headers(viewerId = "alice", exp = Date.now() + 60_000) {
  return {
    [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: viewerId, exp }, identitySecret),
    "content-type": "application/json",
  };
}

test.after(() => {
  surface.closeAllConnections();
  surface.close();
  core.closeAllConnections();
  core.close();
});

test("forwarded URLs use the real middleware's current viewer and allowlisted response", async () => {
  for (const viewer of ["alice", "bob"]) {
    const response = await fetch(endpoint, { headers: headers(viewer) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), testContext(request, viewer));
    assert.ok(!body.includes(signingSecret));
    assert.ok(!body.includes("Must never leave server"));
    assert.ok(coreCalls.some((call) => call.viewer === viewer && call.signed));
  }
  assert.equal((await fetch(`${endpoint}&viewerId=alice`, { headers: headers("bob") })).status, 400);
  const before = providerCalls;
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { headers: { cookie: "webuiuser=alice" } })).status, 401);
  assert.equal(providerCalls, before);
});

test("expired and revoked identities fail before normal QM mutations", async () => {
  const mutation = `${surfaceBase}/api/projects/test-resource`;
  const before = coreCalls.length;
  const expired = headers("alice", Date.now() - 1);
  assert.equal((await fetch(endpoint, { headers: expired })).status, 401);
  assert.equal((await fetch(mutation, { method: "PATCH", headers: expired, body: '{"name":"changed"}' })).status, 401);
  assert.equal(coreCalls.length, before);
  revoked.add("alice");
  try {
    assert.equal((await fetch(endpoint, { headers: headers() })).status, 404);
    assert.equal(
      (await fetch(mutation, { method: "PATCH", headers: headers(), body: '{"name":"changed"}' })).status,
      403,
    );
    assert.equal(coreCalls.length, before);
  } finally {
    revoked.clear();
  }
  const response = await fetch(mutation, {
    method: "PATCH",
    headers: headers("bob"),
    body: '{"name":"TEST DATA","principalId":"alice"}',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(coreCalls.at(-1)?.body, { principalId: "bob", name: "TEST DATA" });
});

test("wrong scope, unregistered views and ambiguous metadata never report success", async () => {
  for (const field of ["installationId", "projectId", "lineId", "conversationId", "sessionId", "resourceId"]) {
    const url = new URL(endpoint);
    url.searchParams.set(field, "wrong");
    assert.equal((await fetch(url, { headers: headers() })).status, 404, field);
  }
  const unavailable = new URL(endpoint);
  unavailable.searchParams.set("view", "files");
  assert.equal((await fetch(unavailable, { headers: headers() })).status, 404);
  unavailable.searchParams.set("view", "search");
  assert.equal((await fetch(unavailable, { headers: headers() })).status, 400);
  malformedContribution = true;
  try {
    assert.equal((await fetch(endpoint, { headers: headers() })).status, 404);
  } finally {
    malformedContribution = false;
  }
  assert.equal((await fetch(endpoint, { method: "POST", headers: headers() })).status, 404);
});

test("context and deep links bind every reference and contain no viewer credential", () => {
  const input = { ...request, resourceId: "resource / with ? delimiters" };
  assert.deepEqual(photonHostRequestFromQuery(new URLSearchParams(photonHostQuery(input))), input);
  assert.equal(photonHostHref(input, "/qm/").split("?")[0], "/qm/photon");
  assert.throws(() => photonHostRequestFromQuery(new URLSearchParams(`${photonHostQuery(input)}&sessionId=other`)));
  assert.throws(() => parsePhotonHostContext(testContext(), { ...request, sessionId: "other" }));
  assert.throws(() => parsePhotonHostContext(testContext(), request, "bob"));
  assert.throws(() =>
    parsePhotonHostContext({ ...testContext(), mount: { ...testContext().mount, resourceId: "wrong" } }, request),
  );
  for (const path of [
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/s/x?token=secret",
    "/s/../auth",
    "/s/x#secret",
  ]) {
    assert.throws(() => photonWebPath(path), path);
  }
  const projected = parsePhotonHostContext({ ...testContext(), sourceSecret: signingSecret, token: "secret" }, request);
  assert.deepEqual(projected, testContext());
});

function browserFixture() {
  const dom = new JSDOM('<!doctype html><html lang="en"><body><main id="host"></main></body></html>', {
    url: `https://qm.test${photonHostHref(request)}`,
  });
  const root = dom.window.document.querySelector<HTMLElement>("#host")!;
  return { dom, root };
}

async function settled() {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
}

test("real contribution mount, navigation, back, reconnect and disposal own listeners once", async () => {
  const { dom, root } = browserFixture();
  let mounted = 0;
  let unmounted = 0;
  let events = 0;
  let reads = 0;
  const contribution: PhotonViewRegistration = {
    view: "session",
    mount({ root: target, context, signal }) {
      mounted++;
      const label = dom.window.document.createElement("p");
      label.textContent = `TEST DATA · ${context.resourceId}`;
      target.append(label);
      dom.window.addEventListener("test-view-event", () => events++, { signal });
      return () => {
        unmounted++;
        target.replaceChildren();
      };
    },
  };
  const host = mountPhotonHost({
    root,
    initial: request,
    viewerId: "alice",
    registrations: [contribution],
    loadContext: async (input) => {
      reads++;
      return testContext(input);
    },
  });
  await host.ready;
  assert.equal(dom.window.document.activeElement?.tagName, "H1");
  host.navigate({ ...request, resourceId: "test-resource-2" });
  await settled();
  assert.equal(new URL(dom.window.location.href).searchParams.get("resourceId"), "test-resource-2");
  host.back();
  await settled();
  assert.equal(new URL(dom.window.location.href).searchParams.get("resourceId"), "test-resource");
  assert.equal(root.querySelector("button")?.disabled, true);
  host.navigate({ ...request, resourceId: "test-resource-2" });
  await settled();
  host.navigate(request);
  await settled();
  host.back();
  await settled();
  host.back();
  await settled();
  assert.equal(root.querySelector("button")?.disabled, true);
  dom.window.history.forward();
  await settled();
  assert.equal(root.querySelector("button")?.disabled, false);
  assert.equal(new URL(dom.window.location.href).searchParams.get("resourceId"), "test-resource-2");
  for (let index = 0; index < 3; index++) await host.reconnect();
  dom.window.dispatchEvent(new dom.window.Event("test-view-event"));
  assert.equal(events, 1);
  assert.equal(mounted - unmounted, 1);
  assert.equal(reads, mounted);
  host.setLayout("expanded");
  assert.equal(root.firstElementChild?.getAttribute("data-layout"), "expanded");
  host.dispose();
  host.dispose();
  dom.window.dispatchEvent(new dom.window.Event("online"));
  dom.window.dispatchEvent(new dom.window.Event("test-view-event"));
  await settled();
  assert.equal(events, 1);
  assert.equal(mounted, unmounted);
  assert.equal(root.children.length, 0);
  dom.window.close();
});

test("stale async mounts release and cannot repopulate the current host", async () => {
  const { dom, root } = browserFixture();
  let finish: (() => void) | undefined;
  let released = 0;
  let first = true;
  const host = mountPhotonHost({
    root,
    initial: request,
    viewerId: "alice",
    loadContext: async (input) => testContext(input),
    registrations: [
      {
        view: "session",
        async mount({ root: target, navigate }) {
          const delayed = first;
          if (first) {
            first = false;
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
          }
          if (delayed) navigate({ ...request, resourceId: "stale-mount" });
          target.textContent = "TEST DATA · mounted";
          return () => {
            released++;
          };
        },
      },
    ],
  });
  await settled();
  host.navigate({ ...request, resourceId: "test-resource-2" });
  await settled();
  finish!();
  await host.ready;
  assert.equal(released, 1);
  assert.equal(new URL(dom.window.location.href).searchParams.get("resourceId"), "test-resource-2");
  assert.equal(root.querySelectorAll(".photon-host-view").length, 1);
  host.dispose();
  assert.equal(released, 2);
  dom.window.close();
});

test("revocation, identity change, offline and replacement erase prior view state", async () => {
  const { dom, root } = browserFixture();
  let changedViewer = false;
  let mounts = 0;
  let releases = 0;
  const options = {
    root,
    initial: request,
    viewerId: "alice",
    loadContext: async () => testContext(request, changedViewer ? "bob" : "alice"),
    registrations: [
      {
        view: "session" as const,
        mount({ root: target }: { root: HTMLElement }) {
          mounts++;
          target.textContent = "TEST DATA · private";
          return () => {
            releases++;
          };
        },
      },
    ],
  };
  const host = mountPhotonHost(options);
  await host.ready;
  changedViewer = true;
  await host.reconnect();
  assert.ok(!root.textContent?.includes("private"));
  assert.match(root.textContent!, /unavailable/);
  assert.equal(root.querySelector("a")?.hasAttribute("href"), false);
  changedViewer = false;
  const replacement = mountPhotonHost(options);
  await replacement.ready;
  dom.window.dispatchEvent(new dom.window.Event("offline"));
  assert.ok(!root.textContent?.includes("private"));
  dom.window.dispatchEvent(new dom.window.Event("online"));
  await settled();
  assert.equal(mounts - releases, 1);
  dom.window.dispatchEvent(new dom.window.Event("webui:signin-required"));
  assert.ok(!root.textContent?.includes("private"));
  assert.equal(mounts, releases);
  replacement.dispose();
  dom.window.close();
});

test("missing renderer and rejected authority never mount a substitute view", async () => {
  const { dom, root } = browserFixture();
  let reads = 0;
  const host = mountPhotonHost({
    root,
    initial: request,
    viewerId: "alice",
    registrations: [],
    loadContext: async () => {
      reads++;
      throw new Error("secret backend failure");
    },
  });
  await host.ready;
  assert.equal(reads, 0);
  assert.match(root.textContent!, /unavailable/);
  assert.ok(!root.textContent?.includes("secret"));
  host.dispose();
  dom.window.close();
});
