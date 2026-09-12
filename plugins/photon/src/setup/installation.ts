import {
  projectInstallationForDashboard,
  type InstallationDisplayStatus,
  type PrivateInstallationStatus,
} from "../../../chassis/src/photon-contract.ts";
import type { InstallationRecord, InstallationStorePort } from "../ports.ts";
import { PhotonAssignmentError, resolvePhotonAssignment, type PhotonAssignmentSetupAction } from "./assignment.ts";
import { PhotonCliProcessError, type PhotonCliRunner } from "./cli-process.ts";
import { beginPhotonDeviceLogin, PHOTON_MANAGEMENT_ORIGIN } from "./device-login.ts";
import {
  managementLoginIsValid,
  PhotonProjectError,
  readPhotonProjectSecret,
  resolvePhotonProject,
  selectPhotonProject,
  type PhotonProjectSetupAction,
} from "./project.ts";

export const PHOTON_INSTALLATION_SAFE_CODES = [
  "PHOTON_ASSIGNMENT_AMBIGUOUS",
  "PHOTON_ASSIGNMENT_INVALID",
  "PHOTON_ASSIGNMENT_MISSING",
  "PHOTON_ASSIGNMENT_REQUIRED",
  "PHOTON_AUTHORIZATION_DENIED",
  "PHOTON_AUTHORIZATION_EXPIRED",
  "PHOTON_AUTHORIZATION_MALFORMED",
  "PHOTON_CLI_FAILED",
  "PHOTON_CLI_NOT_AVAILABLE",
  "PHOTON_CLI_OUTPUT_LIMIT",
  "PHOTON_CLI_VERSION_UNSUPPORTED",
  "PHOTON_CONFIG_UNSAFE",
  "PHOTON_PROJECT_CREATE_FAILED",
  "PHOTON_PROJECT_LIST_INVALID",
  "PHOTON_PROJECT_NOT_FOUND",
  "PHOTON_PROJECT_SECRET_MISSING",
  "PHOTON_PROJECT_SELECTION_CONFLICT",
  "PHOTON_PROJECT_SELECTION_REQUIRED",
  "PHOTON_REAUTHORIZATION_REQUIRED",
  "PHOTON_SETUP_CANCELLED",
  "PHOTON_SETUP_CONFLICT",
  "PHOTON_SETUP_FAILED",
  "PHOTON_SETUP_TIMEOUT",
] as const;

export type PhotonInstallationSafeCode = (typeof PHOTON_INSTALLATION_SAFE_CODES)[number];

export interface PhotonOwnerRevisionPort {
  read(): Promise<string>;
}

export interface PhotonInstallationSetupAction {
  project: PhotonProjectSetupAction;
  assignment: PhotonAssignmentSetupAction;
}

interface ActiveAttempt {
  controller: AbortController;
  visible: Promise<InstallationDisplayStatus>;
  completion: Promise<InstallationDisplayStatus>;
}

class PhotonInstallationError extends Error {
  public readonly safeCode: PhotonInstallationSafeCode;

  public constructor(safeCode: PhotonInstallationSafeCode) {
    super(safeCode);
    this.name = "PhotonInstallationError";
    this.safeCode = safeCode;
  }
}

function ownerRevision(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError("Owner revision is invalid");
  }
  return normalized;
}

function safeCodeFor(error: unknown): PhotonInstallationSafeCode {
  if (error instanceof PhotonInstallationError) return error.safeCode;
  if (error instanceof PhotonProjectError) return error.safeCode;
  if (error instanceof PhotonAssignmentError) return error.safeCode;
  if (error instanceof PhotonCliProcessError) {
    switch (error.code) {
      case "authorization-denied":
        return "PHOTON_AUTHORIZATION_DENIED";
      case "authorization-expired":
        return "PHOTON_AUTHORIZATION_EXPIRED";
      case "cancelled":
        return "PHOTON_SETUP_CANCELLED";
      case "not-authenticated":
        return "PHOTON_REAUTHORIZATION_REQUIRED";
      case "output-limit":
        return "PHOTON_CLI_OUTPUT_LIMIT";
      case "spawn-failed":
        return "PHOTON_CLI_NOT_AVAILABLE";
      case "timeout":
        return "PHOTON_SETUP_TIMEOUT";
      case "unsafe-config":
        return "PHOTON_CONFIG_UNSAFE";
      case "unsupported-version":
        return "PHOTON_CLI_VERSION_UNSUPPORTED";
      case "command-failed":
        return "PHOTON_CLI_FAILED";
    }
  }
  return "PHOTON_SETUP_FAILED";
}

