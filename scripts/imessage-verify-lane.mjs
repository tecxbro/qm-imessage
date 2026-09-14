#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const correctionsUrl = new URL("./imessage-corrections.mjs", import.meta.url);
const corrections = existsSync(fileURLToPath(correctionsUrl)) ? await import(correctionsUrl.href) : undefined;

export function repairProvenance(options) {
  if (corrections !== undefined) return corrections.validateRepairProvenance(options);
  if ((options.checkpoint.repairContributions ?? []).length > 0) throw new Error("REPAIR_HELPER_MISSING");
  return {
    contributions: [],
    paths: [],
    requiredTests: [],
    finalRepairForPath: () => undefined,
    requireOriginalPath: () => {},
  };
}

export function repairCoordinatorIdentity(options) {
  const declared = options.checkpoint.repairContributions;
  if (declared === undefined || (Array.isArray(declared) && declared.length === 0)) return undefined;
  if (corrections === undefined) throw new Error("REPAIR_HELPER_MISSING");
  return corrections.resolveRepairCoordinatorIdentity(options);
}

export function run(command, args, cwd, options = {}) {
  const environment = { ...process.env, ...options.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n") ||
        `COMMAND_FAILED:${command}:${args.join(" ")}`,
    );
  }
  return { status: result.status ?? 1, stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "" };
}

export function git(root, args, options = {}) {
  return run("git", ["-C", root, ...args], root, options);
}

export function matches(path, pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else source += character.replace(/[\\^$+?.()|{}[\]]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u").test(path);
}

function splitZero(value) {
  return value.split("\0").filter(Boolean);
}

function nameStatusPaths(value) {
  const fields = splitZero(value);
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    const path = fields[index + 1];
    if (status === undefined || path === undefined) throw new Error("INVALID_GIT_NAME_STATUS");
    paths.push(path);
    index += 1;
    if (status.startsWith("R") || status.startsWith("C")) {
      const destination = fields[index + 1];
      if (destination === undefined) throw new Error("INVALID_GIT_RENAME_STATUS");
      paths.push(destination);
      index += 1;
    }
  }
  return paths;
}

export function changedPaths(root, base) {
  const ranges = [
    git(root, ["diff", "--name-status", "-z", `${base}..HEAD`], { capture: true }).stdout,
    git(root, ["diff", "--name-status", "-z"], { capture: true }).stdout,
    git(root, ["diff", "--cached", "--name-status", "-z"], { capture: true }).stdout,
  ];
  const untracked = splitZero(
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"], { capture: true }).stdout,
  );
  return [...new Set([...ranges.flatMap(nameStatusPaths), ...untracked])].sort();
}

function repositoryContext(root, ownership) {
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { capture: true }).stdout;
  const main = common.endsWith("/.git") ? dirname(common) : root;
  const workspace = dirname(main);
  const origin = git(root, ["remote", "get-url", "origin"], { capture: true }).stdout.replace(/\.git$/u, "");
  if (origin !== ownership.repository.replace(/\.git$/u, "")) throw new Error(`ORIGIN_MISMATCH:${origin}`);
  return { main, workspace };
}

function requireIdentity(root, branch, worktree, context) {
  const expectedPath = resolve(context.workspace, worktree);
  const canonicalWorkspace = realpathSync(context.workspace);
  const canonicalExpectedPath = existsSync(expectedPath) ? realpathSync(expectedPath) : undefined;
  if (
    canonicalExpectedPath === undefined ||
    lstatSync(expectedPath).isSymbolicLink() ||
    (canonicalExpectedPath !== canonicalWorkspace && !canonicalExpectedPath.startsWith(`${canonicalWorkspace}/`)) ||
    realpathSync(root) !== canonicalExpectedPath
  ) {
    throw new Error(`WORKTREE_PATH_MISMATCH:${root}:${expectedPath}`);
  }
  const actualBranch = git(root, ["branch", "--show-current"], { capture: true }).stdout;
  if (actualBranch !== branch) throw new Error(`BRANCH_MISMATCH:${actualBranch}:${branch}`);
  const registered = git(context.main, ["worktree", "list", "--porcelain"], { capture: true }).stdout;
  if (!registered.split("\n").includes(`worktree ${realpathSync(expectedPath)}`)) {
    throw new Error(`WORKTREE_NOT_REGISTERED:${expectedPath}`);
  }
}

