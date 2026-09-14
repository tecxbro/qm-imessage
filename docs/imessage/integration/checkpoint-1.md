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

## Integrated repair contributions

Every parallel repair started at `fe92c5b1a4aeddf4b8fdf893c37f7ccbeec81cb3`. Follow-up commits on R10, R11, and R13 stayed on their original registered branches and within their frozen ownership.

| Repair | Captured head                              | Coordinator merge containing final head    | Focused evidence                                                             |
| ------ | ------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------- |
| R01    | `ada9223c8ca16644fb4f2f744a3cf7c4d861053e` | `4df1524ab954e8df435bcd15088b52294ab6506d` | Encrypted installation adapter, restart and tamper cases                     |
| R02    | `738cf3aafc689654f05bace39fb257e9a54c4cc1` | `46d0bb3fa77e46c68affab64b4bf606400bab474` | 14 PostgreSQL selection/CAS cases                                            |
| R03    | `c1732738688736a2c88cd31b5187b1052de7cf2d` | `951dad235a61cdd49c5e936cedc352d8bebbb647` | Bounded receipt discovery and provider recovery                              |
| R04    | `29680b346d1aa6de7e794c756ffaf1432c8d6c5f` | `6b0106916d8e78f5a76caa71d930e4fe998b9889` | Fenced delivery recovery with final required port surface                    |
| R05    | `fcd24ef6ee4031da0c0239961a38f9a7a0719ecd` | `ff432fb7d026179798f04331bac20b06b8a149f3` | Historical message/action session authority                                  |
| R06    | `5a6cecdbfe54f651d757da3e9b5901c518833255` | `7df32371b08072fc316d5907fe7af5ab5be87a19` | Structured Photon destination projection                                     |
| R07    | `7fd1075396091e3e1a7113df83f6a5e3e74ee7b4` | `10dae5840662fa457f5efd577ab868fbefc227e9` | Reach preflight and no-work denial                                           |
| R08    | `7ff0886926fb74c3f5bfab08caf37c91fbdb6383` | `09d18f3cb427230ed9bb0a2c595e5757c9826bf6` | Durable DM backlinks and migration `delivery/store/0007-photon-dm-backlinks` |
| R09    | `4ef3b4763f71afeaddd86c81a55a2311bbde7481` | `28f21f3c925d79337990faf2314bbd278c60d62a` | Source-auth route registration and explicit unavailable state                |
| R10    | `9599bf4b047b171a2891f3c8d7a7784fde635472` | `24a545558514adf9aec9dc058fdfff2015d0e1e6` | Scoped credentials plus R14-compatible replacement test                      |
| R11    | `1a97cb6627a3e3dcea16e3fc02589f03fdf8a108` | `f79377c081d4df1c3abacd872834941207b83593` | Runtime-only multipart progress plus recoverable Spectrum receipt port       |
| R12    | `739d848151389c3fdf48217dacb0047569525e29` | `ed2ea311a65560c4fc2b1a6e268e69fada40fe5d` | Authenticated Photon host and fail-closed registry                           |
| R13    | `a3032093ed04372e25bff61f84211241caff4fc5` | `ecf393f6b412242df4c0b37380040659a3ad067b` | Repair provenance, coordinator identity, and exact integration attribution   |
| R14    | `fbb39aad79628665e09a42da56f4ea4238e5c1fc` | `ebff3833de4c5263828a4ad73c68b937c7aa5c31` | Durable cross-mode physical-line ownership                                   |

## Integration joins and resolutions

Coordinator commit `601bb0216db2a48445b2272b12ea2846e70cd677` adopts the required shared Photon store ports after the repair merges. Its same-path updates to the WT03 state aggregate and state tests are integration-owned contract and migration-test adaptations; the R02, R03, and R04 focused implementations remain owned by their captured repair heads.

R15 was rebuilt after the final R01-R14 heads so its dependency ancestry is explicit. Its base is `3cc6c85dd995e939f00a0125d68e218ce551b998`, contribution is `b3cc3367d670556c221da641cb9311151043c9dc`, and coordinator merge is `34756ef5f14f87478f22cab891d89f0005c87f1c`.

R16 starts from the final R15 contribution. Its base is `b3cc3367d670556c221da641cb9311151043c9dc`, contribution is `b5589bb83f0649b814203d6d70a025d8e60361f0`, and coordinator merge is `0706ff55f38e3f156342a8bf87e8380dda98be46`.

Two original-lane test corrections are separately recorded by exact base, commit, path, and repair ancestry in `checkpoint-1-input.json`:

- WT02 installation versions: base `00dbd868c279dacb41ff09f3ee6a186682942cbf`, commit `173d51700dc4ac2b2586e622e86d355eac1390d6`, dependency R01.
- WT04 provider ownership/progress: base `47243c99d18f82093832d428152f4c82867d2e27`, commit `3ff591cd4397ceb667f75a327a40db4ace7f1363`, dependencies R11 and R14.

## Composition decisions

- The PostgreSQL aggregate persists only installation ciphertext and exposes the required selected-session, recoverable receipt, recoverable delivery, and physical-line owner stores.
- The existing privileged core pool registers `photon/state/0001` and `photon/state/0002`; no privileged pool is passed into the adapter composition.
- R15 uses the existing QM App, runs, deliveries, authorization, and server dependency object. Slack and ordinary web behavior retain their existing instances.
- R16 resolves a scoped credential before one provider SDK, holds one durable line lease, uses an exact delivery claim and runtime-only progress callback, and creates the existing source-signed QM client per normalized source.
- Advanced inbound and every missing producer remain explicit unavailable states. No fake successful identity, inbound, delivery, native, or view handler was added.

## Integrated verification evidence

- Combined repair PostgreSQL union: 34 passed, 0 failed, 0 skipped across selected-session CAS, receipt recovery, delivery recovery/progress, ciphertext state, DM backlinks, migrations/grants, and line ownership. Each suite created its own disposable database and ran serially.
- Photon package suite after the recorded integration resolutions: 178 passed, 0 failed, 0 skipped.
- Core composition, source authentication, Photon routes, and ordinary route authorization: 27 passed, 0 failed.
- Final R13 focused repair-tooling suite: 12 top-level tests passed, 0 failed.
- Root and Photon typechecks passed before documentation capture.
- The production-shaped dev launcher could not claim a Slack app because every local pool slot was occupied. No live Slack or production-shaped browser result is claimed.

## Open activation blockers

- No production canonical Photon identity producer is configured.
- No production Photon destination resolver crosses the current orchestrator candidate-erasure boundary.
- No separately authenticated adapter/core-link runtime database DSNs or retained installation wrapping-key configuration are present.
- The static server route table cannot conditionally omit Photon routes; absent composition returns explicit `503` unavailable.
- Advanced inbound remains unavailable, and no provider acceptance, delivery/read, native presentation, deployment, release, or physical-device evidence exists.

`checkpoint-1-input.json` is the repair-aware working record. `checkpoint-1.json` is deliberately absent: no authorized `qm-imessage-f1` tag exists, and this assignment forbids creating one. Wave B has not been prepared.
