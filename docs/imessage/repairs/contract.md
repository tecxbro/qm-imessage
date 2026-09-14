# Integration checkpoint 1 repair contracts

These contracts are frozen for the repair branches created from the checkpoint preparation commit. The owning repair may refine its private implementation, but any change to a signature or cross-task invariant returns to the coordinator before integration. Canonical interfaces are promoted only with a real producer, every fixture implementation, and their acceptance tests.

## Installation storage

R01 owns the adapter between the setup service and durable encrypted storage.

```ts
interface PhotonInstallationCiphertextRecord {
  installationId: string;
  ownerRevision: string;
  version: number;
  wrappingKeyId: string;
  ciphertext: string;
}

interface PhotonInstallationCiphertextStore {
  read(installationId: string): Promise<PhotonInstallationCiphertextRecord | undefined>;
  create(record: PhotonInstallationCiphertextRecord): Promise<boolean>;
  compareAndSet(
    installationId: string,
    expectedVersion: number,
    next: PhotonInstallationCiphertextRecord,
  ): Promise<boolean>;
}

interface PhotonInstallationStoreAdapter {
  read(installationId: string): Promise<InstallationRecord | undefined>;
  create(record: InstallationRecord): Promise<boolean>;
  compareAndSet(installationId: string, expectedVersion: number, next: InstallationRecord): Promise<boolean>;
}
```

The service view is `InstallationRecord` with `PrivateInstallationStatus`; the database view is ciphertext only. Creation starts at version 1. Authenticated encryption binds the installation ID, owner revision, entity version, record kind, and wrapping-key ID. Swapping ciphertext between installations, versions, or keys is rejected. Dashboard/status projection continues through the existing redacted constructors.

Acceptance owner: R01. Prove first creation, compare-and-set, restart, tamper and swap rejection, key provenance, and public redaction with PostgreSQL.

## Selected session and historical bindings

R02 owns selection state. Message bindings remain immutable historical facts.

```ts
interface ChatSessionSelection {
  binding: ChatSessionBinding;
  version: number;
}

interface ChatSessionSelectionStorePort extends ChatSessionBindingStorePort {
  readSelection(conversation: ConversationReference): Promise<ChatSessionSelection | undefined>;
  compareAndSetSelection(
    conversation: ConversationReference,
    expectedVersion: number,
    next: ChatSessionBinding,
  ): Promise<ChatSessionSelection | undefined>;
}
```

The transport selection version is independent of the selected session's QM resource revision. Selection A to B to A produces monotonically increasing selection versions and never makes an earlier compare-and-set valid again. `MessageBindingStorePort` continues to resolve a provider message to the session recorded when that message was bound.

Acceptance owner: R02. Prove switching, one winner under concurrency, ABA resistance, restart persistence, and unchanged historical message lookup.

## Receipt recovery

R03 owns bounded discovery. A recovery cursor is pagination state, not provider checkpoint authority.

```ts
interface ReceiptRecoveryCursor {
  capturedAt: string;
  eventId: string;
}

interface ReceiptRecoveryQuery {
  provider: PhotonProviderName;
  installationId: string;
  lineId?: string;
  now: string;
  limit: number;
  after?: ReceiptRecoveryCursor;
}

interface ReceiptRecoveryPage {
  receipts: readonly EventReceipt[];
  next?: ReceiptRecoveryCursor;
}

interface RecoverableEventReceiptStorePort extends EventReceiptStorePort {
  discoverRecoverable(query: ReceiptRecoveryQuery): Promise<ReceiptRecoveryPage>;
}
```

Results contain `captured` records and `processing` records whose claim expired at or before `now`, ordered by canonical `capturedAt` and `eventId`. `lineId: undefined` means only line-less lifecycle receipts; it never means all lines. A sweep pages to exhaustion and starts a new sweep without a cursor so concurrent inserts behind the prior cursor are found. Processing order and contiguous checkpoint advancement continue to use the existing sequence and claim rules.

Acceptance owner: R03. Prove multiple pages, out-of-order capture, expired claims, a concurrent insert behind the cursor, restart with no in-memory keys, line-less isolation, and no fabricated checkpoint advancement.

## Delivery recovery and progress

R04 owns the durable state machine. R11 owns provider-client use of its runtime progress port.

