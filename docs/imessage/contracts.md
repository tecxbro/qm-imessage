# QM iMessage foundation contracts

## Authority boundary

Photon is an additive transport and presentation surface. Existing QM owns canonical human identity, policy, authorization, sessions, turns, approvals, revisions, files, memory, skills, schedules, background work, applications, settings, credentials, and administration. Photon mechanics may capture provider input, maintain transport-scoped references, deliver checked output, and mount links to existing authenticated QM views. They do not become business authority.

Source authentication proves that a request came from an allowed surface process and that its body was not altered or replayed. It does not identify the human who sent an iMessage. `QmChannelAuthorityPort.check` accepts a `QmChannelOperationRequest` and returns a `CheckedQmChannelOperation` only after existing QM evaluates the actor, exact resource and revision, session, conversation, and requested action. A caller-provided `QmAuthorizationProof` is never sufficient by itself.

Natural inbound turns use `turn.start` with `source: "photon"` and an internal `redeliveryKey`. WT01 must route that checked request through QM's existing internal redelivery behavior. The public `/v1/turns` semantics and automatic steering rules remain unchanged.

## Identity and event families

`InstallationReference` can exist before a Photon project is selected. `ProviderScope`, `LineReference`, `ConversationReference`, `MessageReference`, `MessagePartIdentity`, and `MessagePartReference` add only the scope required at each layer. Provider, installation, line, conversation, message, and part identifiers remain separate fields. They are not concatenated into an assumed globally unique identifier.

`ProviderEventIdentity` identifies the transport event independently of any message GUID. The `NormalizedPhotonInput` discriminator covers:

- `message`: a human actor, message and part identity, ordered text or attachment content, and an optional reply target;
- `edit`: an optionally part-scoped target message plus the provider's exact public replacement-content DTO, including attachments, formatting, mentions, visible text, effects, and mini-app metadata, without inventing a new human message;
- `unsend`: an optionally part-scoped target message without inventing a new human message;
- `reaction`: actor, optionally part-scoped target message, add/remove action, and reaction value;
- `read` and `delivery`: either a message-part target or a conversation target;
- `poll`: create and option-added events retain title and the documented option set, while vote and unvote events require an option identifier;
- `group`: rename retains the display name, while avatar-set and avatar-cleared are separate changes;
- `membership`: add, remove, and leave retain the affected member identifiers;
- `lifecycle`: provider/installation context and lifecycle action, including an explicit catch-up-complete head sequence where supplied, with no fabricated conversation or actor;
- `unknown`: the original event name, an explicit reason, and optional scoped context.

The runtime parser rejects contradictory provider or installation scope and contradictory line or conversation references. Every inbound attachment, reply, mutation target, and confirmed delivery part is checked. Outbound attachment references identify durable content without fabricating a provider message identity before delivery. Multipart parts retain their underlying provider message IDs rather than inheriting the container ID.

## Operation payloads

`QmChannelOperationInput` and `PhotonPresentationOperationInput` map each operation name to a specific payload. `QmChannelOperationRequest`, `CheckedQmChannelOperation`, and `PhotonPresentationOperation` are discriminated unions over those maps. Poll create, vote, unvote, and add-option operations are distinct. App send and update are distinct. Group membership add, remove, and leave are distinct. No generic SDK method executor or duplicate business CRUD surface exists.

The runtime parsers accept only JSON-safe values. Functions, `BigInt`, non-finite numbers, cycles, class instances, unknown fields, and malformed required fields are rejected before serialization. Turn starts, reach destinations and content, multipart entries, app cards and update handles, editable content, reactions, and provider receipts use exact discriminated shapes. Effects use only the pinned provider effect identifiers. Poll creation requires at least two nonblank options; unvote is poll-scoped without a fabricated option identifier, and add-option carries the SDK's `text` field. `attemptId` identifies a provider dispatch attempt. `idempotencyKey` identifies the logical operation and remains stable across retries; changing `attemptId` or `operationId` does not permit a payload conflict to bypass deduplication.

Outbound `message.react` requires `action: "add" | "remove"` alongside the target and reaction. Advanced maps this distinction to the pinned `setReaction` boolean. A provider without a supported removal path must return `unsupported` before dispatch.

`AdvancedIMessageProviderClientPort.getPoll(conversation, pollMessageGuid)` is a read boundary returning `PhotonPollState`: chat and poll identities, title, options and their creators, and current votes with participant addresses and services. It maps to the pinned Advanced `polls.get()` declaration; the adapter must verify the returned chat and poll identities against the scoped request and propagate read errors. This is separate from delivery outcomes and does not reserve an outbound operation. Native reads remain WT13 implementation work.

