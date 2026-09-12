import { PhotonCliProcessError, type PhotonCliRunner } from "./cli-process.ts";

export interface PhotonProject {
  id: string;
  name: string;
}

export type PhotonProjectSetupAction =
  { kind: "select-project"; projectId: string } | { kind: "create-project"; name: string };

export class PhotonProjectError extends Error {
  public readonly safeCode:
    | "PHOTON_PROJECT_CREATE_FAILED"
    | "PHOTON_PROJECT_LIST_INVALID"
    | "PHOTON_PROJECT_NOT_FOUND"
    | "PHOTON_PROJECT_SECRET_MISSING";

  public constructor(
    safeCode:
      | "PHOTON_PROJECT_CREATE_FAILED"
      | "PHOTON_PROJECT_LIST_INVALID"
      | "PHOTON_PROJECT_NOT_FOUND"
      | "PHOTON_PROJECT_SECRET_MISSING",
  ) {
    super(safeCode);
    this.name = "PhotonProjectError";
    this.safeCode = safeCode;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PhotonProjectError("PHOTON_PROJECT_LIST_INVALID");
  }
  return value as Record<string, unknown>;
}

function json(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new PhotonProjectError("PHOTON_PROJECT_LIST_INVALID");
  }
}

function project(value: unknown): PhotonProject {
  const input = object(value);
  if (
    typeof input.id !== "string" ||
    input.id.length === 0 ||
    typeof input.name !== "string" ||
    input.name.length === 0
  ) {
    throw new PhotonProjectError("PHOTON_PROJECT_LIST_INVALID");
  }
  return { id: input.id, name: input.name };
}

export async function listPhotonProjects(
  cli: PhotonCliRunner,
  installationId: string,
  signal: AbortSignal,
): Promise<readonly PhotonProject[]> {
  const result = await cli.run(installationId, { command: "projects-list" }, { signal });
  const parsed = json(result.stdout);
  if (!Array.isArray(parsed)) throw new PhotonProjectError("PHOTON_PROJECT_LIST_INVALID");
  return parsed.map(project);
}

export async function selectPhotonProject(
  cli: PhotonCliRunner,
  installationId: string,
  projectId: string,
  signal: AbortSignal,
): Promise<PhotonProject> {
  const matches = (await listPhotonProjects(cli, installationId, signal)).filter(
    (candidate) => candidate.id === projectId,
  );
  if (matches.length !== 1) throw new PhotonProjectError("PHOTON_PROJECT_NOT_FOUND");
  return matches[0]!;
}

export async function createPhotonProject(
  cli: PhotonCliRunner,
  installationId: string,
  action: Extract<PhotonProjectSetupAction, { kind: "create-project" }>,
  signal: AbortSignal,
): Promise<PhotonProject> {
  let result;
  try {
    result = await cli.run(installationId, { command: "project-create", name: action.name }, { signal });
  } catch (error) {
    if (error instanceof PhotonCliProcessError) throw error;
    throw new PhotonProjectError("PHOTON_PROJECT_CREATE_FAILED");
  }
  const parsed = object(json(result.stdout));
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new PhotonProjectError("PHOTON_PROJECT_CREATE_FAILED");
  }
  return {
    id: parsed.id,
    name: typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : action.name.trim(),
  };
}

export async function resolvePhotonProject(
  cli: PhotonCliRunner,
  installationId: string,
  action: PhotonProjectSetupAction,
  signal: AbortSignal,
): Promise<PhotonProject> {
  return action.kind === "select-project"
    ? await selectPhotonProject(cli, installationId, action.projectId, signal)
    : await createPhotonProject(cli, installationId, action, signal);
}

export async function readPhotonProjectSecret(
  cli: PhotonCliRunner,
  installationId: string,
  projectId: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await cli.run(installationId, { command: "project-secret", projectId }, { signal });
  const parsed = object(json(result.stdout));
  if (parsed.id !== projectId || typeof parsed.projectSecret !== "string" || parsed.projectSecret.length === 0) {
    throw new PhotonProjectError("PHOTON_PROJECT_SECRET_MISSING");
  }
  return parsed.projectSecret;
}

export async function managementLoginIsValid(
  cli: PhotonCliRunner,
  installationId: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await cli.run(installationId, { command: "whoami" }, { signal });
    return true;
  } catch (error) {
    if (error instanceof PhotonCliProcessError && error.code === "not-authenticated") return false;
    throw error;
  }
}
