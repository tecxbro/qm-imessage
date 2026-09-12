import type { LineReference } from "../../../chassis/src/photon-contract.ts";

import type { PhotonCliRunner } from "./cli-process.ts";

export type PhotonAssignmentSetupAction =
  { kind: "shared-recipient"; address: string } | { kind: "select-line"; lineId: string };

export type ResolvedPhotonAssignment = Pick<LineReference, "lineId" | "maskedAddress">;

export class PhotonAssignmentError extends Error {
  public readonly safeCode: "PHOTON_ASSIGNMENT_AMBIGUOUS" | "PHOTON_ASSIGNMENT_INVALID" | "PHOTON_ASSIGNMENT_MISSING";

  public constructor(
    safeCode: "PHOTON_ASSIGNMENT_AMBIGUOUS" | "PHOTON_ASSIGNMENT_INVALID" | "PHOTON_ASSIGNMENT_MISSING",
  ) {
    super(safeCode);
    this.name = "PhotonAssignmentError";
    this.safeCode = safeCode;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PhotonAssignmentError("PHOTON_ASSIGNMENT_INVALID");
  }
  return value as Record<string, unknown>;
}

function array(stdout: string): readonly Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) throw new PhotonAssignmentError("PHOTON_ASSIGNMENT_INVALID");
    return parsed.map(object);
  } catch (error) {
    if (error instanceof PhotonAssignmentError) throw error;
    throw new PhotonAssignmentError("PHOTON_ASSIGNMENT_INVALID");
  }
}

function e164(value: string): string {
  const normalized = value.replace(/[\s().-]/gu, "");
  if (!/^\+[1-9]\d{7,14}$/u.test(normalized)) {
    throw new PhotonAssignmentError("PHOTON_ASSIGNMENT_INVALID");
  }
  return normalized;
}

function string(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function maskPhotonAddress(address: string): string {
  const normalized = e164(address);
  return `${normalized.slice(0, 2)}•••${normalized.slice(-4)}`;
}

async function resolveSharedRecipient(
  cli: PhotonCliRunner,
  installationId: string,
  projectId: string,
  address: string,
  signal: AbortSignal,
): Promise<ResolvedPhotonAssignment> {
  const expectedAddress = e164(address);
  const result = await cli.run(installationId, { command: "users-list", projectId }, { signal });
  const matches = array(result.stdout).filter((candidate) => {
    const phoneNumber = string(candidate, ["phoneNumber"]);
    if (phoneNumber === undefined) return false;
    try {
      return e164(phoneNumber) === expectedAddress;
    } catch {
      return false;
    }
  });
  if (matches.length === 0) throw new PhotonAssignmentError("PHOTON_ASSIGNMENT_MISSING");
  if (matches.length !== 1) throw new PhotonAssignmentError("PHOTON_ASSIGNMENT_AMBIGUOUS");
  const match = matches[0]!;
  const lineId = string(match, ["id"]);
  const assignedAddress = string(match, ["assignedPhoneNumber"]);
  if (lineId === undefined) throw new PhotonAssignmentError("PHOTON_ASSIGNMENT_MISSING");
  return assignedAddress === undefined ? { lineId } : { lineId, maskedAddress: maskPhotonAddress(assignedAddress) };
}

async function resolveSelectedLine(
  cli: PhotonCliRunner,
  installationId: string,
  projectId: string,
  lineId: string,
  signal: AbortSignal,
): Promise<ResolvedPhotonAssignment> {
  const result = await cli.run(installationId, { command: "lines-list", projectId }, { signal });
  const matches = array(result.stdout).filter((candidate) => candidate.id === lineId);
  if (matches.length === 0) throw new PhotonAssignmentError("PHOTON_ASSIGNMENT_MISSING");
  if (matches.length !== 1) throw new PhotonAssignmentError("PHOTON_ASSIGNMENT_AMBIGUOUS");
  const address = string(matches[0]!, ["phoneNumber", "displayPhoneNumber"]);
  return address === undefined ? { lineId } : { lineId, maskedAddress: maskPhotonAddress(address) };
}

export async function resolvePhotonAssignment(
  cli: PhotonCliRunner,
  installationId: string,
  projectId: string,
  action: PhotonAssignmentSetupAction,
  signal: AbortSignal,
): Promise<ResolvedPhotonAssignment> {
  return action.kind === "shared-recipient"
    ? await resolveSharedRecipient(cli, installationId, projectId, action.address, signal)
    : await resolveSelectedLine(cli, installationId, projectId, action.lineId, signal);
}
