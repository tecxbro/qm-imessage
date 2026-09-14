# Checkpoint 1 repair integration record

## Inspected input

- Repository: `https://github.com/tecxbro/qm-imessage.git`
- Registered main checkout: `/Users/darshan/Documents/ChatGPT/qmimessage`
- Coordinator worktree: `/Users/darshan/Documents/ChatGPT/qmimessage/worktrees/cp1-coordinator`
- Coordinator branch: `cp1/coordinator`
- Local `main` at inspection: `5e13a3271758b003879fbe881a24d4130ecadace`
- Fetched `origin/integration-1`: `4b1ce5a8326979cb8cf59eb966df4906a901dd38`
- Reviewed merge supplied in the assignment: `4b1ce5a8326979cb8cf59eb966df4906a901dd38`
- Remote divergence from the supplied merge: none
- Main and coordinator worktrees were clean before preparation

The similarly named `/Users/darshan/Documents/ChatGPT/qm-imessage` repository is a separate Git registration. Its occupied worktrees and local branches were inspected read-only and were not reset, removed, or reused.

## Frozen repair base

The extraction and shared contract were committed as `fe92c5b1a4aeddf4b8fdf893c37f7ccbeec81cb3`. This is the exact base for `cp1/r01` through `cp1/r14`. The commit does not contain its own future SHA; this record is a separate follow-up.

The preparation keeps one `createPostgresPhotonStateStores()` aggregate, moves only the binding, receipt, and delivery implementations, freezes additive transitional ports, and adds the single `photon/state/0002` migration without modifying `0001`.

## Preparation review

An independent fresh-context review found and the coordinator resolved:

- missing dispatch-claim recovery state;
- missing and then overly broad core-link action-binding privileges;
- contract and transitional-interface naming drift;
- a machine-hardcoded dispatch path;
- an out-of-scope R15 configuration path;
- absence of a real `0001` to `0002` upgrade test.

The final review reported no remaining actionable findings.

## Preparation verification

Verification used Node 24.18.0, npm 11.10.0, and PostgreSQL 16 in an isolated container. The PostgreSQL harness created and removed a uniquely named database.

- Root typecheck: passed.
- Photon package typecheck: passed after lockfile-pinned dependency installation.
- ESLint: passed.
- Oxlint: passed.
- Prettier and `git diff --check`: passed.
- Ownership and local state tests: 12 passed, 0 failed.
- PostgreSQL Photon state tests: 6 passed, 0 failed, 0 skipped.
- The migration test applies `0001`, writes legacy session and delivery rows, applies `0002`, verifies preserved rows/defaults, replays both migrations, and verifies adapter/core-link role boundaries.

## Evidence boundary

This record proves local extraction, type, lint, ownership, migration, and PostgreSQL behavior only. It does not prove integration of R01-R14, provider acceptance, delivery, read state, native presentation, physical-device behavior, deployment, or release publication.

## Repair ledger

R01-R14 heads, review results, merge SHAs, focused tests, cross-boundary tests, composition decisions, and blockers are appended here during integration. Original WT01-WT06 contribution records remain unchanged.
