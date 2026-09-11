export const PHOTON_EXISTING_QM_VIEWS = [
  "session",
  "approval",
  "background-run",
  "files",
  "memory",
  "skills",
  "loops",
  "webhooks",
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
  conversationId: string;
  mounts: readonly ExistingQmViewMount[];
  actions: readonly ExistingQmActionContribution[];
}

export interface PhotonContributionProvider {
  forConversation(conversationId: string, actorId: string): Promise<PhotonHostContribution>;
}