function resolveCommit(root, ref, label) {
  const result = git(root, ["rev-parse", "--verify", `${ref}^{commit}`], { capture: true, allowFailure: true });
  if (result.status !== 0 || result.stdout.length === 0) throw new Error(`${label}_MISSING:${ref}`);
  return result.stdout;
}

function resolveTagCommit(root, tag, label) {
  const result = git(root, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], {
    capture: true,
    allowFailure: true,
  });
  if (result.status !== 0 || result.stdout.length === 0) throw new Error(`${label}_MISSING:${tag}`);
  return result.stdout;
}

function requireRegularFileInside(root, path, label) {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
    throw new Error(`${label}_NOT_REGULAR:${path}`);
  }
  const canonicalRoot = realpathSync(root);
  const canonicalPath = realpathSync(path);
  if (!canonicalPath.startsWith(`${canonicalRoot}/`)) throw new Error(`${label}_OUTSIDE:${path}`);
  return canonicalPath;
}

const checkpointPaths = {
  A: "docs/imessage/integration/foundation-checkpoint-r2.json",
  B: "docs/imessage/integration/checkpoint-1.json",
  C: "docs/imessage/integration/checkpoint-2.json",
  D: "docs/imessage/integration/checkpoint-3.json",
};

function immutableCheckpoint(integrationRoot, checkpointPath, label) {
  const absolute = resolve(integrationRoot, checkpointPath);
  requireRegularFileInside(integrationRoot, absolute, label);
  const additions = git(integrationRoot, ["log", "--reverse", "--format=%H", "--diff-filter=A", "--", checkpointPath], {
    capture: true,
  })
    .stdout.split("\n")
    .filter(Boolean);
  const introduction = additions[0];
  if (introduction === undefined) throw new Error(`${label}_NOT_COMMITTED:${checkpointPath}`);
  const introduced = git(integrationRoot, ["show", `${introduction}:${checkpointPath}`], { capture: true }).stdout;
  const introducedBlob = git(integrationRoot, ["rev-parse", `${introduction}:${checkpointPath}`], {
    capture: true,
  }).stdout;
  const atHeadBlob = git(integrationRoot, ["rev-parse", `HEAD:${checkpointPath}`], {
    capture: true,
    allowFailure: true,
  });
  const worktreeBlob = git(integrationRoot, ["hash-object", absolute], { capture: true, allowFailure: true });
  if (
    atHeadBlob.status !== 0 ||
    atHeadBlob.stdout !== introducedBlob ||
    worktreeBlob.status !== 0 ||
    worktreeBlob.stdout !== introducedBlob
  ) {
    throw new Error(`${label}_MUTATED:${checkpointPath}:${introduction}`);
  }
  return JSON.parse(introduced);
}