```ts
interface DeliveryDispatchClaim {
  ownerId: string;
  fence: number;
  leaseExpiresAt: string;
}

interface DeliveryRecoveryCursor {
  updatedAt: string;
  conversationId: string;
  idempotencyKey: string;
}

interface DeliveryRecoveryQuery {
  provider: PhotonProviderName;
  installationId: string;
  lineId: string;
  now: string;
  limit: number;
  after?: DeliveryRecoveryCursor;
}

interface DeliveryRecoveryPage {
  deliveries: readonly RecoverableDeliveryOperationRecord[];
  next?: DeliveryRecoveryCursor;
}

interface RecoverableDeliveryOperationRecord extends DeliveryOperationRecord {
  dispatchClaim?: DeliveryDispatchClaim;
}

interface RecoverableDeliveryOperationStorePort extends Omit<
  DeliveryOperationStorePort,
  "complete" | "markDispatched" | "read"
> {
  acquireDispatch(
    operation: PhotonPresentationOperation,
    expectedVersion: number,
    ownerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<RecoverableDeliveryOperationRecord | undefined>;
  renewDispatch(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    now: string,
    leaseExpiresAt: string,
  ): Promise<RecoverableDeliveryOperationRecord | undefined>;
  expireDispatch(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    now: string,
  ): Promise<RecoverableDeliveryOperationRecord | undefined>;
  recordConfirmedPart(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    logicalPartIndex: number,
    part: MessagePartReference,
    now: string,
  ): Promise<RecoverableDeliveryOperationRecord | undefined>;
  complete(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    outcome: PhotonOperationOutcome,
    now: string,
  ): Promise<boolean>;
  discoverRecoverable(query: DeliveryRecoveryQuery): Promise<DeliveryRecoveryPage>;
  read(operation: PhotonPresentationOperation): Promise<RecoverableDeliveryOperationRecord | undefined>;
}

interface PhotonDeliveryProgressPort {
  assertCanContinue(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    logicalPartIndex: number,
    now: string,
  ): Promise<void>;
  recordConfirmedPart(
    operation: PhotonPresentationOperation,
    claim: DeliveryDispatchClaim,
    logicalPartIndex: number,
    part: MessagePartReference,
    now: string,
  ): Promise<void>;
}
```

Every lease decision and provider-result transition uses a canonical injected `now` and the exact live `DeliveryDispatchClaim`; SQL wall-clock reads do not decide lease validity. `reserve` and `retry` have no lease-time decision. Database `updated_at` may continue to use `clock_timestamp()` only as observational recovery ordering, never as provider-sequence or lease authority. An expired or unknown dispatch becomes ambiguous, never retryable. Legacy dispatched rows without a live lease are treated as unknown and become ambiguous. A confirmed child is recorded under the current attempt and fence in the parent JSON and relational child row in one transaction, and every recovery read verifies those representations agree.

Spectrum sequential multipart requires `PhotonDeliveryProgressPort` when more than one logical part remains. This callback is an in-process dependency and is never serialized into an operation, receipt, or durable record. The client checks permission before a send, validates the provider receipt, awaits `recordConfirmedPart`, then checks permission for the next part. If persistence or permission fails, later parts are not sent. Single-part sends and provider-atomic multipart calls do not fabricate part callbacks. The acceptance-to-checkpoint crash window remains ambiguous.

Acceptance owners: R04 for storage and R11 for the provider handshake. R16 verifies their assembled behavior.

## Original-session authorization

R05 owns authorization against the durable binding attached to the source message or action.

```ts
interface PhotonOriginalSessionResolver {
  resolve(
    source: PhotonOperationSource,
    operation: QmChannelOperationRequest,
  ): Promise<PhotonConversationAuthorizationBinding>;
}
```

The resolver uses the message/action binding carried by the validated source. Current conversation selection is used only when no historical reference exists. A client-supplied session ID grants nothing. Authorization is revalidated at execution against current membership, resource revision, run ownership, approval binding, and revocation state; a successful check is not an execution capability.

Acceptance owner: R05. Prove A remains A after selection changes to B, revocation fails closed, foreign and unbound references fail, and check to switch or revoke to execute cannot use stale authority.

## Destination and ingest projection

