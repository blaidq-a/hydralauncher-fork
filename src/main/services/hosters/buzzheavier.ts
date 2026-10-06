import axios from "axios";
import { HOSTER_USER_AGENT } from "./hoster-user-agent.js";

const HOSTS = ["buzzheavier.com", "bzzhr.to"];
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
    headers["hx-redirect"] ?? headers["HX-Redirect"] ?? headers.location;
  if (typeof rawRedirect !== "string" || !rawRedirect.trim()) return undefined;

  const redirect = isHttpUrl(rawRedirect.trim(), requestUrl);
  if (!redirect) return undefined;

  const { hostname, pathname } = new URL(redirect);
  if (hostname === "ts.bzzhr.to" && pathname.startsWith("/d/")) {
    return redirect;
  }

  if (/\/d\/[^/]+(?:\/|$)/i.test(pathname)) return redirect;
  return undefined;
}

export class BuzzheavierApi {
  public static canHandle(uri: string): boolean {
    try {
      const hostname = new URL(uri).hostname.toLowerCase();
      return HOSTS.some(
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

    const { hostname, pathname } = new URL(uri);
    if (hostname === "ts.bzzhr.to" && pathname.startsWith("/d/")) {
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
    const fallback = new URL(pageUrl);
    fallback.pathname = `${fallback.pathname.replace(/\/+$/, "")}/download`;
    const endpoint = action?.url ?? fallback.href;
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

    const directUrl = extractBuzzheavierRedirect(
      downloadResponse.headers,
      endpoint
    );
    if (directUrl) return directUrl;

    throw new Error(
      `Buzzheavier did not return a downloadable CDN redirect (HTTP ${downloadResponse.status})`
    );
  }
}