export function verifyCheckpointScope(
  integrationRoot,
  main,
  target,
  ownership,
  checkpoint,
  contributions,
  label,
  repairTests = [],
) {
  const requiredTests = new Set(ownership.integration.testFiles);
  const requiredTypechecks = new Set(ownership.integration.typecheckPackages);
  for (const contribution of contributions) {
    const lane = ownership.lanes[contribution.laneId];
    for (const testFile of lane.testFiles) requiredTests.add(testFile);
    for (const packagePath of lane.typecheckPackages ?? []) requiredTypechecks.add(packagePath);
  }
  for (const testFile of repairTests) requiredTests.add(testFile);
  const checkpointTests = [...new Set(checkpoint.testFiles ?? [])].sort();
  const checkpointTypechecks = [...new Set(checkpoint.typecheckPackages ?? [])].sort();
  if (JSON.stringify(checkpointTests) !== JSON.stringify([...requiredTests].sort())) {
    throw new Error(`${label}_TEST_SCOPE_MISMATCH:${checkpointTests.join(",")}`);
  }
  if (JSON.stringify(checkpointTypechecks) !== JSON.stringify([...requiredTypechecks].sort())) {
    throw new Error(`${label}_TYPECHECK_SCOPE_MISMATCH:${checkpointTypechecks.join(",")}`);
  }
  const temporary = mkdtempSync(resolve(tmpdir(), "qm-imessage-checkpoint-"));
  let gateError;
  let cleanupError;
  try {
    git(main, ["worktree", "add", "--detach", temporary, target], { capture: true });
    for (const contribution of contributions) {
      requireRegularFileInside(
        temporary,
        resolve(temporary, `docs/imessage/lanes/${contribution.laneId}.md`),
        `${label}_LANE_DOCUMENT`,
      );
    }
    for (const [dependencyPath, lockPath] of [
      ["node_modules", "package-lock.json"],
      ["plugins/photon/node_modules", "plugins/photon/package-lock.json"],
      ["plugins/web-ui/node_modules", "plugins/web-ui/package-lock.json"],
      ["plugins/admin/node_modules", "plugins/admin/package-lock.json"],
      ["cli/node_modules", "cli/package-lock.json"],
    ]) {
      const source = resolve(integrationRoot, dependencyPath);
      const destination = resolve(temporary, dependencyPath);
      if (existsSync(source) && !existsSync(destination)) {
        const sourceLock = resolve(integrationRoot, lockPath);
        const targetLock = resolve(temporary, lockPath);
        requireRegularFileInside(integrationRoot, sourceLock, `${label}_DEPENDENCY_LOCK`);
        requireRegularFileInside(temporary, targetLock, `${label}_DEPENDENCY_LOCK`);
        if (!readFileSync(sourceLock).equals(readFileSync(targetLock))) {
          throw new Error(`${label}_DEPENDENCY_LOCK_MISMATCH:${lockPath}`);
        }
        mkdirSync(dirname(destination), { recursive: true });
        symlinkSync(realpathSync(source), destination, "dir");
      }
    }
    runSourceValidation(temporary);
    runTestFiles(temporary, checkpointTests);
    runTypechecks(temporary, checkpointTypechecks);
  } catch (error) {
    gateError = error;
  } finally {
    const cleanup = git(main, ["worktree", "remove", "--force", temporary], { capture: true, allowFailure: true });
    if (cleanup.status === 0) rmSync(temporary, { recursive: true, force: true });
    else cleanupError = new Error(`${label}_TEMP_WORKTREE_CLEANUP_FAILED:${cleanup.stderr}`);
  }
  if (gateError !== undefined) throw gateError;
  if (cleanupError !== undefined) throw cleanupError;
}

export function requireBase(root, ref, expectedCommit) {
  const resolved = /^[a-f0-9]{40}$/u.test(ref)
    ? resolveCommit(root, ref, "IMMUTABLE_BASE")
    : resolveTagCommit(root, ref, "IMMUTABLE_BASE");
  if (expectedCommit !== undefined && resolved !== expectedCommit) {
    throw new Error(`IMMUTABLE_BASE_TARGET_MISMATCH:${ref}:${resolved}:${expectedCommit}`);
  }
  if (
    git(root, ["merge-base", "--is-ancestor", resolved, "HEAD"], { capture: true, allowFailure: true }).status !== 0
  ) {
    throw new Error(`IMMUTABLE_BASE_NOT_ANCESTOR:${resolved}`);
  }
  return resolved;
}