R06 owns projection through the existing Photon validators and constructors. R07 owns reach preflight behavior.

```ts
interface AppDeps {
  photonDestinations?: PhotonDestinationResolver;
}

type PhotonCapabilityDestination = Pick<
  PhotonDestination,
  | "type"
  | "target"
  | "audienceScopeId"
  | "conversation"
  | "conversationKind"
  | "principalIds"
  | "recipientPrincipalId"
  | "groupId"
  | "onBehalfOf"
  | "providerMessage"
>;
```

Unknown candidate metadata is discarded. Malformed Photon candidates return `{ ok: false }`; they do not fall through to Slack. Attachment preflight and final reach receive the same authorized current destination. A denied or contradictory Photon destination performs no sandbox or blob work. Existing Slack target and timestamp rules remain unchanged.

Acceptance owners: R06 and R07 with separate tests.

## Delivery backlinks

R08 adds the same interface to both delivery-store implementations.

```ts
interface PhotonDmBacklink {
  recipientPrincipalId: string;
  conversation: ConversationReference;
}

interface DeliveryStore {
  recordPhotonDmBacklink(
    deliveryId: string,
    backlink: PhotonDmBacklink,
  ): Promise<"recorded" | "duplicate" | "conflict">;
  photonDmBacklink(deliveryId: string): Promise<PhotonDmBacklink | undefined>;
}
```

Only a validated Photon DM with exactly its canonical personal recipient is accepted. Photon groups never become personal backlinks. R08 requests a coordinator-owned migration ID if the PostgreSQL implementation needs one.

## Route and core composition

R09 owns registration and classifications. R15 owns construction of the concrete dependencies.

```ts
interface ServerDeps {
  photonCore?: PhotonCoreClient;
}

function createPhotonRoutes(deps: PhotonRouteDeps): ReadonlyArray<Route<ApiCtx>>;
```

The canonical route table includes Photon routes only when the typed dependency is available. Missing composition is explicit unavailable behavior, never an unsigned fallback. Every Photon route retains `auth: "source"`; source authentication identifies the Photon process and does not replace human authorization. Photon writes are classified system-to-system without weakening portal or unrelated route classification.

The core-link database identity receives only the tables and columns needed for conversation selection, message/action authorization, and delivery backlinks. It cannot read decrypted installation credentials. R15 registers reviewed migrations with the privileged migration pool, then constructs runtime stores with restricted pools.

Acceptance owners: R09 and R15.

## Runtime credentials

R10 owns a resolver that keeps management, project, and line credentials distinct.

```ts
type PhotonProviderMode = "spectrum" | "advanced";

type PhotonLineCredentialResolution =
  | {
      kind: "available";
      installationId: string;
      lineId: string;
      mode: PhotonProviderMode;
      bearerToken: string;
      expiresAt?: string;
      provenance: "persisted-line-assignment" | "explicit-runtime-input";
      renewal: "automatic" | "external";
    }
  | { kind: "unavailable"; code: string }
  | { kind: "expired"; code: string };

interface PhotonLineCredentialResolver {
  resolve(input: {
    installationId: string;
    lineId: string;
    mode: PhotonProviderMode;
    now: string;
  }): Promise<PhotonLineCredentialResolution>;
}
```

A management login token and project secret are never accepted as a line bearer token. Automatic project discovery remains distinct from explicit clients whose tokens require external renewal. Unsupported acquisition paths return unavailable; logs and public status never include secrets.

Acceptance owner: R10.

## Distributed line ownership

R14 owns one durable owner for one installed physical line across provider modes.

```ts
interface PhotonLineOwnerKey {
  installationId: string;
  lineId: string;
}

interface PhotonLineOwnerClaim {
  key: PhotonLineOwnerKey;
  ownerId: string;
  fence: number;
  leaseExpiresAt: string;
}

interface PhotonLineOwnerStore {
  claim(
    key: PhotonLineOwnerKey,
    ownerId: string,
    now: string,
    leaseExpiresAt: string,
  ): Promise<PhotonLineOwnerClaim | undefined>;
  renew(claim: PhotonLineOwnerClaim, now: string, leaseExpiresAt: string): Promise<PhotonLineOwnerClaim | undefined>;
  release(claim: PhotonLineOwnerClaim, now: string): Promise<boolean>;
}
```

