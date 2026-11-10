import axios from "axios";
import { HOSTER_USER_AGENT } from "./hoster-user-agent.js";

const HOSTS = ["buzzheavier.com", "bzzhr.to", "bzzhr.co", "fuckingfast.net"];
const REFERER_GATED_HOSTS = ["buzzheavier.com", "bzzhr.to", "bzzhr.co"];
const DIRECT_DOWNLOAD_HOSTS = ["ts.bzzhr.to", "flashbang.sh"];

const DOWNLOAD_ACTION_PATTERN =
  /hx-(get|post)\s*=\s*(["'])([^"']*\/download(?:[/?#][^"']*)?)\2/i;

// Direct CDN link regex (Python scraper'daki ts.bzzhr.to/d/ yakalama mantığı)
const DIRECT_CDN_REGEX =
  /https?:\/\/(?:ts\.bzzhr\.to|flashbang\.sh|buzzheavier\.com)\/d\/[a-zA-Z0-9_-]+/gi;

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

/** Python scraper'ındaki HTML içi CDN adresi ve şifrelenmiş link arama mantığı */
export function extractDirectCdnFromHtml(html: string): string | undefined {
  const matches = html.match(DIRECT_CDN_REGEX);
  if (matches && matches.length > 0) {
    return matches[0];
  }
  return undefined;
}

export function extractBuzzheavierDownloadToken(
  html: string
): string | undefined {
  const match = /\/download\?t=([^"'&\\#\s<>]+)/i.exec(html);
  return match?.[1];
}

const matchesHost = (hostname: string, hosts: string[]) =>
  hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));

export function isBuzzheavierPageLink(uri: string): boolean {
  try {
    const hostname = new URL(uri).hostname.toLowerCase();
    return (
      matchesHost(hostname, REFERER_GATED_HOSTS) &&
      !matchesHost(hostname, DIRECT_DOWNLOAD_HOSTS)
    );
  } catch {
    return false;
  }
}

export function toCookieHeader(setCookie: unknown): string | undefined {
  const values = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string"
      ? [setCookie]
      : [];
  const pairs = values
    .map((value) => String(value).split(";")[0]?.trim())
    .filter((pair): pair is string => !!pair && pair.includes("="));

  return pairs.length > 0 ? pairs.join("; ") : undefined;
}

export interface BuzzheavierResolveOptions {
  referer?: string;
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

  public static async getDownloadUrl(
    uri: string,
    options: BuzzheavierResolveOptions = {}
  ): Promise<string> {
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

    // 1. ADIM: Sayfa HTML'ini tam tarayıcı başlıklarıyla (Browser Fingerprint) çek
    const pageResponse = await axios.get<string>(uri, {
      headers: {
        "User-Agent": HOSTER_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "cross-site",
        "Upgrade-Insecure-Requests": "1",
        ...(options.referer ? { Referer: options.referer } : {}),
      },
      timeout: 30000,
    });

    const html = pageResponse.data;

    // 2. ADIM (Python Scraper Mantığı): HTML içeriğinde doğrudan ts.bzzhr.to/d/ adresi var mı kontrol et
    const directCdnInHtml = extractDirectCdnFromHtml(html);
    if (directCdnInHtml) {
      return directCdnInHtml;
    }

    const cookieHeader = toCookieHeader(pageResponse.headers?.["set-cookie"]);
    const pageUrl = pageResponse.request?.res?.responseUrl || uri;
    const action = extractBuzzheavierDownloadAction(html, pageUrl);
    const token = extractBuzzheavierDownloadToken(html);
    const fallback = new URL(pageUrl);
    fallback.pathname = `${fallback.pathname.replace(/\/+$/, "")}/download`;
    const endpointUrl = new URL(action?.url ?? fallback.href);
    if (token && !endpointUrl.searchParams.has("t")) {
      endpointUrl.searchParams.set("t", token);
    }
    const endpoint = endpointUrl.href;
    const method = action?.method ?? "get";

    // 3. ADIM: HTMX indirme isteğini tarayıcı taklidi başlıklarıyla gönder
    const downloadResponse = await axios.request<string>({
      url: endpoint,
      method,
      maxRedirects: 0,
      validateStatus: (status) => status < 500,
      headers: {
        "User-Agent": HOSTER_USER_AGENT,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "HX-Request": "true",
        "HX-Target": "body",
        "HX-Current-URL": pageUrl,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        Referer: pageUrl,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      timeout: 30000,
    });

    const directUrl =
      downloadResponse.status < 400
        ? extractBuzzheavierRedirect(downloadResponse.headers, endpoint)
        : undefined;
    if (directUrl) return directUrl;

    // HTML içinde dinamik JS değişkeni veya script bloğundaki CDN adresini ara
    const fallbackCdn = extractDirectCdnFromHtml(downloadResponse.data);
    if (fallbackCdn) return fallbackCdn;

    throw new Error(
      `Buzzheavier did not return a downloadable CDN redirect (HTTP ${downloadResponse.status})`
    );
  }
}