function waveCheckpoint(context, ownership, wave, selectedIdentity) {
  const identity = selectedIdentity ?? { ...ownership.integration, workspace: context.workspace };
  const identityContext = { ...context, workspace: identity.workspace };
  const integrationRoot = resolve(identity.workspace, identity.worktree);
  requireIdentity(integrationRoot, identity.branch, identity.worktree, identityContext);
  const checkpointPath = checkpointPaths[wave];
  if (checkpointPath === undefined) throw new Error(`WAVE_CHECKPOINT_UNSUPPORTED:${wave}`);
  if (wave === "A" && ownership.integration.foundationCheckpoint !== checkpointPath) {
    throw new Error(`FOUNDATION_CHECKPOINT_PATH_MISMATCH:${ownership.integration.foundationCheckpoint}`);
  }
  const checkpoint = immutableCheckpoint(integrationRoot, checkpointPath, "WAVE_CHECKPOINT");
  const tagTarget = resolveTagCommit(context.main, checkpoint.tag, "FOUNDATION_TAG");
  const expectedTag = wave === "A" ? ownership.integration.baseRef : undefined;
  if (
    (expectedTag !== undefined && checkpoint.tag !== expectedTag) ||
    checkpoint.tagTarget !== checkpoint.implementationCommit ||
    tagTarget !== checkpoint.tagTarget
  ) {
    throw new Error(`WAVE_CHECKPOINT_MISMATCH:${checkpointPath}`);
  }
  if (
    git(context.main, ["merge-base", "--is-ancestor", ownership.reviewedFoundationCommit, tagTarget], {
      capture: true,
      allowFailure: true,
    }).status !== 0 ||
    git(context.main, ["merge-base", "--is-ancestor", tagTarget, identity.branch], {
      capture: true,
      allowFailure: true,
    }).status !== 0
  ) {
    throw new Error(`WAVE_CHECKPOINT_HISTORY_MISMATCH:${checkpointPath}`);
  }
  if (wave === "A") {
    const foundationPaths = nameStatusPaths(
      git(context.main, ["diff", "--name-status", "-z", `${ownership.reviewedFoundationCommit}..${tagTarget}`], {
        capture: true,
      }).stdout,
    );
    requireOwned(foundationPaths, ownership.integration.ownedPaths, "foundation");
  } else {
    const previousWave = { B: "A", C: "B", D: "C" }[wave];
    const previous = waveCheckpoint(context, ownership, previousWave, identity);
    const inputBase = resolveCommit(context.main, checkpoint.inputBaseCommit, "WAVE_INPUT_BASE");
    if (inputBase !== checkpoint.inputBaseCommit) {
      throw new Error(`WAVE_INPUT_BASE_TARGET_MISMATCH:${checkpoint.inputBaseCommit}`);
    }
    if (inputBase !== previous.tagTarget) {
      throw new Error(`WAVE_INPUT_BASE_MISMATCH:${checkpointPath}:${inputBase}:${previous.tagTarget}`);
    }
    const expectedLaneIds = Object.entries(ownership.lanes)
      .filter(([, lane]) => lane.wave === previousWave)
      .map(([laneId]) => laneId)
      .sort();
    const contributions = checkpoint.laneContributions ?? [];
    const actualLaneIds = contributions.map((entry) => entry.laneId).sort();
    if (JSON.stringify(actualLaneIds) !== JSON.stringify(expectedLaneIds)) {
      throw new Error(`WAVE_LANE_SET_MISMATCH:${checkpointPath}:${actualLaneIds.join(",")}`);
    }
    const contributionPaths = new Set();
    const repairs = repairProvenance({
      root: integrationRoot,
      main: context.main,
      target: tagTarget,
      checkpoint,
      ownership,
    });
    for (const contribution of contributions) {
      const lane = ownership.lanes[contribution.laneId];
      const laneBase = resolveCommit(context.main, contribution.baseCommit, "WAVE_LANE_BASE");
      const laneCommit = resolveCommit(context.main, contribution.commit, "WAVE_LANE_COMMIT");
      if (
        lane === undefined ||
        lane.wave !== previousWave ||
        laneBase !== contribution.baseCommit ||
        laneCommit !== contribution.commit ||
        laneBase !== inputBase ||
        laneCommit === laneBase ||
        git(context.main, ["merge-base", "--is-ancestor", laneBase, laneCommit], {
          capture: true,
          allowFailure: true,
        }).status !== 0 ||
        git(context.main, ["merge-base", "--is-ancestor", laneCommit, tagTarget], {
          capture: true,
          allowFailure: true,
        }).status !== 0
      ) {
        throw new Error(`WAVE_LANE_CONTRIBUTION_MISMATCH:${contribution.laneId}`);
      }
      const paths = nameStatusPaths(
        git(context.main, ["diff", "--name-status", "-z", `${laneBase}..${laneCommit}`], { capture: true }).stdout,
      );
      requireOwned(paths, lane.ownedPaths, contribution.laneId);
      for (const path of paths) {
        const repair = repairs.finalRepairForPath(path);
        if (repair !== undefined) {
          repairs.requireOriginalPath(path, laneCommit, `WAVE_LANE_CONTRIBUTION:${contribution.laneId}`);
        } else if (
          git(context.main, ["diff", "--quiet", laneCommit, tagTarget, "--", path], {
            capture: true,
            allowFailure: true,
          }).status !== 0
        ) {
          throw new Error(`WAVE_LANE_CONTRIBUTION_DRIFT:${contribution.laneId}:${path}`);
        }
      }
      paths.forEach((path) => contributionPaths.add(path));
    }
    repairs.paths.forEach((path) => contributionPaths.add(path));
    const assembled = nameStatusPaths(
      git(context.main, ["diff", "--name-status", "-z", `${inputBase}..${tagTarget}`], { capture: true }).stdout,
    );
    requireOwned(
      assembled.filter((path) => !contributionPaths.has(path)),
      ownership.integration.ownedPaths,
      `wave-${wave}`,
    );
    verifyCheckpointScope(
      integrationRoot,
      context.main,
      tagTarget,
      ownership,
      checkpoint,
      contributions,
      `WAVE_${previousWave}`,
      repairs.requiredTests,
    );
  }
  return checkpoint;
}