The key deliberately excludes Spectrum versus Advanced mode so they compete for the same physical line. This fence is independent from an outbound delivery fence. Lease loss prevents later local dispatch but cannot cancel an external provider request already sent; late results remain durable evidence for reconciliation.

Acceptance owner: R14. Prove two processes, different lines, cross-mode competition, takeover, stale renew and release, slow construction, and shutdown.

## Migration allocation and test isolation

The coordinator owns one additive `photon/state/0002` migration for selected-session versioning, delivery dispatch leases and recovery indexing, and distributed physical-line ownership. `photon/state/0001` and its checksum are immutable. R08 must request another ID before adding a backlink migration.

## Extraction map

The checkpoint preparation moves the existing implementations without changing their aggregate keys or behavior:

- R02: `chatSessions` is at `plugins/chassis/src/photon-state/bindings.ts:50-121`; `messages` is at lines 123-205; their aggregate returns at line 207.
- R03: `finishSequenced` is at `plugins/chassis/src/photon-state/receipts.ts:56-151`; `createPhotonReceiptStore()` spans lines 55-382.
- R04: `persistDelivery` starts at `plugins/chassis/src/photon-state/deliveries.ts:136`; `loadDelivery` starts at line 189; `createPhotonDeliveryStore()` spans lines 265-639.
- Coordinator: database protocol types live at `plugins/chassis/src/photon-state/db.ts:1-15`; genuinely shared helpers live at `plugins/chassis/src/photon-state/shared.ts:1-80`; `createPostgresPhotonStateStores()` remains at `plugins/chassis/src/photon-state.ts:55-548`.

`createPostgresPhotonStateStores()` remains the only aggregate constructor. Final integration adopts the required recoverable receipt and delivery ports, ciphertext installation persistence, selected-session CAS, and the additive `lineOwners` store. The obsolete delivery transition and plaintext installation persistence are removed rather than kept as a second runtime graph. No QM business store, scheduler, agent, queue, or second runtime is introduced.

Destructive PostgreSQL suites use `test/helpers/cp1-postgres.ts` to create a uniquely named disposable database. `CP1_POSTGRES_ADMIN_URL` must name an administrative database on a disposable PostgreSQL test cluster and its role must be a superuser because the suite creates a database, creates cluster roles, switches roles, and terminates test connections. Cluster-wide role creation runs under the helper's advisory lock. `CP1_REQUIRE_POSTGRES=1` turns an absent `CP1_POSTGRES_ADMIN_URL` into a failing prerequisite instead of a skip. CI supplies both values explicitly and registers the state suite in `test:pg`.

## Repair provenance

R13 resolves `cp1-repair-dispatch.json` from `git rev-parse --git-common-dir`, validates its schema against `repairBaseResolution` in `docs/imessage/repairs/ownership.json`, and accepts independent sibling repair commits when each declared diff is reachable from its exact 40-character `repairBaseCommit` and present in the candidate. Every `cp1/r01` through `cp1/r14` branch starts at that exact commit before its first repair change. It rejects a missing or moving base record, missing ancestry, undeclared paths, overlapping changes without an explicit dependency or resolution record, checkpoint mutation, and merge-resolution changes not attributable to a declared repair or coordinator resolution. Reachable historical WT01 through WT06 commits are sufficient; their old worktree directories are not inputs.

## Final adopted integration

The final aggregate exposes `PhotonInstallationCiphertextStore`, `ChatSessionSelectionStorePort`, `RecoverableEventReceiptStorePort`, `RecoverableDeliveryOperationStorePort`, and `PhotonLineOwnerStore`. The service-facing installation adapter remains the only component that decrypts an `InstallationRecord`. Delivery completion requires the exact owner, fence, expiry, attempt, and injected timestamp. The non-enumerable multipart callback exists only on the live dispatch object.

`photon/state/0001` remains byte-identical. `photon/state/0002` adds selection versioning, dispatch owner/fence/expiry and recovery indexes, and physical-line ownership. R08 separately owns `delivery/store/0007-photon-dm-backlinks` in the existing QM delivery-store migration sequence. All PostgreSQL repair tests use distinct disposable databases and serialized destructive execution.
