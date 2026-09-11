export const PHOTON_EXISTING_QM_VIEWS = [
  "session",
  "run",
  "tasks",
  "approval",
  "background-run",
  "files",
  "memory",
  "skills",
  "contexts",
  "loops",
  "crons",
  "webhooks",
  "inbox",
  "reviews",
  "applications",
  "runtime-settings",
  "keychain",
  "administration",
  "deployments",
  "settings",
] as const;

export type PhotonExistingQmView = (typeof PHOTON_EXISTING_QM_VIEWS)[number];

export interface ExistingQmViewMount {
  view: PhotonExistingQmView;
  resourceId: string;
  title: string;
  webPath: string;
  audience: "actor" | "conversation";
}

export interface ExistingQmActionContribution {
  actionId: string;
  label: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  webPath: string;
  resourceRevision: string;
}

export interface PhotonHostContribution {
  contributionId: string;
  conversation: ConversationReference;
  mounts: readonly ExistingQmViewMount[];
  actions: readonly ExistingQmActionContribution[];
}

export interface PhotonContributionProvider {
  forConversation(conversation: ConversationReference, actorId: string): Promise<PhotonHostContribution>;
}
import type { ConversationReference } from "../../../chassis/src/photon-contract.ts";
