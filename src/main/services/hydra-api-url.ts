export const DEFAULT_HYDRA_API_URL =
  "https://hydra-api-us-east-1.losbroxas.org";

export const DEFAULT_HYDRA_AUTH_URL = "https://auth.hydralauncher.gg";

export const DEFAULT_HYDRA_CHECKOUT_URL = "https://checkout.hydralauncher.gg";

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

export function resolveHydraAuthUrl(configuredUrl?: string): string {
  if (!configuredUrl?.trim()) return DEFAULT_HYDRA_AUTH_URL;

  try {
    const url = new URL(configuredUrl.trim());
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.hostname
    ) {
      return DEFAULT_HYDRA_AUTH_URL;
    }

    return url.href.replace(/\/+$/, "");
  } catch {
    return DEFAULT_HYDRA_AUTH_URL;
  }
}

export function resolveHydraCheckoutUrl(configuredUrl?: string): string {
  if (!configuredUrl?.trim()) return DEFAULT_HYDRA_CHECKOUT_URL;

  try {
    const url = new URL(configuredUrl.trim());
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.hostname
    ) {
      return DEFAULT_HYDRA_CHECKOUT_URL;
    }

    return url.href.replace(/\/+$/, "");
  } catch {
    return DEFAULT_HYDRA_CHECKOUT_URL;
  }
}

