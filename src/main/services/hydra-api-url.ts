export const DEFAULT_HYDRA_API_URL =
  "https://hydra-api-us-east-1.losbroxas.org";

export function resolveHydraApiBaseUrl(configuredUrl?: string): string {
  if (!configuredUrl?.trim()) return DEFAULT_HYDRA_API_URL;

  try {
    const url = new URL(configuredUrl.trim());
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.hostname
    ) {
      return DEFAULT_HYDRA_API_URL;
    }

    return url.href.replace(/\/+$/, "");
  } catch {
    return DEFAULT_HYDRA_API_URL;
  }
}
