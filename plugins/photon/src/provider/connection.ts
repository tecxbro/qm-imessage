import type { ProviderLine } from "./capabilities.ts";
import { constructAdvanced, constructSpectrum, type AdvancedClient, type SpectrumApp } from "./compatibility.ts";

export interface LineCredentials {
  readonly address: string;
  readonly token: string;
}

interface ConnectionLifetime {
  readonly line: ProviderLine;
  assertActive(): void;
  stop(): Promise<void>;
  addConsumer(stop: () => Promise<void>): () => void;
}

export type ProviderConnection = ConnectionLifetime &
  (
    | { readonly kind: "advanced"; readonly sdk: AdvancedClient }
    | { readonly kind: "spectrum"; readonly sdk: SpectrumApp }
  );

export interface ProviderConstructors {
  advanced: typeof constructAdvanced;
  spectrum: typeof constructSpectrum;
}

const localOwners = new Set<string>();

export function createConnectionManager(
  constructors: ProviderConstructors = { advanced: constructAdvanced, spectrum: constructSpectrum },
) {
  let current: ProviderConnection | undefined;
  let transition = Promise.resolve();
  let epoch = 0;

  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = transition.then(action);
    transition = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    replace(line: ProviderLine, credentials: LineCredentials): Promise<ProviderConnection> {
      const config = structuredClone({ line, credentials });
      if (
        !config.credentials.address ||
        !config.credentials.token ||
        !config.line.phone ||
        !config.line.reference.installationId ||
        !config.line.reference.lineId
      )
        return Promise.reject(new Error("PROVIDER_CREDENTIALS_OR_LINE_MISSING"));
      const generation = ++epoch;
      return serialize(async () => {
        await current?.stop();
        current = undefined;
        if (generation !== epoch) throw new Error("PROVIDER_REPLACED_DURING_CONSTRUCTION");
        const ownerKey = JSON.stringify([config.line.reference.installationId, config.line.reference.lineId]);
        if (localOwners.has(ownerKey)) throw new Error("PROVIDER_LINE_ALREADY_OWNED");
        localOwners.add(ownerKey);
        let resources: { kind: "advanced"; sdk: AdvancedClient } | { kind: "spectrum"; sdk: SpectrumApp };
        try {
          resources =
            config.line.reference.provider === "advanced-imessage"
              ? { kind: "advanced", sdk: constructors.advanced(config.credentials) }
              : {
                  kind: "spectrum",
                  sdk: await constructors.spectrum({ ...config.credentials, phone: config.line.phone }),
                };
        } catch (error) {
          localOwners.delete(ownerKey);
          throw error;
        }
        let active = true;
        let stopping: Promise<void> | undefined;
        const consumers = new Set<() => Promise<void>>();
        const connection: ProviderConnection = {
          ...resources,
          line: config.line,
          assertActive() {
            if (!active || generation !== epoch) throw new Error("PROVIDER_CONNECTION_STOPPED");
          },
          addConsumer(stop) {
            connection.assertActive();
            if (consumers.size > 0) throw new Error("PROVIDER_INTAKE_ALREADY_OWNED");
            consumers.add(stop);
            return () => {
              consumers.delete(stop);
            };
          },
          stop() {
            active = false;
            stopping ??= (async () => {
              const results = await Promise.allSettled([...consumers].map((stop) => stop()));
              const closing = resources.kind === "advanced" ? resources.sdk.close() : resources.sdk.stop();
              await closing;
              const failure = results.find((result) => result.status === "rejected");
              if (failure?.status === "rejected") throw failure.reason;
              consumers.clear();
              localOwners.delete(ownerKey);
            })().catch((error: unknown) => {
              stopping = undefined;
              throw error;
            });
            return stopping;
          },
        };
        if (generation !== epoch) {
          await connection.stop();
          throw new Error("PROVIDER_REPLACED_DURING_CONSTRUCTION");
        }
        current = connection;
        return connection;
      });
    },
    stop(): Promise<void> {
      ++epoch;
      return serialize(async () => {
        await current?.stop();
        current = undefined;
      });
    },
  };
}