`SpectrumProviderClientPort` exposes the common provider boundary. Its streamed-text method receives one presentation operation and one `AsyncIterable<string>` so the provider performs one send rather than treating each chunk as a message. `TextStreamSessionStorePort` durably stores ordered chunks, state, and version before that send. The presentation operation carries only stream format, reply, and effect metadata. `AdvancedIMessageProviderClientPort` has no streaming method because the pinned Advanced declarations do not provide one; its adapter must return `unsupported` before dispatch. Existing authenticated QM view mounts remain a separate web-host contribution contract and are not provider delivery operations. The remaining presentation union covers plain text, Markdown, HTTPS links with native preview intent, replies, effects, multipart content, attachments, voice, contacts, polls, app cards, reactions, edits, unsends, and conversation operations.

## Installation state and dashboard projection

`PrivateInstallationStatus` may retain management and runtime credential material for durable encrypted storage. `projectInstallationForDashboard` constructs a new `InstallationDisplayStatus` from an allowlist. It never casts and returns the private input. `parseInstallationDisplayStatus` rejects unknown top-level and line fields.

`not-started`, `awaiting-authorization`, and `provisioning` need no fake project or line. Only `connected` requires a project and line list. Management-login state is distinct from runtime project-credential health through `needs-credential-repair`; an owner revision mismatch is distinct through `needs-owner-rebind`. Device authorization URLs must be HTTPS and are bound to the trusted management origin carried only by the private status.

Actual CLI login and installation orchestration remain WT02 work. The foundation models its states but does not claim a CLI JSON mode, perform device login, create a project, regenerate a secret, or assign a number.

## Recoverable transport state

The restricted storage ports in `plugins/photon/src/ports.ts` cover installation revisions, verified-address challenges, chat/session and message bindings, attachment references, received envelopes, contiguous checkpoints, outbound operations, durable text-stream sessions, poll references, public serializable card handles, and action bindings.

`CapturedEventPayload` retains either the normalized envelope or a durable retrievable payload reference plus hash. A hash alone is not recoverable. `capture` accepts only a fresh `captured` record and cannot import a caller-supplied claim, checkpoint, rejection, or other terminal state. An inbox record is retained only until durable QM handoff or recorded rejection and is not an authoritative transcript or agent execution queue.

`ReceiptClaim` carries a claimant ID, monotonically increasing fence, and lease expiry. A receipt retains a canonical non-negative safe-integer provider sequence when the source event supplies one; events without sequence remain capturable but cannot advance a contiguous checkpoint. `completeWithoutSequence` and `rejectWithoutSequence` terminate only unsequenced records. A sequenced success uses `advanceContiguousCheckpoint`; a sequenced rejection uses `rejectAndAdvanceContiguousCheckpoint`, which atomically records the rejection and advances the line cursor so a rejected event cannot wedge all later events. Each transition requires the exact event key and active claim. Cursor advancement additionally requires the receipt's exact sequence and line scope. Every later checkpoint must be exactly one greater than the current sequence. The first checkpoint uses the lowest captured sequence in the same provider, installation, and line scope as its initial processing boundary; neither successful completion nor rejection may skip an already captured predecessor. Capture the recovery range before processing it so that this initial boundary includes all known earlier work. A stale claimant cannot finalize a newer claim, and processing sequence 103 cannot skip an unprocessed sequence 102 after checkpoint 101. PostgreSQL implementation and database grants belong to WT03. TypeScript interface narrowing documents the application contract but is not the database security boundary. Adapter delivery grants must remain separate from core-linking grants.

Fixture stores compare JSON payloads by a recursive canonical key ordering, so semantically identical objects do not conflict merely because their property insertion order differs. Arrays retain their declared order.

## Delivery outcomes and reconciliation

Every `PhotonOperationOutcome` includes the full `PhotonOperationReference`: operation ID, logical idempotency key, name, and conversation scope.

- `confirmed-message` includes the message and requires every returned provider part and logical part index to appear exactly once. Advanced poll creation also retains its poll GUID and option identifiers; Spectrum and Advanced app-card send and update retain the exact `chatGuid`, `messageGuid`, `sessionId`, and `targetMessageGuid` update session.
- `confirmed-no-message` is accepted only for a provider-operation pair whose pinned declaration documents no returned message identity. Void operations reject a provider receipt except Spectrum app-card update, whose session receipt is required for restart-safe continuity. Advanced poll mutations require an exact discriminated `Poll` receipt; group rename and participant mutations require an exact discriminated `Chat` receipt.
- `unsupported` is never converted to success.
- `failed` records retryability and any already confirmed parts.
- `ambiguous` records a reconciliation key and any confirmed parts.

An absent result for a message-producing operation cannot become `confirmed-no-message`. An ambiguous operation can change state only through `PhotonReconciliationEvidence` from an explicit observation whose operation identity and scope match the reserved operation. A confirmed-message reconciliation must cover every planned logical part exactly once, and a confirmed-no-message reconciliation is valid only for an operation with no planned parts. A retryable failure may reserve a new operation and attempt identity under the same logical idempotency key and payload; its dispatch names only unresolved logical part indexes so confirmed multipart children are never resent. Ambiguity remains reconcile-first. Delivery records retain scoped structured part identities, per-part dispatch fences, and provider-part references. Already confirmed parts remain attached during partial failure, ambiguity, and reconciliation. Sparse or reordered partial evidence is joined by `logicalPartIndex`, never by array position, but it cannot promote the parent to confirmed. Unsupported completion terminates every child as unsupported rather than leaving dispatched work behind.

