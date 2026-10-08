import axios, { type AxiosRequestConfig } from "axios";

const ARCHIVE_EXTENSION = /\.(?:rar|zip|7z)(?:$|[?#])/i;
const MEGADB_REFERER = "https://steamrip.com/";
const MEGADB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const MEGADB_HOSTS = ["megadb.net", "megadb.xyz"];

function decodeHtml(value: string): string {
  return value
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&#0*38;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'");
}

function isMegaDBHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return MEGADB_HOSTS.some(
    (host) => normalized === host || normalized.endsWith(`.${host}`)
  );
}

function isHttpUrl(value: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(decodeHtml(value), baseUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function isMegaDBDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!isMegaDBHost(url.hostname)) return true;
    if (ARCHIVE_EXTENSION.test(url.pathname)) return true;

    return (
      /^\/download(?:\/|$)/i.test(url.pathname) &&
      ["download_token", "token", "file_id", "fileId", "file", "id"].some(
        (parameter) => url.searchParams.has(parameter)
      )
    );
  } catch {
    return false;
  }
}

function getMegaDBDirectArchiveUrl(uri: string): string | null {
  try {
    const directUrl = new URL(uri.trim());
    return isMegaDBHost(directUrl.hostname) &&
      ARCHIVE_EXTENSION.test(directUrl.pathname)
      ? directUrl.href
      : null;
  } catch {
    return null;
  }
}

function getMegaDBRequestHeaders(
  referer: string,
  accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
): Record<string, string> {
  return {
    Accept: accept,
    "Accept-Language": "en-US,en;q=0.9",
    Referer: referer,
    "User-Agent": MEGADB_USER_AGENT,
  };
}

