export const HF_MIRROR_ENDPOINT = "https://hf-mirror.com";
export const HF_OFFICIAL_ENDPOINT = "https://huggingface.co";

const HF_MIRROR = HF_MIRROR_ENDPOINT;
const HF_HUB = HF_OFFICIAL_ENDPOINT;
/** Endpoints selectable by the Workbench UI. Keep this allowlist closed. */
export function normalizeHfEndpoint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const endpoint = value.trim().replace(/\/+$/u, "");
  return endpoint === HF_MIRROR_ENDPOINT || endpoint === HF_OFFICIAL_ENDPOINT
    ? endpoint
    : null;
}

function trimEndpoint(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveHfSyncEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return trimEndpoint(env.HF_ENDPOINT) ?? HF_MIRROR;
}

export function resolveHfCatalogEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return trimEndpoint(env.HF_CATALOG_ENDPOINT) ?? HF_HUB;
}
