#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ownership = JSON.parse(readFileSync(resolve(scriptRoot, "docs/imessage/ownership.json"), "utf8"));
const expectedOrigin = ownership.repository.replace(/\.git$/u, "");

function git(cwd, args, allowFailure = false) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function repositoryContext() {
  const common = git(scriptRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout;
  const main = common.endsWith("/.git") ? dirname(common) : scriptRoot;
  const workspace = dirname(main);
  const origin = git(main, ["remote", "get-url", "origin"]).stdout.replace(/\.git$/u, "");
  if (origin !== expectedOrigin) throw new Error(`ORIGIN_MISMATCH:${origin}`);
  return { main: realpathSync(main), workspace: realpathSync(workspace) };
}

function registeredWorktrees(main) {
  const output = git(main, ["worktree", "list", "--porcelain"]).stdout;
  const entries = [];
  let current;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: realpathSync(line.slice(9)) };
      entries.push(current);
    } else if (line.startsWith("HEAD ") && current !== undefined) current.head = line.slice(5);
    else if (line.startsWith("branch ") && current !== undefined)
      current.branch = line.slice(7).replace(/^refs\/heads\//u, "");
  }
  return entries;
}

function prepareLane(context, laneId, lane) {
  const base = git(context.main, ["rev-parse", "--verify", `${lane.baseRef}^{commit}`]).stdout;
  const expectedPath = resolve(context.workspace, lane.worktree);
  const entries = registeredWorktrees(context.main);
  const entry = entries.find((candidate) => candidate.path === expectedPath);
  if (existsSync(expectedPath)) {
    if (entry === undefined) throw new Error(`UNREGISTERED_EXISTING_PATH:${expectedPath}`);
    if (entry.branch !== lane.branch) throw new Error(`BRANCH_MISMATCH:${laneId}:${entry.branch ?? "detached"}`);
    const ancestor = git(expectedPath, ["merge-base", "--is-ancestor", base, "HEAD"], true);
    if (ancestor.status !== 0) throw new Error(`IMMUTABLE_BASE_NOT_ANCESTOR:${laneId}:${base}`);
    process.stdout.write(`VALID_EXISTING:${laneId}:${entry.head}\n`);
    return;
  }
  if (entry !== undefined) throw new Error(`WORKTREE_REGISTRATION_WITHOUT_PATH:${expectedPath}`);
  const branchCheck = git(context.main, ["show-ref", "--verify", "--quiet", `refs/heads/${lane.branch}`], true);
  if (branchCheck.status === 0) throw new Error(`EXISTING_UNREGISTERED_BRANCH:${lane.branch}`);
  git(context.main, ["worktree", "add", "-b", lane.branch, expectedPath, base]);
  process.stdout.write(`CREATED:${laneId}:${base}\n`);
}

const [command, waveFlag, wave] = process.argv.slice(2);
if (command !== "prepare" || waveFlag !== "--wave" || !["A", "B", "C", "D"].includes(wave)) {
  throw new Error("USAGE:imessage-worktrees.mjs prepare --wave <A|B|C|D>");
}
const context = repositoryContext();
const lanes = Object.entries(ownership.lanes).filter(([, lane]) => lane.wave === wave);
if (lanes.length === 0) throw new Error(`WAVE_EMPTY:${wave}`);
for (const [laneId, lane] of lanes) prepareLane(context, laneId, lane);
