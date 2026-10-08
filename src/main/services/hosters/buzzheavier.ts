import axios from "axios";
import { HOSTER_USER_AGENT } from "./hoster-user-agent.js";

const HOSTS = ["buzzheavier.com", "bzzhr.to", "bzzhr.co", "fuckingfast.net"];
const DIRECT_DOWNLOAD_HOSTS = ["ts.bzzhr.to", "flashbang.sh"];
const DOWNLOAD_ACTION_PATTERN =
  /hx-(get|post)\s*=\s*(["'])([^"']*\/download(?:[/?#][^"']*)?)\2/i;

function isHttpUrl(value: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function extractBuzzheavierDownloadAction(
  html: string,
  pageUrl: string
): { method: "get" | "post"; url: string } | undefined {
  const match = DOWNLOAD_ACTION_PATTERN.exec(html);
  const url = match?.[3] && isHttpUrl(match[3], pageUrl);
  if (!match || !url) return undefined;

  return { method: match[1].toLowerCase() as "get" | "post", url };
}

export function extractBuzzheavierRedirect(
  headers: Record<string, unknown>,
  requestUrl: string
): string | undefined {
  const rawRedirect =
    headers["hx-redirect"] ??
    headers["HX-Redirect"] ??
    headers.location ??
    headers.Location;
  if (typeof rawRedirect !== "string" || !rawRedirect.trim()) return undefined;

  const redirect = isHttpUrl(rawRedirect.trim(), requestUrl);
  if (!redirect) return undefined;

  const { hostname, pathname } = new URL(redirect);
  if (
    DIRECT_DOWNLOAD_HOSTS.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`)
    )
  ) {
    return redirect;
  }

  if (/\/d\/[^/]+(?:\/|$)/i.test(pathname)) return redirect;
  return undefined;
}

export function extractBuzzheavierDownloadToken(
  html: string
): string | undefined {
  const match = /\/download\?t=([^"'&\\#\s<>]+)/i.exec(html);
  return match?.[1];
}

export class BuzzheavierApi {
  public static canHandle(uri: string): boolean {
    try {
      const hostname = new URL(uri).hostname.toLowerCase();
      return [...HOSTS, ...DIRECT_DOWNLOAD_HOSTS].some(
        (host) => hostname === host || hostname.endsWith(`.${host}`)
      );
    } catch {
      return false;
    }
  }

  public static async getDownloadUrl(uri: string): Promise<string> {
    if (!this.canHandle(uri)) {
      throw new Error(`Unsupported Buzzheavier URL: ${uri}`);
    }

    const { hostname } = new URL(uri);
    if (
      DIRECT_DOWNLOAD_HOSTS.some(
        (host) => hostname === host || hostname.endsWith(`.${host}`)
      )
    ) {
      return uri;
    }

    const pageResponse = await axios.get<string>(uri, {
      headers: {
        "User-Agent": HOSTER_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      timeout: 30000,
    });

    const pageUrl = pageResponse.request?.res?.responseUrl || uri;
    const action = extractBuzzheavierDownloadAction(pageResponse.data, pageUrl);
    const token = extractBuzzheavierDownloadToken(pageResponse.data);
    const fallback = new URL(pageUrl);
    fallback.pathname = `${fallback.pathname.replace(/\/+$/, "")}/download`;
    const endpointUrl = new URL(action?.url ?? fallback.href);
    if (token && !endpointUrl.searchParams.has("t")) {
      endpointUrl.searchParams.set("t", token);
    }
    const endpoint = endpointUrl.href;
    const method = action?.method ?? "get";

    const downloadResponse = await axios.request<string>({
      url: endpoint,
      method,
      maxRedirects: 0,
      validateStatus: (status) => status < 500,
      headers: {
        "User-Agent": HOSTER_USER_AGENT,
        Accept: "*/*",
        "HX-Request": "true",
        "HX-Current-URL": pageUrl,
        Referer: pageUrl,
      },
      timeout: 30000,
    });

    const directUrl =
      downloadResponse.status < 400
        ? extractBuzzheavierRedirect(downloadResponse.headers, endpoint)
        : undefined;
    if (directUrl) return directUrl;

    throw new Error(
      `Buzzheavier did not return a downloadable CDN redirect (HTTP ${downloadResponse.status})`
    );
  }
}