Completion and reconciliation both require all previously confirmed logical parts to retain their exact provider-part references in the supplied evidence. Contradictory or missing confirmed-part evidence rejects the transition before any record, part, outcome, or version changes.

## Actions

`ActionBinding` records actor, resource type and ID, resource revision, allowed action, expiry, session, and full provider/installation/line conversation scope. `ActionBindingConsumption` must match all of them and carries a canonical current timestamp. Storage lookup and single-use state are keyed by the scoped conversation plus binding ID so colliding provider IDs remain isolated. A Photon resource-owner map is not an approval decision, and local binding consumption does not prove that the QM action executed. Slack, web, and iMessage decisions converge through existing QM authority.

## Producers and consumers

| Contract family                           | Producer           | Consumer                                                               |
| ----------------------------------------- | ------------------ | ---------------------------------------------------------------------- |
| Checked channel request                   | WT01               | existing QM turn, approval, run, session, loop, cron, and reach owners |
| Setup and installation state              | WT02               | WT16 dashboard onboarding; WT03 durable mechanics                      |
| Durable transport records                 | WT03               | WT08 intake, WT09 delivery, WT14 cards, WT18 actions                   |
| Provider events and capability results    | WT04               | WT08 normalization and WT09 delivery                                   |
| Routing and message bindings              | WT07               | WT08, WT10-WT15, WT17-WT21                                             |
| Native presentation operations            | WT10-WT15          | WT04 provider clients and WT09 delivery                                |
| Existing authenticated view contributions | WT06 and WT17-WT21 | integration-owned web registry and shell                               |

The abbreviated `P/test/` paths in the original plan are stored as explicit `plugins/photon/test/` paths in `ownership.json`.

## Pinned declaration evidence and uncertainty

The inspected installed public declarations are `spectrum-ts` 12.8.0, `@photon-ai/advanced-imessage` 2.1.0, and `@photon-ai/cli` 2.2.0. Spectrum single-content sends, replies, and reactions can return a message or `undefined`; multipart sends return message arrays. Spectrum `edit`, `unsend`, `read`, and in-place app-card updates return `void`. Advanced iMessage text, attachment, multipart, edit, and reaction methods return concrete messages. Its only contact method shares the Mac-owned card and returns `void`, so the arbitrary-vCard `message.contact` operation is unsupported on Advanced; Spectrum owns arbitrary-vCard delivery. Advanced poll creation and poll mutations return `Poll`; custom app-card send and update return `MiniAppMessageResult`, which combines a message with the exact restart-safe update session; group rename and participant add/remove return `Chat`; unsend, typing, read, group-avatar changes, and group leave return `void`. The contract evaluates no-message confirmation against this provider-operation table. Every non-message `Poll` or `Chat` success and every app-card result must retain its provider receipt; unexpected absence from a message-producing call is ambiguous or failed.

Universal Spectrum method presence does not prove iMessage support or recipient-visible behavior. Provider acceptance, delivery, read state, device rendering, group availability on the selected line, poll identifiers, and public serializable app-update handles remain unverified until their owning lanes produce evidence.

## Contract changes after the repair

After the repaired foundation is frozen, these shared contracts and canonical iMessage documents are integration-owned. A feature lane records a needed correction in its lane document with pinned declaration or provider evidence. The integration owner updates the shared seam, runs the foundation regression tests, captures exact lane commits and bases, and obtains fresh-context review before a later checkpoint tag.

Checkpoint 1 adopts separate service and persisted installation records. `InstallationRecord` contains private service state; `PhotonInstallationCiphertextRecord` is the only PostgreSQL representation. Current-session selection uses `ChatSessionSelectionStorePort` with a monotonically increasing transport version, while immutable message bindings continue to resolve original-session authority. Receipt and delivery recovery use bounded, scope-preserving cursor pages. Delivery dispatch requires an exact owner, fence, expiry, attempt, and injected time; expired or unknown writes become ambiguous.

Provider delivery receives multipart progress through a non-enumerable in-process callback that is never serialized. Physical-line ownership is keyed by installation and line rather than provider mode. The source-signed core link still proves only the adapter process; the real QM authorization layer resolves the canonical human, current or original session, revisions, membership, and actions against the existing App, run store, and delivery store.

The base receipt and delivery declarations remain available only for older fixtures that do not execute recovery. The production PostgreSQL aggregate and assembled provider paths require the recoverable ports. Obsolete plaintext installation persistence and unfenced delivery completion are not part of the adopted runtime.
