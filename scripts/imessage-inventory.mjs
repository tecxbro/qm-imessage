#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { apiRoutes, rawRoutes } from "../src/api/routes/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedAt = new Date().toISOString();
const baseline = "0e3f9b9739f5ac695aa02672860ead64da88105e";
const reviewedFiles = [
  "AGENTS.md",
  "README.md",
  "deployment.md",
  "package.json",
  "plugins/chassis/package.json",
  "plugins/web-ui/package.json",
  "src/types.ts",
  "src/api/app-types.ts",
  "src/api/routes/turns.ts",
  "src/api/server.ts",
  "src/api/user-scoped-routes.ts",
  "src/api/slack-core-client.ts",
  "src/api/app-turn.ts",
  "src/api/routes/context.ts",
  "src/reach/reach.ts",
];

function gitFiles() {
  return execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
}

function parityId(method, path) {
  const digest = createHash("sha256").update(`${method} ${path}`).digest("hex").slice(0, 10);
  const stem = path
    .replace(/^\//u, "")
    .replace(/:[^/]+/gu, "item")
    .replace(/[^a-z0-9]+/giu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
  return `qm-route-${method.toLowerCase()}-${stem}-${digest}`;
}

const routeSources = [
  ["/slack/events", "src/api/routes/slack-events.ts"],
  ["/v1/admin", "src/api/routes/admin.ts"],
  ["/v1/turns", "src/api/routes/turns.ts"],
  ["/v1/approvals", "src/api/routes/turns.ts"],
  ["/v1/runs", "src/api/routes/turns.ts"],
  ["/v1/deliveries", "src/api/routes/turns.ts"],
  ["/v1/blobs", "src/api/routes/blobs.ts"],
  ["/v1/deployment-layer", "src/api/routes/deployment-layer.ts"],
  ["/v1/credentials", "src/api/routes/credentials.ts"],
  ["/v1/keychain", "src/api/routes/keychain.ts"],
  ["/v1/connectors", "src/api/routes/connectors.ts"],
  ["/v1/files/upload", "src/api/routes/file-uploads.ts"],
  ["/v1/projects", "src/api/routes/projects.ts"],
  ["/v1/contexts/policy", "src/api/routes/context-policy.ts"],
  ["/v1/crons", "src/api/routes/crons.ts"],
  ["/v1/loops/inbox", "src/api/routes/loop-items.ts"],
  ["/v1/loops/:id/items", "src/api/routes/loop-items.ts"],
  ["/v1/loops", "src/api/routes/loops.ts"],
  ["/v1/reach", "src/api/routes/reach.ts"],
  ["/v1/webhooks", "src/api/routes/webhooks.ts"],
  ["/v1/directory", "src/api/routes/directory.ts"],
  ["/v1/surface-context", "src/api/routes/context.ts"],
  ["/v1/surface-file", "src/api/routes/context.ts"],
  ["/v1/pins", "src/api/routes/pins.ts"],
  ["/v1/surface-cache", "src/api/routes/surface-cache.ts"],
  ["/v1/environments", "src/api/routes/environments.ts"],
  ["/v1/emoji", "src/api/routes/emoji.ts"],
  ["/v1/deployments", "src/api/routes/deployments.ts"],
  ["/v1/egress-audit", "src/api/routes/egress-audit.ts"],
  ["/v1/auth/broker", "src/api/routes/auth-broker.ts"],
  ["/v1/user-model-auth", "src/api/routes/user-model-auth.ts"],
  ["/v1/search", "src/api/routes/search.ts"],
  ["/v1/session-state", "src/api/routes/session-state.ts"],
  ["/v1/loop-items", "src/api/routes/loop-item-events.ts"],
];

function routeSource(path) {
  return routeSources.find(([prefix]) => path.startsWith(prefix))?.[1] ?? "src/api/routes/surface.ts";
}

function viewFor(path) {
  const views = [
    ["/v1/sessions", "plugins/web-ui/src/chat.ts"],
    ["/v1/conversations", "plugins/web-ui/src/conversations.ts"],
    ["/v1/approvals", "plugins/web-ui/src/draft-review.ts"],
    ["/v1/runs", "plugins/web-ui/src/timeline.ts"],
    ["/v1/files", "plugins/web-ui/src/files.ts"],
    ["/v1/memory", "plugins/web-ui/src/memory.ts"],
    ["/v1/skills", "plugins/web-ui/src/skills.ts"],
    ["/v1/loops", "plugins/web-ui/src/loops.ts"],
    ["/v1/webhooks", "plugins/web-ui/src/webhooks.ts"],
    ["/v1/deployments", "plugins/web-ui/src/deploys.ts"],
    ["/v1/projects", "plugins/web-ui/src/contexts.ts"],
    ["/v1/connectors", "plugins/web-ui/src/connectors.ts"],
    ["/v1/keychain", "plugins/web-ui/src/keychain-state.ts"],
    ["/v1/crons", "plugins/web-ui/src/crons.ts"],
    ["/v1/search", "plugins/web-ui/src/search.ts"],
    ["/v1/admin", "plugins/admin-ui/src/main.ts"],
  ];
  return views.find(([prefix]) => path.startsWith(prefix))?.[1] ?? null;
}

function laneFor(method, path) {
  if (path === "/slack/events" || path === "/healthz") return "integration";
  if (path.startsWith("/v1/admin")) return method === "GET" ? "wt-13" : "wt-14";
  if (/^\/v1\/(turns|runs)/u.test(path)) return "wt-03";
  if (path.startsWith("/v1/approvals")) return "wt-05";
  if (path.startsWith("/v1/deliveries")) return "wt-16";
  if (/^\/v1\/(sessions|conversations|session-state|shared-sessions|public-shares)/u.test(path)) return "wt-07";
  if (/^\/v1\/(files|blobs)/u.test(path)) return "wt-04";
  if (/^\/v1\/(memory|contexts|surface-context|surface-file|scope-resources|ui-state|soul)/u.test(path)) return "wt-08";
  if (/^\/v1\/(skills|connectors|keychain|credentials|user-model-auth|auth\/broker)/u.test(path)) return "wt-09";
  if (/^\/v1\/(crons|loops|loop-items|webhooks|triggers)/u.test(path)) return "wt-10";
  if (/^\/v1\/(projects|directory|principals|reach|grants|share|pins|environments|emoji)/u.test(path)) return "wt-11";
  if (/^\/v1\/(deployments|deployment-layer)/u.test(path)) return "wt-12";
  return "wt-22";
}

function representationFor(method, path) {
  if (path === "/slack/events")
    return { status: "unsupported", representation: "No iMessage representation; Slack ingress remains unchanged" };
  if (path === "/healthz")
    return { status: "unsupported", representation: "No message operation; retain HTTP liveness endpoint" };
  if (path.startsWith("/v1/admin"))
    return {
      status: "unverified",
      representation: "Authenticated existing QM admin view mounted from an iMessage action",
    };
  if (/^\/v1\/(turns|sessions|conversations|runs)/u.test(path))
    return {
      status: "unverified",
      representation: "Native text or action response with a link to the authenticated existing session view",
    };
  if (path.startsWith("/v1/approvals"))
    return {
      status: "unverified",
      representation: "Revision-bound iMessage action resolved by existing QM approval authority",
    };
  if (/^\/v1\/(files|blobs)/u.test(path))
    return { status: "unverified", representation: "Scoped iMessage attachment or authenticated existing file view" };
  if (/^\/v1\/(crons|loops|webhooks)/u.test(path))
    return {
      status: "unverified",
      representation: "Revision-bound action card plus authenticated existing automation view",
    };
  if (/^\/v1\/(memory|skills|connectors|keychain|deployments|projects|contexts)/u.test(path)) {
    return {
      status: "unverified",
      representation: "Authenticated existing QM view; no duplicate iMessage-owned resource store",
    };
  }
  if (/^\/v1\/(deliveries|surface-cache|egress-audit|auth\/broker|session-cap)/u.test(path)) {
    return {
      status: "unsupported",
      representation: "Internal transport or authority operation; not directly exposed as an iMessage action",
    };
  }
  return {
    status: "unverified",
    representation:
      method === "GET"
        ? "Authenticated existing QM view or concise read-only message"
        : "Checked QM action with explicit unsupported fallback",
  };
}

function acceptanceTest(path) {
  const tests = [
    ["/v1/turns", "test/turn-options.test.ts"],
    ["/v1/approvals", "test/slack-approval-cards.test.ts"],
    ["/v1/runs", "test/run-store.test.ts"],
    ["/v1/deliveries", "test/turn-delivery-dedup.test.ts"],
    ["/v1/sessions", "test/session-store.test.ts"],
    ["/v1/conversations", "test/slack-conversation.test.ts"],
    ["/v1/files", "test/file-upload-routes.test.ts"],
    ["/v1/memory", "test/notebook.test.ts"],
    ["/v1/skills", "test/skills-http.test.ts"],
    ["/v1/connectors", "test/connectors.test.ts"],
    ["/v1/keychain", "test/keychain.test.ts"],
    ["/v1/crons", "test/cron-store.test.ts"],
    ["/v1/loops", "test/loop-routes.test.ts"],
    ["/v1/webhooks", "test/webhook-routes.test.ts"],
    ["/v1/projects", "test/projects.test.ts"],
    ["/v1/directory", "test/directory-resolve.test.ts"],
    ["/v1/reach", "test/reach.test.ts"],
    ["/v1/deployments", "test/agent-deployment-fetch.test.ts"],
    ["/v1/admin", "test/admin-scopes-directory.test.ts"],
    ["/slack/events", "test/slack-http-events.test.ts"],
  ];
  return tests.find(([prefix]) => path.startsWith(prefix))?.[1] ?? "test/route-table.test.ts";
}

function ownerFor(path) {
  if (path.startsWith("/v1/admin")) return "qm-admin";
  if (path === "/slack/events") return "qm-slack";
  return "qm-core";
}

const routes = [...rawRoutes, ...apiRoutes]
  .filter((route) => "path" in route)
  .map((route) => {
    const id = parityId(route.method, route.path);
    return {
      parityId: id,
      method: route.method,
      path: route.path,
      auth: route.auth,
      currentOwner: ownerFor(route.path),
      routeModule: routeSource(route.path),
      handler: route.handle.name || "anonymous",
      surfaceHandler: viewFor(route.path) === null ? null : "plugins/web-ui/server/index.ts",
      view: viewFor(route.path),
      acceptanceTest: acceptanceTest(route.path),
    };
  });

const operations = routes.map((route) => {
  const proposal = representationFor(route.method, route.path);
  return {
    id: route.parityId,
    currentOwner: route.currentOwner,
    existingRoute: `${route.method} ${route.path}`,
    existingHandler: `${route.routeModule}#${route.handler}`,
    existingView: route.view,
    proposedIMessageRepresentation: proposal.representation,
    responsibleLane: laneFor(route.method, route.path),
    status: proposal.status,
    acceptanceTest: route.acceptanceTest,
  };
});

const files = gitFiles();
const tests = files.filter(
  (path) => path.startsWith("test/") || (path.startsWith("plugins/") && path.includes("/test/")),
);
const inventory = {
  schemaVersion: 1,
  generatedAt,
  baseline,
  fileAccounting: "All listed files are inventoried by path. Only reviewedFiles are claimed as read for WT00.",
  trackedAndFoundationFiles: files.map((path) => ({
    path,
    state: reviewedFiles.includes(path) ? "read" : "inventoried",
  })),
  reviewedFiles,
  routes,
  surfaceHandlers: [
    {
      path: "src/api/slack-core-client.ts",
      state: "read",
      parityIds: routes
        .filter(
          (route) =>
            route.path === "/slack/events" ||
            route.path.startsWith("/v1/turns") ||
            route.path.startsWith("/v1/approvals"),
        )
        .map((route) => route.parityId),
    },
    {
      path: "src/api/app-turn.ts",
      state: "read",
      parityIds: routes
        .filter((route) => route.path.startsWith("/v1/turns") || route.path.startsWith("/v1/runs"))
        .map((route) => route.parityId),
    },
    {
      path: "src/reach/reach.ts",
      state: "read",
      parityIds: routes.filter((route) => route.path.startsWith("/v1/reach")).map((route) => route.parityId),
    },
    {
      path: "plugins/web-ui/server/index.ts",
      state: "inventoried",
      parityIds: routes.filter((route) => route.surfaceHandler !== null).map((route) => route.parityId),
    },
  ],
  uiViews: [...new Set(routes.map((route) => route.view).filter(Boolean))].sort().map((path) => ({
    path,
    state: reviewedFiles.includes(path) ? "read" : "inventoried",
    parityIds: routes.filter((route) => route.view === path).map((route) => route.parityId),
  })),
  tests: tests.map((path) => ({
    path,
    state: "inventoried",
    parityIds: routes.filter((route) => route.acceptanceTest === path).map((route) => route.parityId),
  })),
};

await mkdir(resolve(root, "docs/imessage"), { recursive: true });
await writeFile(resolve(root, "docs/imessage/repository-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
await writeFile(
  resolve(root, "docs/imessage/parity.json"),
  `${JSON.stringify({ schemaVersion: 1, generatedAt, baseline, operations }, null, 2)}\n`,
);
process.stdout.write(`INVENTORIED:${files.length}:${routes.length}:${tests.length}\n`);
