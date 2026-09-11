#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { verifyCheckpointScope } from "./imessage-verify-lane.mjs";

function git(cwd, args, allowFailure = false) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function normalizePath(path) {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function matches(path, pattern) {
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

function nameStatusPaths(value) {
  const fields = value.split("\0").filter(Boolean);
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

function changedPaths(main, base, target) {
  return nameStatusPaths(git(main, ["diff", "--find-renames", "--name-status", "-z", `${base}..${target}`]).stdout);
}

function exactCommit(main, value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) throw new Error(`${label}_NOT_SHA:${value}`);
  const resolved = git(main, ["rev-parse", "--verify", `${value}^{commit}`], true);
  if (resolved.status !== 0 || resolved.stdout !== value) throw new Error(`${label}_TARGET_MISMATCH:${value}`);
  return value;
}

const checkpointPaths = {
  A: "docs/imessage/integration/foundation-checkpoint.json",
  B: "docs/imessage/integration/checkpoint-1.json",
  C: "docs/imessage/integration/checkpoint-2.json",
  D: "docs/imessage/integration/checkpoint-3.json",
};

function repositoryContext(scriptRoot, ownership) {
  const common = git(scriptRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout;
  const main = common.endsWith("/.git") ? dirname(common) : scriptRoot;
  const workspace = dirname(main);
  const origin = git(main, ["remote", "get-url", "origin"]).stdout.replace(/\.git$/u, "");
  if (origin !== ownership.repository.replace(/\.git$/u, "")) throw new Error(`ORIGIN_MISMATCH:${origin}`);
  return { main: normalizePath(main), workspace: normalizePath(workspace) };
}

export function registeredWorktrees(main) {
  const output = git(main, ["worktree", "list", "--porcelain"]).stdout;
  const entries = [];
  let current;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: normalizePath(line.slice(9)) };
      entries.push(current);
    } else if (line.startsWith("HEAD ") && current !== undefined) current.head = line.slice(5);
    else if (line.startsWith("branch ") && current !== undefined)
      current.branch = line.slice(7).replace(/^refs\/heads\//u, "");
  }
  return entries;
}

function resolveBase(main, laneId, lane, expectedCommit) {
  const result = git(main, ["rev-parse", "--verify", `refs/tags/${lane.baseRef}^{commit}`], true);
  if (result.status !== 0 || result.stdout.length === 0) throw new Error(`BASE_REF_MISSING:${laneId}:${lane.baseRef}`);
  if (result.stdout !== expectedCommit || (lane.baseCommit !== undefined && lane.baseCommit !== expectedCommit)) {
    throw new Error(`BASE_REF_CONFLICT:${laneId}:${lane.baseRef}:${result.stdout}:${expectedCommit}`);
  }
  return result.stdout;
}

function requireIntegrationCheckout(scriptRoot, context, ownership, entries) {
  const expected = resolve(context.workspace, ownership.integration.worktree);
  if (
    !existsSync(expected) ||
    lstatSync(expected).isSymbolicLink() ||
    !realpathSync(expected).startsWith(`${realpathSync(context.workspace)}/`) ||
    normalizePath(scriptRoot) !== normalizePath(expected)
  ) {
    throw new Error(`INTEGRATION_INVOCATION_REQUIRED:${scriptRoot}:${expected}`);
  }
  const entry = entries.find((candidate) => candidate.path === normalizePath(expected));
  if (entry?.branch !== ownership.integration.branch) {
    throw new Error(`INTEGRATION_BRANCH_MISMATCH:${entry?.branch ?? "unregistered"}:${ownership.integration.branch}`);
  }
  requireClean(expected, "integration");
}

function requireWaveCheckpoint(scriptRoot, context, ownership, wave) {
  const checkpointPath = checkpointPaths[wave];
  if (checkpointPath === undefined) throw new Error(`WAVE_CHECKPOINT_UNSUPPORTED:${wave}`);
  if (wave === "A" && ownership.integration.foundationCheckpoint !== checkpointPath) {
    throw new Error(`FOUNDATION_CHECKPOINT_PATH_MISMATCH:${ownership.integration.foundationCheckpoint}`);
  }
  const path = resolve(scriptRoot, checkpointPath);
  if (
    !existsSync(path) ||
    lstatSync(path).isSymbolicLink() ||
    !statSync(path).isFile() ||
    !realpathSync(path).startsWith(`${realpathSync(scriptRoot)}/`)
  ) {
    throw new Error(`WAVE_CHECKPOINT_INVALID:${path}`);
  }
  const introductions = git(
    scriptRoot,
    ["log", "--reverse", "--format=%H", "--diff-filter=A", "--", checkpointPath],
    true,
  )
    .stdout.split("\n")
    .filter(Boolean);
  const introduction = introductions[0];
  if (introduction === undefined) throw new Error(`WAVE_CHECKPOINT_NOT_COMMITTED:${checkpointPath}`);
  const introduced = git(scriptRoot, ["show", `${introduction}:${checkpointPath}`]).stdout;
  const atHead = git(scriptRoot, ["show", `HEAD:${checkpointPath}`], true);
  if (atHead.status !== 0 || atHead.stdout !== introduced || readFileSync(path, "utf8").trim() !== introduced) {
    throw new Error(`WAVE_CHECKPOINT_MUTATED:${checkpointPath}:${introduction}`);
  }
  const checkpoint = JSON.parse(introduced);
  const target = git(context.main, ["rev-parse", "--verify", `refs/tags/${checkpoint.tag}^{commit}`], true);
  if (
    (wave === "A" && checkpoint.tag !== ownership.integration.baseRef) ||
    target.status !== 0 ||
    target.stdout !== checkpoint.tagTarget ||
    checkpoint.tagTarget !== checkpoint.implementationCommit
  ) {
    throw new Error(`WAVE_CHECKPOINT_MISMATCH:${path}`);
  }
  if (
    git(context.main, ["merge-base", "--is-ancestor", ownership.reviewedFoundationCommit, target.stdout], true)
      .status !== 0 ||
    git(context.main, ["merge-base", "--is-ancestor", target.stdout, ownership.integration.branch], true).status !== 0
  ) {
    throw new Error(`WAVE_CHECKPOINT_HISTORY_MISMATCH:${path}`);
  }
  if (wave === "A") {
    const unowned = changedPaths(context.main, ownership.reviewedFoundationCommit, target.stdout).filter(
      (entry) => !ownership.integration.ownedPaths.some((pattern) => matches(entry, pattern)),
    );
    if (unowned.length > 0) throw new Error(`WAVE_CHECKPOINT_UNOWNED_PATHS:${unowned.join(",")}`);
  } else {
    const previousWave = { B: "A", C: "B", D: "C" }[wave];
    const previous = requireWaveCheckpoint(scriptRoot, context, ownership, previousWave);
    const inputBase = exactCommit(context.main, checkpoint.inputBaseCommit, "WAVE_INPUT_BASE");
    if (inputBase !== previous.tagTarget) {
      throw new Error(`WAVE_INPUT_BASE_MISMATCH:${checkpointPath}:${checkpoint.inputBaseCommit}:${previous.tagTarget}`);
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
    for (const contribution of contributions) {
      const lane = ownership.lanes[contribution.laneId];
      const laneBase = exactCommit(context.main, contribution.baseCommit, "WAVE_LANE_BASE");
      const laneCommit = exactCommit(context.main, contribution.commit, "WAVE_LANE_COMMIT");
      if (
        lane === undefined ||
        lane.wave !== previousWave ||
        laneBase !== inputBase ||
        laneCommit === laneBase ||
        git(context.main, ["merge-base", "--is-ancestor", laneBase, laneCommit], true).status !== 0 ||
        git(context.main, ["merge-base", "--is-ancestor", laneCommit, target.stdout], true).status !== 0
      ) {
        throw new Error(`WAVE_LANE_CONTRIBUTION_MISMATCH:${contribution.laneId}`);
      }
      const paths = changedPaths(context.main, laneBase, laneCommit);
      const laneUnowned = paths.filter((entry) => !lane.ownedPaths.some((pattern) => matches(entry, pattern)));
      if (laneUnowned.length > 0) {
        throw new Error(`WAVE_LANE_UNOWNED_PATHS:${contribution.laneId}:${laneUnowned.join(",")}`);
      }
      for (const entry of paths) {
        if (git(context.main, ["diff", "--quiet", laneCommit, target.stdout, "--", entry], true).status !== 0) {
          throw new Error(`WAVE_LANE_CONTRIBUTION_DRIFT:${contribution.laneId}:${entry}`);
        }
      }
      paths.forEach((entry) => contributionPaths.add(entry));
    }
    const unowned = changedPaths(context.main, checkpoint.inputBaseCommit, target.stdout).filter(
      (entry) =>
        !contributionPaths.has(entry) && !ownership.integration.ownedPaths.some((pattern) => matches(entry, pattern)),
    );
    if (unowned.length > 0) throw new Error(`WAVE_CHECKPOINT_UNOWNED_PATHS:${unowned.join(",")}`);
    verifyCheckpointScope(
      scriptRoot,
      context.main,
      target.stdout,
      ownership,
      checkpoint,
      contributions,
      `WAVE_${previousWave}`,
    );
  }
  return checkpoint;
}

function requireClean(path, laneId) {
  const dirty = git(path, ["status", "--porcelain=v1"]).stdout;
  if (dirty.length > 0) throw new Error(`DIRTY_WORKTREE:${laneId}:${path}`);
}

function planLane(context, ownership, entries, laneId, lane, expectedBase) {
  if (lane.branch !== `imessage/${laneId}` || lane.worktree !== `worktrees/${laneId}`) {
    throw new Error(`LANE_IDENTITY_INVALID:${laneId}:${lane.branch}:${lane.worktree}`);
  }
  const base = resolveBase(context.main, laneId, lane, expectedBase);
  const expectedPath = resolve(context.workspace, lane.worktree);
  const relativePath = relative(context.workspace, expectedPath);
  if (relativePath.startsWith("..") || resolve(dirname(expectedPath)) !== resolve(context.workspace, "worktrees")) {
    throw new Error(`WORKTREE_PATH_OUTSIDE_WORKSPACE:${laneId}:${expectedPath}`);
  }
  if (
    existsSync(dirname(expectedPath)) &&
    normalizePath(dirname(expectedPath)) !== resolve(context.workspace, "worktrees")
  ) {
    throw new Error(`WORKTREE_PARENT_OUTSIDE_WORKSPACE:${laneId}:${dirname(expectedPath)}`);
  }
  const entry = entries.find((candidate) => candidate.path === normalizePath(expectedPath));
  if (existsSync(expectedPath)) {
    if (
      lstatSync(expectedPath).isSymbolicLink() ||
      !realpathSync(expectedPath).startsWith(`${realpathSync(context.workspace)}/`)
    ) {
      throw new Error(`WORKTREE_PATH_SYMLINK_OR_OUTSIDE:${laneId}:${expectedPath}`);
    }
    if (entry === undefined) throw new Error(`UNREGISTERED_EXISTING_PATH:${expectedPath}`);
    if (entry.branch !== lane.branch) throw new Error(`BRANCH_MISMATCH:${laneId}:${entry.branch ?? "detached"}`);
    const origin = git(expectedPath, ["remote", "get-url", "origin"]).stdout.replace(/\.git$/u, "");
    if (origin !== ownership.repository.replace(/\.git$/u, "")) throw new Error(`ORIGIN_MISMATCH:${laneId}:${origin}`);
    requireClean(expectedPath, laneId);
    const head = git(expectedPath, ["rev-parse", "HEAD"]).stdout;
    if (head === base) {
      return { action: "valid", base, expectedPath, head, laneId };
    }
    if (lane.wave === "A" && head === ownership.reviewedFoundationCommit) {
      if (git(expectedPath, ["merge-base", "--is-ancestor", head, base], true).status !== 0) {
        throw new Error(`NON_FAST_FORWARD_BASE:${laneId}:${head}:${base}`);
      }
      return { action: "fast-forward", base, expectedPath, head, laneId };
    }
    throw new Error(`EXISTING_WORKTREE_BASE_MISMATCH:${laneId}:${head}:${base}`);
  }
  if (entry !== undefined) throw new Error(`WORKTREE_REGISTRATION_WITHOUT_PATH:${expectedPath}`);
  const branchEntry = entries.find((candidate) => candidate.branch === lane.branch);
  if (branchEntry !== undefined) throw new Error(`BRANCH_CHECKED_OUT_ELSEWHERE:${lane.branch}:${branchEntry.path}`);
  const branchCheck = git(context.main, ["show-ref", "--verify", "--quiet", `refs/heads/${lane.branch}`], true);
  if (branchCheck.status === 0) throw new Error(`EXISTING_UNREGISTERED_BRANCH:${lane.branch}`);
  return { action: "create", base, branch: lane.branch, expectedPath, laneId };
}

function applyPlan(context, plan) {
  if (plan.action === "valid") {
    process.stdout.write(`VALID_EXISTING:${plan.laneId}:${plan.head}\n`);
  } else if (plan.action === "fast-forward") {
    git(plan.expectedPath, ["merge", "--ff-only", plan.base]);
    process.stdout.write(`FAST_FORWARDED:${plan.laneId}:${plan.head}:${plan.base}\n`);
  } else {
    git(context.main, ["worktree", "add", "-b", plan.branch, plan.expectedPath, plan.base]);
    process.stdout.write(`CREATED:${plan.laneId}:${plan.base}\n`);
  }
}

export function main(
  scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  argv = process.argv.slice(2),
) {
  const ownership = JSON.parse(readFileSync(resolve(scriptRoot, "docs/imessage/ownership.json"), "utf8"));
  const [command, waveFlag, wave] = argv;
  if (command !== "prepare" || waveFlag !== "--wave" || !["A", "B", "C", "D"].includes(wave)) {
    throw new Error("USAGE:imessage-worktrees.mjs prepare --wave <A|B|C|D>");
  }
  const context = repositoryContext(scriptRoot, ownership);
  const lanes = Object.entries(ownership.lanes).filter(([, lane]) => lane.wave === wave);
  if (lanes.length === 0) throw new Error(`WAVE_EMPTY:${wave}`);
  const entries = registeredWorktrees(context.main);
  requireIntegrationCheckout(scriptRoot, context, ownership, entries);
  const checkpoint = requireWaveCheckpoint(scriptRoot, context, ownership, wave);
  for (const [laneId, lane] of lanes) {
    if (
      lane.baseRef !== checkpoint.tag ||
      (lane.baseCommit !== undefined && lane.baseCommit !== checkpoint.tagTarget)
    ) {
      throw new Error(`WAVE_BASE_CHECKPOINT_MISMATCH:${laneId}:${lane.baseCommit}:${checkpoint.tagTarget}`);
    }
  }
  const plans = lanes.map(([laneId, lane]) =>
    planLane(context, ownership, entries, laneId, lane, checkpoint.tagTarget),
  );
  for (const plan of plans) applyPlan(context, plan);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
