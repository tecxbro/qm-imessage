import { orgId as configOrgId } from "../config.ts";
import type { ConsentMode, OAuthClientResolver, ResolvedClient } from "./oauth.ts";
import { PROVIDERS, createSecretClientResolver } from "./oauth.ts";
import type { SecretSource } from "../credentials/secret-source.ts";

export { deriveConnectorKey, encryptSecret, decryptSecret } from "../../plugins/chassis/src/secret-box.ts";
export type { SecretKey } from "../../plugins/chassis/src/secret-box.ts";

export interface StoredConnectorClient {
  scopeId: string;
  provider: string;
  clientId: string;
  secretEnc: string;
  scopes?: string[];
  redirectAllowlist?: string[];
  consentMode?: ConsentMode;
  hostedDomain?: string;
  enabled: boolean;
  updatedBy?: string;
  updatedAt: number;
}

export interface ConnectorClientInput {
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  redirectAllowlist?: string[];
  consentMode?: ConsentMode;
  hostedDomain?: string;
  enabled?: boolean;
  updatedBy?: string;
}

export interface PublicConnectorClient {
  provider: string;
  clientId: string;
  scopes?: string[];
  redirectAllowlist?: string[];
  consentMode?: ConsentMode;
  hostedDomain?: string;
  enabled: boolean;
  hasSecret: boolean;
  updatedBy?: string;
  updatedAt: number;
}

export interface DecryptedConnectorClient {
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  redirectAllowlist?: string[];
  consentMode?: ConsentMode;
  hostedDomain?: string;
  enabled: boolean;
}

export function toPublicConnectorClient(rec: StoredConnectorClient): PublicConnectorClient {
  return {
    provider: rec.provider,
    clientId: rec.clientId,
    ...(rec.scopes ? { scopes: rec.scopes } : {}),
    ...(rec.redirectAllowlist ? { redirectAllowlist: rec.redirectAllowlist } : {}),
    ...(rec.consentMode ? { consentMode: rec.consentMode } : {}),
    ...(rec.hostedDomain ? { hostedDomain: rec.hostedDomain } : {}),
    enabled: rec.enabled,
    hasSecret: !!rec.secretEnc,
    ...(rec.updatedBy ? { updatedBy: rec.updatedBy } : {}),
    updatedAt: rec.updatedAt,
  };
}

export interface ConnectorClientReader {
  getConnectorClientSecret(orgScopeId: string, provider: string): Promise<DecryptedConnectorClient | null>;
}

export function createConnectorClientResolver(opts: {
  reader: ConnectorClientReader;
  orgScopeId: (orgId: string) => string;
  secrets?: SecretSource;
}): OAuthClientResolver {
  const envResolver = createSecretClientResolver(opts.secrets);
  return async (providerName, ctx): Promise<ResolvedClient> => {
    if (!PROVIDERS[providerName]) throw new Error(`unknown OAuth provider: ${providerName}`);
    const orgId = configOrgId();
    const rec = await opts.reader.getConnectorClientSecret(opts.orgScopeId(orgId), providerName);
    if (rec) {
      if (!rec.enabled) throw new Error(`connector '${providerName}' is disabled for this org`);
      return {
        id: rec.clientId,
        secret: rec.clientSecret,
        clientRef: `org:${orgId}:${providerName}`,
        ...(rec.scopes ? { scopes: rec.scopes } : {}),
        ...(rec.redirectAllowlist ? { redirectAllowlist: rec.redirectAllowlist } : {}),
        ...(rec.hostedDomain ? { hostedDomain: rec.hostedDomain } : {}),
      };
    }
    return envResolver(providerName, ctx);
  };
}