function expectedLaneBase(root, context, ownership, lane, selectedIdentity) {
  let expected;
  if (lane === ownership.lanes["wt-00"]) {
    if (!/^[a-f0-9]{40}$/u.test(ownership.originalBaseline)) {
      throw new Error(`ORIGINAL_BASELINE_INVALID:${ownership.originalBaseline}`);
    }
    expected = ownership.originalBaseline;
  } else {
    const checkpoint = waveCheckpoint(context, ownership, lane.wave, selectedIdentity);
    expected = checkpoint.tagTarget;
    if (checkpoint.tag !== lane.baseRef) {
      throw new Error(`IMMUTABLE_BASE_TAG_MISMATCH:${lane.baseRef}:${checkpoint.tag}`);
    }
  }
  if (lane.baseCommit !== undefined && lane.baseCommit !== expected) {
    throw new Error(`IMMUTABLE_BASE_COMMIT_MISMATCH:${lane.baseRef}:${lane.baseCommit}:${expected}`);
  }
  return expected;
}

function requireOwned(paths, patterns, label) {
  const unowned = paths.filter((path) => !patterns.some((pattern) => matches(path, pattern)));
  if (unowned.length > 0) throw new Error(`UNOWNED_PATHS:${label}:${unowned.join(",")}`);
}

function runSourceValidation(root) {
  const script = resolve(root, "scripts/imessage-sources.mjs");
  if (!existsSync(script)) throw new Error("SOURCE_VALIDATOR_MISSING:scripts/imessage-sources.mjs");
  run(process.execPath, [script, "validate"], root);
}

function packageForTest(path) {
  for (const prefix of ["plugins/photon", "plugins/web-ui", "plugins/admin", "cli"]) {
    if (path.startsWith(`${prefix}/`)) return prefix;
  }
  return ".";
}

