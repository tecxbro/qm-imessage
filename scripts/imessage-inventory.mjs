#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { apiRoutes, rawRoutes } from "../src/api/routes/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedAt = new Date().toISOString();
const baseline = "0e3f9b9739f5ac695aa02672860ead64da88105e";
const ownership = JSON.parse(readFileSync(resolve(root, "docs/imessage/ownership.json"), "utf8"));
const reviewedFiles = [
  "AGENTS.md",
  "README.md",
  "deployment.md",
  "package.json",
  "plugins/chassis/package.json",
  "plugins/chassis/src/photon-contract.ts",
  "plugins/photon/package.json",
  "plugins/photon/src/ports.ts",
  "plugins/photon/test/contracts.test.ts",
  "plugins/photon/test/fixtures.ts",
  "plugins/web-ui/package.json",
  "plugins/web-ui/src/photon/contracts.ts",
  "docs/imessage/architecture.md",
  "docs/imessage/contracts.md",
  "docs/imessage/workflow.md",
  "docs/imessage/ownership.json",
  "docs/imessage/parity.json",
  "docs/imessage/repository-inventory.json",
  "docs/imessage/source-lock.json",
  "docs/imessage/lanes/wt-00.md",
  "docs/imessage/integration/foundation-repair.md",
  "scripts/imessage-sources.mjs",
  "scripts/imessage-inventory.mjs",
  "scripts/imessage-worktrees.mjs",
  "scripts/imessage-verify-lane.mjs",
  "test/imessage-foundation-ownership.test.ts",
  "test/imessage-foundation-sources.test.ts",
  "test/imessage-foundation-tooling.test.ts",
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

const explicitFoundationAdditions = [
  "docs/imessage/contracts.md",
  "docs/imessage/integration/foundation-repair-input.json",
  "docs/imessage/integration/foundation-repair.md",
  "test/imessage-foundation-ownership.test.ts",
  "test/imessage-foundation-sources.test.ts",
  "test/imessage-foundation-tooling.test.ts",
];

function gitFiles() {
  const tracked = execFileSync("git", ["-C", root, "ls-files", "--cached"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  const additions = explicitFoundationAdditions.filter((path) => existsSync(resolve(root, path)));
  return [...new Set([...tracked, ...additions])].sort();
}

const files = gitFiles();
const fileContents = new Map();

function textOf(path) {
  let value = fileContents.get(path);
  if (value === undefined) {
    value = readFileSync(resolve(root, path), "utf8");
    fileContents.set(path, value);
  }
  return value;
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

function exactLiteralReferences(candidates, value) {
  const literals = [`"${value}"`, `'${value}'`, `\`${value}\``];
  return candidates.filter((path) => literals.some((literal) => textOf(path).includes(literal)));
}

const routeFiles = files.filter((path) => path.startsWith("src/api/routes/") && path.endsWith(".ts"));
const viewFiles = files.filter((path) => path.startsWith("plugins/web-ui/src/") && path.endsWith(".ts"));
const testFiles = files.filter(
  (path) =>
    path.endsWith(".test.ts") &&
    !path.startsWith("test/imessage-foundation-") &&
    (path.startsWith("test/") || path.includes("/test/")),
);

function routeSource(method, path) {
  const candidates = exactLiteralReferences(routeFiles, path).filter((file) =>
    textOf(file).includes(`method: "${method}"`),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function viewsFor(path) {
  return exactLiteralReferences(viewFiles, path);
}

function laneFor(path) {
  if (path === "/slack/events" || path === "/healthz") return "integration";
  if (path === "/v1/reach") return "wt-05";
  if (/^\/v1\/sessions\/:id\/approvals(?:\/|$)/u.test(path)) return "wt-18";
  if (/^\/v1\/sessions\/:id\/background(?:\/|$)/u.test(path)) return "wt-20";
  if (/^\/v1\/(turns|runs|sessions|conversations|session-state|shared-sessions|public-shares)/u.test(path))
    return "wt-17";
  if (path.startsWith("/v1/approvals")) return "wt-18";
  if (/^\/v1\/(surface-context|surface-file)/u.test(path)) return "wt-08";
  if (/^\/v1\/(files|blobs|memory|contexts|scope-resources|ui-state|soul|skills)/u.test(path)) return "wt-19";
  if (/^\/v1\/(crons|loops|loop-items|webhooks|triggers)/u.test(path)) return "wt-20";
  if (
    /^\/v1\/(admin|applications|settings|runtime-config|connectors|keychain|credentials|user-model-auth|auth\/broker|projects|directory|principals|grants|share|pins|environments|emoji|deployments|deployment-layer)/u.test(
      path,
    )
  )
    return "wt-21";
  if (path.startsWith("/v1/deliveries")) return "wt-09";
  return null;
}

function infrastructureLanes(path) {
  const dependencies = ["wt-01", "wt-06", "wt-08"];
  if (/^\/v1\/(turns|runs|sessions|conversations|surface-context|surface-file|reach)/u.test(path))
    dependencies.push("wt-05");
  if (path.startsWith("/v1/deliveries")) dependencies.push("wt-03", "wt-09");
  return [...new Set(dependencies)];
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

function ownerFor(path) {
  if (path.startsWith("/v1/admin")) return "qm-admin";
  if (path === "/slack/events") return "qm-slack";
  return "qm-core";
}

const routes = [...rawRoutes, ...apiRoutes]
  .filter((route) => "path" in route)
  .map((route) => {
    const id = parityId(route.method, route.path);
    const routeModule = routeSource(route.method, route.path);
    const viewReferences = viewsFor(route.path);
    const regressionTests = exactLiteralReferences(testFiles, route.path);
    return {
      parityId: id,
      method: route.method,
      path: route.path,
      auth: route.auth,
      currentOwner: ownerFor(route.path),
      routeModule,
      handler: route.handle.name || "anonymous",
      surfaceHandler: null,
      view: viewReferences[0] ?? null,
      viewReferences,
      existingRegressionTests: regressionTests,
      routeEvidence:
        routeModule === null
          ? "runtime-registered handler; exact source module unverified"
          : "runtime-registered handler plus exact route literal in one source module",
      viewEvidence:
        viewReferences.length === 0
          ? "no exact existing view reference verified"
          : "existing files containing the exact route literal; consumer behavior not reviewed by WT00",
    };
  });

const operations = routes.map((route) => {
  const proposal = representationFor(route.method, route.path);
  const responsibleLane = laneFor(route.path);
  const plannedTests = responsibleLane?.startsWith("wt-") ? (ownership.lanes[responsibleLane]?.testFiles ?? []) : [];
  return {
    id: route.parityId,
    currentOwner: route.currentOwner,
    existingRoute: `${route.method} ${route.path}`,
    existingHandler: route.routeModule === null ? null : `${route.routeModule}#${route.handler}`,
    existingView: route.view,
    proposedIMessageRepresentation: proposal.representation,
    responsibleLane,
    responsibilityEvidence:
      responsibleLane === null
        ? "No original lane mapping was verified for this existing operation."
        : "Mapped from the restored original lane responsibility, not inferred from the HTTP method.",
    infrastructureDependencies: proposal.status === "unsupported" ? [] : infrastructureLanes(route.path),
    status: proposal.status,
    existingRegressionTests: route.existingRegressionTests,
    plannedIMessageAcceptanceTests: plannedTests,
    plannedTestEvidence:
      plannedTests.length === 0
        ? "No lane-specific planned acceptance test is assigned to this operation."
        : "The owning lane must create and execute these assigned test files; listing them is not execution evidence.",
    testEvidence:
      route.existingRegressionTests.length === 0
        ? "No exact existing regression reference was verified; the responsible lane must add and execute its planned iMessage acceptance test."
        : "Exact route literals were found in the listed existing tests, but those tests were not executed as iMessage acceptance evidence.",
  };
});

const tests = files.filter(
  (path) => path.startsWith("test/") || (path.startsWith("plugins/") && path.includes("/test/")),
);
const inventory = {
  schemaVersion: 1,
  generatedAt,
  baseline,
  fileAccounting:
    "Tracked files plus the named explicitFoundationAdditions are inventoried. Arbitrary untracked workspace files are excluded. Only reviewedFiles are claimed as read for WT00.",
  explicitFoundationAdditions,
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
    parityIds: routes.filter((route) => route.existingRegressionTests.includes(path)).map((route) => route.parityId),
  })),
};

await mkdir(resolve(root, "docs/imessage"), { recursive: true });
await writeFile(resolve(root, "docs/imessage/repository-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
await writeFile(
  resolve(root, "docs/imessage/parity.json"),
  `${JSON.stringify({ schemaVersion: 1, generatedAt, baseline, operations }, null, 2)}\n`,
);
process.stdout.write(`INVENTORIED:${files.length}:${routes.length}:${tests.length}\n`);