function privateFields(status: PrivateInstallationStatus): Pick<PrivateInstallationStatus, "management" | "runtime"> {
  return {
    ...(status.management === undefined ? {} : { management: status.management }),
    ...(status.runtime === undefined ? {} : { runtime: status.runtime }),
  };
}

export class PhotonCliInstallationService {
  readonly #installationId: string;
  readonly #store: InstallationStorePort;
  readonly #ownerRevision: PhotonOwnerRevisionPort;
  readonly #cli: PhotonCliRunner;
  readonly #loginTimeoutMs: number;
  readonly #now: () => Date;
  #active: ActiveAttempt | undefined;
  #closed = false;

  public constructor(options: {
    installationId: string;
    store: InstallationStorePort;
    ownerRevision: PhotonOwnerRevisionPort;
    cli: PhotonCliRunner;
    loginTimeoutMs?: number;
    now?: () => Date;
  }) {
    this.#installationId = options.installationId;
    this.#store = options.store;
    this.#ownerRevision = options.ownerRevision;
    this.#cli = options.cli;
    this.#loginTimeoutMs = options.loginTimeoutMs ?? 1_800_000;
    this.#now = options.now ?? (() => new Date());
    this.#cli.configDirectory(options.installationId);
  }

  public async status(): Promise<InstallationDisplayStatus> {
    const record = await this.#store.read(this.#installationId);
    if (record === undefined) return { state: "not-started", installationId: this.#installationId };
    return await this.#publicStatus(record);
  }

  public start(action: PhotonInstallationSetupAction): Promise<InstallationDisplayStatus> {
    return this.#begin((signal, publish) => this.#start(action, signal, publish));
  }

  public resume(assignment?: PhotonAssignmentSetupAction): Promise<InstallationDisplayStatus> {
    return this.#begin((signal) => this.#resume(assignment, signal));
  }

  public async waitForCompletion(): Promise<InstallationDisplayStatus> {
    return this.#active === undefined ? await this.status() : await this.#active.completion;
  }

  public async managementLoginStatus(): Promise<"valid" | "reauthorization-required"> {
    const controller = new AbortController();
    await this.#cli.verifyVersion(this.#installationId, controller.signal);
    return (await managementLoginIsValid(this.#cli, this.#installationId, controller.signal))
      ? "valid"
      : "reauthorization-required";
  }

  public async cancel(): Promise<InstallationDisplayStatus> {
    const active = this.#active;
    if (active === undefined) return await this.status();
    active.controller.abort();
    return await active.completion;
  }

  public async close(): Promise<void> {
    this.#closed = true;
    const active = this.#active;
    if (active === undefined) return;
    active.controller.abort();
    await active.completion;
  }

  #begin(
    execute: (
      signal: AbortSignal,
      publish: (status: InstallationDisplayStatus) => void,
    ) => Promise<InstallationDisplayStatus>,
  ): Promise<InstallationDisplayStatus> {
    if (this.#closed) return Promise.reject(new Error("Photon installation service is closed"));
    if (this.#active !== undefined) return this.#active.visible;
    const controller = new AbortController();
    let resolveVisible!: (status: InstallationDisplayStatus) => void;
    let published = false;
    const visible = new Promise<InstallationDisplayStatus>((resolve) => {
      resolveVisible = resolve;
    });
    const publish = (status: InstallationDisplayStatus) => {
      if (published) return;
      published = true;
      resolveVisible(status);
    };
    const completion = execute(controller.signal, publish)
      .then((status) => {
        publish(status);
        return status;
      })
      .finally(() => {
        if (this.#active?.completion === completion) this.#active = undefined;
      });
    this.#active = { controller, visible, completion };
    return visible;
  }

  async #start(
    action: PhotonInstallationSetupAction,
    signal: AbortSignal,
    publish: (status: InstallationDisplayStatus) => void,
  ): Promise<InstallationDisplayStatus> {
    let record: InstallationRecord | undefined;
    try {
      const revision = ownerRevision(await this.#ownerRevision.read());
      record = await this.#loadOrCreate(revision);
      const existing = await this.#publicStatus(record);
      if (existing.state === "connected" || existing.state === "needs-owner-rebind") return existing;
      if (record.status.state === "provisioning" || record.status.state === "awaiting-authorization") {
        return existing;
      }
      record = await this.#transition(
        record,
        {
          state: "provisioning",
          installationId: this.#installationId,
          management: { credentialPath: this.#cli.configDirectory(this.#installationId) },
          ...privateFields(record.status),
        },
        revision,
      );
      const login = beginPhotonDeviceLogin(this.#cli, this.#installationId, {
        signal,
        timeoutMs: this.#loginTimeoutMs,
        now: this.#now,
      });
      let authorization;
      try {
        authorization = await login.authorization;
      } catch (error) {
        if (error instanceof PhotonCliProcessError && error.code === "command-failed") {
          throw new PhotonInstallationError("PHOTON_AUTHORIZATION_MALFORMED");
        }
        throw error;
      }
      record = await this.#transition(record, {
        state: "awaiting-authorization",
        installationId: this.#installationId,
        ...authorization,
        managementOrigin: PHOTON_MANAGEMENT_ORIGIN,
        management: { credentialPath: this.#cli.configDirectory(this.#installationId) },
        ...(record.status.runtime === undefined ? {} : { runtime: record.status.runtime }),
      });
      publish(projectInstallationForDashboard(record.status));
      try {
        await login.completion;
      } catch (error) {
        if (error instanceof PhotonCliProcessError && error.code === "timeout") {
          throw new PhotonInstallationError("PHOTON_AUTHORIZATION_EXPIRED");
        }
        throw error;
      }
      record = await this.#transition(record, {
        state: "provisioning",
        installationId: this.#installationId,
        management: { credentialPath: this.#cli.configDirectory(this.#installationId) },
        ...(record.status.runtime === undefined ? {} : { runtime: record.status.runtime }),
      });
      record = await this.#finishProvisioning(record, revision, action, signal);
      return await this.#publicStatus(record);
    } catch (error) {
      if (this.#closed && signal.aborted) return await this.status();
      return await this.#recordFailure(record, safeCodeFor(error));
    }
  }

  async #resume(
    assignment: PhotonAssignmentSetupAction | undefined,
    signal: AbortSignal,
  ): Promise<InstallationDisplayStatus> {
    let record = await this.#store.read(this.#installationId);
    if (record === undefined) return { state: "not-started", installationId: this.#installationId };
    try {
      const status = await this.#publicStatus(record);
      if (
        status.state === "connected" ||
        status.state === "needs-owner-rebind" ||
        status.state === "needs-credential-repair"
      ) {
        return status;
      }
      if (record.status.state === "awaiting-authorization") {
        throw new PhotonInstallationError("PHOTON_REAUTHORIZATION_REQUIRED");
      }
      if (record.status.state !== "provisioning") return status;
      await this.#cli.verifyVersion(this.#installationId, signal);
      if (!(await managementLoginIsValid(this.#cli, this.#installationId, signal))) {
        throw new PhotonInstallationError("PHOTON_REAUTHORIZATION_REQUIRED");
      }
      const revision = ownerRevision(await this.#ownerRevision.read());
      if (revision !== record.ownerRevision) {
        record = await this.#transition(record, {
          state: "needs-owner-rebind",
          installationId: this.#installationId,
          ...privateFields(record.status),
        });
        return await this.#publicStatus(record);
      }
      const projectId = record.installation.projectId;
      if (projectId === undefined) throw new PhotonInstallationError("PHOTON_PROJECT_SELECTION_REQUIRED");
      if (assignment === undefined) throw new PhotonInstallationError("PHOTON_ASSIGNMENT_REQUIRED");
      await selectPhotonProject(this.#cli, this.#installationId, projectId, signal);
      if (record.status.runtime?.projectSecret === undefined) {
        const projectSecret = await readPhotonProjectSecret(this.#cli, this.#installationId, projectId, signal);
        record = await this.#transition(record, {
          state: "provisioning",
          installationId: this.#installationId,
          management: { credentialPath: this.#cli.configDirectory(this.#installationId) },
          runtime: { projectSecret },
        });
      }
      record = await this.#connect(record, revision, assignment, signal);
      return await this.#publicStatus(record);
    } catch (error) {
      if (this.#closed && signal.aborted) return await this.status();
      return await this.#recordFailure(record, safeCodeFor(error));
    }
  }

  async #finishProvisioning(
    record: InstallationRecord,
    revision: string,
    action: PhotonInstallationSetupAction,
    signal: AbortSignal,
  ): Promise<InstallationRecord> {
    if (ownerRevision(await this.#ownerRevision.read()) !== revision) {
      return await this.#transition(record, {
        state: "needs-owner-rebind",
        installationId: this.#installationId,
        ...privateFields(record.status),
      });
    }
    let projectId = record.installation.projectId;
    if (projectId !== undefined) {
      if (action.project.kind === "select-project" && action.project.projectId !== projectId) {
        throw new PhotonInstallationError("PHOTON_PROJECT_SELECTION_CONFLICT");
      }
      await selectPhotonProject(this.#cli, this.#installationId, projectId, signal);
    } else {
      const project = await resolvePhotonProject(this.#cli, this.#installationId, action.project, signal);
      projectId = project.id;
      record = await this.#transition(
        record,
        {
          state: "provisioning",
          installationId: this.#installationId,
          management: { credentialPath: this.#cli.configDirectory(this.#installationId) },
        },
        undefined,
        projectId,
      );
    }
    const projectSecret = await readPhotonProjectSecret(this.#cli, this.#installationId, projectId, signal);
    record = await this.#transition(record, {
      state: "provisioning",
      installationId: this.#installationId,
      management: { credentialPath: this.#cli.configDirectory(this.#installationId) },
      runtime: { projectSecret },
    });
    return await this.#connect(record, revision, action.assignment, signal);
  }

  async #connect(
    record: InstallationRecord,
    revision: string,
    assignmentAction: PhotonAssignmentSetupAction,
    signal: AbortSignal,
  ): Promise<InstallationRecord> {
    const projectId = record.installation.projectId;
    const projectSecret = record.status.runtime?.projectSecret;
    if (projectId === undefined) throw new PhotonInstallationError("PHOTON_PROJECT_SELECTION_REQUIRED");
    if (projectSecret === undefined) throw new PhotonProjectError("PHOTON_PROJECT_SECRET_MISSING");
    const assignment = await resolvePhotonAssignment(
      this.#cli,
      this.#installationId,
      projectId,
      assignmentAction,
      signal,
    );
    if (ownerRevision(await this.#ownerRevision.read()) !== revision) {
      return await this.#transition(record, {
        state: "needs-owner-rebind",
        installationId: this.#installationId,
        ...privateFields(record.status),
      });
    }
    return await this.#transition(record, {
      state: "connected",
      installationId: this.#installationId,
      projectId,
      lines: [assignment],
      management: { credentialPath: this.#cli.configDirectory(this.#installationId) },
      runtime: { projectSecret },
    });
  }

  async #loadOrCreate(revision: string): Promise<InstallationRecord> {
    const existing = await this.#store.read(this.#installationId);
    if (existing !== undefined) return existing;
    const initial: InstallationRecord = {
      installation: { installationId: this.#installationId },
      status: { state: "not-started", installationId: this.#installationId },
      ownerRevision: revision,
      version: 0,
    };
    if (await this.#store.create(initial)) return initial;
    const raced = await this.#store.read(this.#installationId);
    if (raced === undefined) throw new PhotonInstallationError("PHOTON_SETUP_CONFLICT");
    return raced;
  }

  async #transition(
    current: InstallationRecord,
    status: PrivateInstallationStatus,
    nextOwnerRevision?: string,
    projectId?: string,
  ): Promise<InstallationRecord> {
    const retainedProjectId = projectId ?? current.installation.projectId;
    const next: InstallationRecord = {
      installation: {
        installationId: this.#installationId,
        ...(retainedProjectId === undefined ? {} : { projectId: retainedProjectId }),
      },
      status,
      ownerRevision: nextOwnerRevision ?? current.ownerRevision,
      version: current.version + 1,
    };
    if (!(await this.#store.compareAndSet(this.#installationId, current.version, next))) {
      throw new PhotonInstallationError("PHOTON_SETUP_CONFLICT");
    }
    return next;
  }

  async #recordFailure(
    current: InstallationRecord | undefined,
    safeCode: PhotonInstallationSafeCode,
  ): Promise<InstallationDisplayStatus> {
    const latest = await this.#store.read(this.#installationId);
    if (latest === undefined) {
      if (current === undefined) return { state: "failed", installationId: this.#installationId, safeCode };
      return projectInstallationForDashboard(current.status);
    }
    if (safeCode === "PHOTON_SETUP_CONFLICT" || latest.status.state === "connected") {
      return await this.#publicStatus(latest);
    }
    try {
      const failed = await this.#transition(latest, {
        state: "failed",
        installationId: this.#installationId,
        safeCode,
        ...privateFields(latest.status),
      });
      return projectInstallationForDashboard(failed.status);
    } catch (error) {
      if (!(error instanceof PhotonInstallationError) || error.safeCode !== "PHOTON_SETUP_CONFLICT") throw error;
      return await this.status();
    }
  }

  async #publicStatus(record: InstallationRecord): Promise<InstallationDisplayStatus> {
    if (record.status.state === "connected") {
      const revision = ownerRevision(await this.#ownerRevision.read());
      if (revision !== record.ownerRevision) {
        return { state: "needs-owner-rebind", installationId: this.#installationId };
      }
      if (record.status.runtime?.projectSecret === undefined) {
        return { state: "needs-credential-repair", installationId: this.#installationId };
      }
    }
    if (
      record.status.state === "awaiting-authorization" &&
      new Date(record.status.expiresAt).getTime() <= this.#now().getTime()
    ) {
      return {
        state: "failed",
        installationId: this.#installationId,
        safeCode: "PHOTON_AUTHORIZATION_EXPIRED",
      };
    }
    return projectInstallationForDashboard(record.status);
  }
}