function extractMegaDBFormSubmission(
  html: string,
  baseUrl: string
):
  | { action: string; method: "get" | "post"; fields: Record<string, string> }
  | undefined {
  const formPattern = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;

  for (const match of html.matchAll(formPattern)) {
    const formHtml = match[0];
    const actionMatch = formHtml.match(
      /\b(?:action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
    );
    if (!actionMatch) continue;

    const actionValue = actionMatch[1] ?? actionMatch[2] ?? actionMatch[3];
    const methodMatch = formHtml.match(
      /\bmethod\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
    );
    const method = (
      methodMatch?.[1] ??
      methodMatch?.[2] ??
      methodMatch?.[3] ??
      "get"
    ).toLowerCase();

    if (!/^(get|post)$/i.test(method)) continue;

    const fields: Record<string, string> = {};
    for (const inputMatch of formHtml.matchAll(
      /<input\b[^>]*name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*value\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi
    )) {
      const name = inputMatch[1] ?? inputMatch[2] ?? inputMatch[3];
      const value = inputMatch[4] ?? inputMatch[5] ?? inputMatch[6];
      if (!name || !value) continue;
      fields[name] = decodeHtml(value);
    }

    for (const inputMatch of formHtml.matchAll(
      /<input\b[^>]*name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi
    )) {
      const name = inputMatch[1] ?? inputMatch[2] ?? inputMatch[3];
      const valueMatch = inputMatch[0].match(
        /\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
      );
      if (!name || valueMatch) continue;
      const value = valueMatch?.[1] ?? valueMatch?.[2] ?? valueMatch?.[3] ?? "";
      fields[name] = decodeHtml(value);
    }

    const action =
      isHttpUrl(actionValue, baseUrl) ?? new URL(actionValue, baseUrl).href;
    if (!action) continue;

    return {
      action,
      method: method.toLowerCase() as "get" | "post",
      fields,
    };
  }

  return undefined;
}

export function extractMegaDBDownloadUrl(
  html: string,
  baseUrl: string
): string {
  const candidates: string[] = [];
  const htmlWithDecodedSlashes = decodeHtml(html);
  const hrefPattern =
    /(?:href|data-url|data-download-url|action|formaction)\s*=\s*(["'])(.*?)\1/gi;

  for (const match of htmlWithDecodedSlashes.matchAll(hrefPattern)) {
    candidates.push(match[2]);
  }

  const absoluteUrlPattern = /https?:\/\/[^\s"'<>\\]+/gi;
  for (const match of htmlWithDecodedSlashes.matchAll(absoluteUrlPattern)) {
    candidates.push(match[0]);
  }

  const jsRedirectPattern =
    /(?:window\s*\.location|location\s*\.)\s*(?:href|assign|replace)\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s;]+))/gi;
  for (const match of htmlWithDecodedSlashes.matchAll(jsRedirectPattern)) {
    candidates.push(match[1] ?? match[2] ?? match[3] ?? "");
  }

  const urls = candidates
    .map((candidate) => isHttpUrl(candidate, baseUrl))
    .filter((candidate): candidate is string => candidate !== undefined);

  const tokenUrl = urls.find((candidate) =>
    /[?&](?:download_token|token|file_id|id)=/i.test(candidate)
  );
  if (tokenUrl) return tokenUrl;

  const archiveUrl = urls.find((candidate) =>
    ARCHIVE_EXTENSION.test(candidate)
  );
  if (archiveUrl) return archiveUrl;

  const form = extractMegaDBFormSubmission(htmlWithDecodedSlashes, baseUrl);
  if (form) {
    return form.action;
  }

  throw new Error("MegaDB download link was not found on the page");
}

export function getMegaDBPageUrl(uri: string): string {
  let pageUrl: URL;
  try {
    pageUrl = new URL(uri.trim());
  } catch {
    throw new Error("Invalid MegaDB URL; expected a MegaDB file page URL.");
  }

  const hostname = pageUrl.hostname.toLowerCase();
  if (!isMegaDBHost(hostname)) {
    throw new Error(`Unsupported MegaDB URL: ${uri}`);
  }

  const segments = pageUrl.pathname.split("/").filter(Boolean);
  const route = segments[0]?.toLowerCase();
  if (route === "download") {
    const fileId =
      segments[1] ||
      pageUrl.searchParams.get("file_id") ||
      pageUrl.searchParams.get("fileId") ||
      pageUrl.searchParams.get("file") ||
      pageUrl.searchParams.get("id") ||
      pageUrl.searchParams.get("slug");

    if (!fileId) {
      throw new Error(
        "MegaDB download URL does not identify its file page. Open the original /file/<id> link."
      );
    }

    pageUrl.pathname = `/file/${encodeURIComponent(fileId)}`;
  } else if (route !== "file" || segments.length < 2) {
    throw new Error(
      "MegaDB URL is not a file page. Expected a URL in the form https://megadb.net/file/<id>."
    );
  }

  pageUrl.protocol = "https:";
  pageUrl.hostname = "megadb.net";
  pageUrl.port = "";
  pageUrl.search = "";
  pageUrl.hash = "";
  return pageUrl.href;
}

export class MegaDBApi {
  public static canHandle(uri: string): boolean {
    try {
      const { hostname } = new URL(uri);
      return isMegaDBHost(hostname);
    } catch {
      return false;
    }
  }

  private static async requestPage(url: string): Promise<string> {
    const response = await axios.get<string>(url, {
      headers: getMegaDBRequestHeaders(MEGADB_REFERER),
      timeout: 30000,
      validateStatus: (status) => status >= 200 && status < 500,
    });

    const body = response.data ?? "";
    const lowerBody = body.toLowerCase();
    if (
      response.status === 403 ||
      lowerBody.includes("referrer not allowed") ||
      lowerBody.includes("the domain does not have approval")
    ) {
      throw new Error(
        "MegaDB rejected the request because the required Referer header was missing or invalid. Use Referer: https://steamrip.com/."
      );
    }

    if (
      response.status === 404 ||
      lowerBody.includes("not found") ||
      lowerBody.includes("file was deleted") ||
      lowerBody.includes("invalid file") ||
      lowerBody.includes("expired")
    ) {
      throw new Error(`MegaDB file page was not found or is invalid: ${url}`);
    }

    return body;
  }

  private static async resolveFormAction(
    html: string,
    pageUrl: string
  ): Promise<string | null> {
    const submission = extractMegaDBFormSubmission(html, pageUrl);
    if (!submission) return null;

    try {
      const formResponse = await axios.request<string>({
        url: submission.action,
        method: submission.method.toUpperCase() as AxiosRequestConfig["method"],
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 500,
        headers: {
          ...getMegaDBRequestHeaders(pageUrl),
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Origin: "https://megadb.net",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        data:
          submission.method === "post"
            ? new URLSearchParams(submission.fields).toString()
            : undefined,
        timeout: 30000,
      });

      const location = formResponse.headers.location;
      if (typeof location === "string") {
        const redirectUrl = isHttpUrl(location, submission.action);
        if (redirectUrl && isMegaDBDownloadUrl(redirectUrl)) {
          return redirectUrl;
        }
      }

      const directUrl = extractMegaDBDownloadUrl(
        formResponse.data,
        formResponse.request?.res?.responseUrl || submission.action
      );
      if (directUrl) return directUrl;
    } catch (error) {
      if (
        axios.isAxiosError(error) &&
        (error.response?.status === 404 || error.response?.status === 410)
      ) {
        throw new Error(
          `MegaDB file was removed or is unavailable: ${pageUrl}`
        );
      }
      if (
        error instanceof Error &&
        error.message.includes("Referrer not allowed")
      ) {
        throw error;
      }
    }

    return null;
  }

  public static async getDownloadUrl(uri: string): Promise<string> {
    const directArchiveUrl = getMegaDBDirectArchiveUrl(uri);
    if (directArchiveUrl) return directArchiveUrl;

    let pageUrl: string;
    try {
      pageUrl = getMegaDBPageUrl(uri);
    } catch (error) {
      throw new Error(
        `Failed to resolve MegaDB download page: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }

    try {
      const pageHtml = await this.requestPage(pageUrl);
      const directUrl = extractMegaDBDownloadUrl(pageHtml, pageUrl);

      if (isMegaDBDownloadUrl(directUrl)) {
        return directUrl;
      }

      const formResult = await this.resolveFormAction(pageHtml, pageUrl);
      if (formResult) return formResult;

      throw new Error(
        `MegaDB file page did not contain a fresh download token or direct archive link: ${pageUrl}`
      );
    } catch (error) {
      if (error instanceof Error) {
        const message = error.message;
        if (
          message.includes("Referrer not allowed") ||
          message.includes("required Referer")
        ) {
          throw error;
        }
        if (
          message.includes("was not found") ||
          message.includes("removed or is unavailable")
        ) {
          throw error;
        }
      }

      throw new Error(
        `Failed to fetch or resolve the MegaDB file page ${pageUrl}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
}
