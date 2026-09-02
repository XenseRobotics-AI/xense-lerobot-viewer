const HF_MIRROR = "https://hf-mirror.com";

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
  return trimEndpoint(env.HF_CATALOG_ENDPOINT) ?? resolveHfSyncEndpoint(env);
}