export function runTestFiles(root, testFiles) {
  if (!Array.isArray(testFiles) || testFiles.length === 0) throw new Error("EXPECTED_TESTS_EMPTY");
  const canonicalRoot = realpathSync(root);
  for (const path of testFiles) {
    if (typeof path !== "string" || isAbsolute(path) || !path.endsWith(".test.ts") || resolve(root, path) === root) {
      throw new Error(`EXPECTED_TEST_PATH_INVALID:${path}`);
    }
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${root}/`) || !existsSync(absolute)) {
      throw new Error(`EXPECTED_TEST_MISSING_OR_OUTSIDE:${path}`);
    }
    if (lstatSync(absolute).isSymbolicLink() || !statSync(absolute).isFile()) {
      throw new Error(`EXPECTED_TEST_NOT_REGULAR:${path}`);
    }
    if (!realpathSync(absolute).startsWith(`${canonicalRoot}/`))
      throw new Error(`EXPECTED_TEST_MISSING_OR_OUTSIDE:${path}`);
    if (!/\b(?:test|it)(?:\.(?:only|skip|todo))?\s*\(/u.test(readFileSync(absolute, "utf8"))) {
      throw new Error(`EXPECTED_TESTS_UNDISCOVERED:${path}`);
    }
  }
  for (const path of testFiles) {
    const packagePath = packageForTest(path);
    const cwd = packagePath === "." ? root : resolve(root, packagePath);
    const relativeFile = packagePath === "." ? path : relative(packagePath, path);
    const flags = packagePath === "." ? ["--experimental-test-module-mocks"] : [];
    const env = ["plugins/web-ui", "plugins/admin"].includes(packagePath)
      ? { NODE_ENV: "test", ALLOW_UNSIGNED_TEST_IDENTITY: "1" }
      : {};
    const result = run(process.execPath, [...flags, "--test", relativeFile], cwd, { env, capture: true });
    const fileOnlyPass = result.stdout
      .split("\n")
      .some((line) => line.startsWith(`✔ ${relativeFile} (`) || line.startsWith(`# Subtest: ${relativeFile}`));
    const summary = new Map();
    for (const line of result.stdout.split("\n")) {
      const match = line.match(/^(?:ℹ|#) (tests|pass|fail|cancelled|skipped|todo) ([0-9]+)$/u);
      if (match !== null) summary.set(match[1], Number(match[2]));
    }
    if (
      fileOnlyPass ||
      (summary.get("tests") ?? 0) === 0 ||
      (summary.get("pass") ?? 0) === 0 ||
      summary.get("tests") !== summary.get("pass") ||
      summary.get("fail") !== 0 ||
      summary.get("cancelled") !== 0 ||
      summary.get("skipped") !== 0 ||
      summary.get("todo") !== 0
    ) {
      throw new Error(`EXPECTED_TESTS_UNDISCOVERED_OR_SKIPPED:${path}`);
    }
    process.stdout.write(`${result.stdout}\n`);
    if (result.stderr.length > 0) process.stderr.write(`${result.stderr}\n`);
  }
}

export function runTypechecks(root, packages) {
  if ((packages ?? []).length === 0) return;
  const allowed = new Set([".", "plugins/photon", "plugins/web-ui", "plugins/admin", "cli"]);
  const canonicalRoot = realpathSync(root);
  for (const packagePath of packages ?? []) {
    if (typeof packagePath !== "string" || !allowed.has(packagePath)) {
      throw new Error(`TYPECHECK_PACKAGE_INVALID:${packagePath}`);
    }
    const cwd = packagePath === "." ? root : resolve(root, packagePath);
    const canonicalCwd = existsSync(cwd) ? realpathSync(cwd) : undefined;
    if (
      canonicalCwd === undefined ||
      lstatSync(cwd).isSymbolicLink() ||
      (canonicalCwd !== canonicalRoot && !canonicalCwd.startsWith(`${canonicalRoot}/`))
    ) {
      throw new Error(`TYPECHECK_PACKAGE_OUTSIDE:${packagePath}`);
    }
    run("npm", ["run", "typecheck"], cwd);
  }
}

function verifyLane(root, ownership, laneId) {
  const lane = ownership.lanes[laneId];
  if (lane === undefined) throw new Error(`UNKNOWN_LANE:${laneId}`);
  const context = repositoryContext(root, ownership);
  requireIdentity(root, lane.branch, lane.worktree, context);
  const base = requireBase(root, lane.baseRef, expectedLaneBase(root, context, ownership, lane));
  const paths = changedPaths(root, base);
  requireOwned(paths, lane.ownedPaths, laneId);
  const requiredDoc = `docs/imessage/lanes/${laneId}.md`;
  if (!existsSync(resolve(root, requiredDoc))) throw new Error(`REQUIRED_DOCUMENT_MISSING:${requiredDoc}`);
  runSourceValidation(root);
  runTestFiles(root, lane.testFiles);
  runTypechecks(root, lane.typecheckPackages);
  process.stdout.write(`VERIFIED:${laneId}:${base}:${paths.length}\n`);
}

function verifyIntegration(root, ownership, checkpointPath) {
  if (checkpointPath === undefined) throw new Error("INTEGRATION_CHECKPOINT_REQUIRED");
  const resolvedCheckpointPath = resolve(root, checkpointPath);
  if (!resolvedCheckpointPath.startsWith(`${root}/`))
    throw new Error(`INTEGRATION_CHECKPOINT_OUTSIDE_REPOSITORY:${checkpointPath}`);
  requireRegularFileInside(root, resolvedCheckpointPath, "INTEGRATION_CHECKPOINT");
  const checkpoint = JSON.parse(readFileSync(resolvedCheckpointPath, "utf8"));
  const context = repositoryContext(root, ownership);
  const target = resolveCommit(root, "HEAD", "INTEGRATION_TARGET");
  const selectedIdentity = repairCoordinatorIdentity({ root, main: context.main, target, checkpoint, ownership }) ?? {
    ...ownership.integration,
    workspace: context.workspace,
  };
  const identityContext = { ...context, workspace: selectedIdentity.workspace };
  requireIdentity(root, selectedIdentity.branch, selectedIdentity.worktree, identityContext);
  const inputBase = resolveCommit(root, checkpoint.inputBaseCommit, "INPUT_BASE");
  if (inputBase !== checkpoint.inputBaseCommit) throw new Error(`INPUT_BASE_TARGET_MISMATCH:${inputBase}`);
  const permittedInputBases = new Set([ownership.reviewedFoundationCommit]);
  for (const wave of ["A", "B", "C", "D"]) {
    const checkpointPath = checkpointPaths[wave];
    if (existsSync(resolve(root, checkpointPath))) {
      permittedInputBases.add(waveCheckpoint(context, ownership, wave, selectedIdentity).tagTarget);
    }
  }
  if (!permittedInputBases.has(inputBase)) throw new Error(`INPUT_BASE_NOT_RECORDED:${inputBase}`);
  if (
    git(root, ["merge-base", "--is-ancestor", inputBase, "HEAD"], { capture: true, allowFailure: true }).status !== 0
  ) {
    throw new Error(`INPUT_BASE_NOT_ANCESTOR:${inputBase}`);
  }
  const contributionPaths = new Set();
  const localPaths = new Set(changedPaths(root, "HEAD"));
  const repairs = repairProvenance({ root, main: context.main, target, checkpoint, ownership });
  for (const contribution of checkpoint.laneContributions ?? []) {
    const lane = ownership.lanes[contribution.laneId];
    if (lane === undefined || contribution.laneId === "wt-00")
      throw new Error(`INVALID_LANE_CONTRIBUTION:${contribution.laneId}`);
    const laneBase = resolveCommit(root, contribution.baseCommit, "LANE_BASE");
    const laneCommit = resolveCommit(root, contribution.commit, "LANE_COMMIT");
    if (laneBase !== contribution.baseCommit) throw new Error(`LANE_BASE_TARGET_MISMATCH:${contribution.laneId}`);
    if (laneCommit !== contribution.commit) throw new Error(`LANE_COMMIT_TARGET_MISMATCH:${contribution.laneId}`);
    const configuredBase = resolveTagCommit(root, lane.baseRef, "LANE_CONFIGURED_BASE");
    const expectedBase = expectedLaneBase(root, context, ownership, lane, selectedIdentity);
    if (configuredBase !== expectedBase) {
      throw new Error(
        `LANE_CONFIGURED_BASE_TARGET_MISMATCH:${contribution.laneId}:${configuredBase}:${lane.baseCommit}`,
      );
    }
    if (laneBase !== configuredBase) {
      throw new Error(`LANE_CHECKPOINT_BASE_MISMATCH:${contribution.laneId}:${laneBase}:${configuredBase}`);
    }
    if (
      git(root, ["merge-base", "--is-ancestor", laneBase, laneCommit], { capture: true, allowFailure: true }).status !==
      0
    ) {
      throw new Error(`LANE_BASE_NOT_ANCESTOR:${contribution.laneId}`);
    }
    if (
      git(root, ["merge-base", "--is-ancestor", laneCommit, "HEAD"], { capture: true, allowFailure: true }).status !== 0
    ) {
      throw new Error(`LANE_COMMIT_NOT_ASSEMBLED:${contribution.laneId}:${laneCommit}`);
    }
    const paths = nameStatusPaths(
      git(root, ["diff", "--name-status", "-z", `${laneBase}..${laneCommit}`], { capture: true }).stdout,
    );
    requireOwned(paths, lane.ownedPaths, contribution.laneId);
    for (const path of paths) {
      if (localPaths.has(path)) throw new Error(`LANE_CONTRIBUTION_LOCAL_DRIFT:${contribution.laneId}:${path}`);
      const repair = repairs.finalRepairForPath(path);
      if (repair !== undefined) {
        repairs.requireOriginalPath(path, laneCommit, `LANE_CONTRIBUTION:${contribution.laneId}`);
      } else if (
        git(root, ["diff", "--quiet", laneCommit, "HEAD", "--", path], { capture: true, allowFailure: true }).status !==
        0
      ) {
        throw new Error(`LANE_CONTRIBUTION_DRIFT:${contribution.laneId}:${path}`);
      }
      contributionPaths.add(path);
    }
  }
  repairs.paths.forEach((path) => contributionPaths.add(path));
  const assembledPaths = changedPaths(root, inputBase);
  const integrationPaths = assembledPaths.filter((path) => !contributionPaths.has(path));
  requireOwned(integrationPaths, ownership.integration.ownedPaths, "integration");
  const requiredTests = new Set(ownership.integration.testFiles);
  const requiredTypechecks = new Set(ownership.integration.typecheckPackages);
  for (const contribution of checkpoint.laneContributions ?? []) {
    for (const testFile of ownership.lanes[contribution.laneId].testFiles) requiredTests.add(testFile);
    for (const packagePath of ownership.lanes[contribution.laneId].typecheckPackages ?? []) {
      requiredTypechecks.add(packagePath);
    }
  }
  for (const testFile of repairs.requiredTests) requiredTests.add(testFile);
  const checkpointTests = [...new Set(checkpoint.testFiles ?? [])].sort();
  const checkpointTypechecks = [...new Set(checkpoint.typecheckPackages ?? [])].sort();
  if (JSON.stringify(checkpointTests) !== JSON.stringify([...requiredTests].sort())) {
    throw new Error(`INTEGRATION_TEST_SCOPE_MISMATCH:${checkpointTests.join(",")}`);
  }
  if (JSON.stringify(checkpointTypechecks) !== JSON.stringify([...requiredTypechecks].sort())) {
    throw new Error(`INTEGRATION_TYPECHECK_SCOPE_MISMATCH:${checkpointTypechecks.join(",")}`);
  }
  runSourceValidation(root);
  runTestFiles(root, checkpointTests);
  runTypechecks(root, checkpointTypechecks);
  process.stdout.write(
    `VERIFIED:integration:${inputBase}:${checkpoint.laneContributions?.length ?? 0}:${integrationPaths.length}\n`,
  );
}

export function main(root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), argv = process.argv.slice(2)) {
  if (realpathSync(process.cwd()) !== realpathSync(root)) {
    throw new Error(`INVOCATION_PATH_MISMATCH:${process.cwd()}:${root}`);
  }
  const ownership = JSON.parse(readFileSync(resolve(root, "docs/imessage/ownership.json"), "utf8"));
  if (argv[0] === "integration") {
    if (argv[1] !== "--checkpoint") throw new Error("USAGE:imessage-verify-lane.mjs integration --checkpoint <path>");
    verifyIntegration(root, ownership, argv[2]);
    return;
  }
  if (argv.length !== 1) throw new Error("USAGE:imessage-verify-lane.mjs <wt-NN>");
  verifyLane(root, ownership, argv[0]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
