import axios from "axios";
import { HOSTER_USER_AGENT } from "./hoster-user-agent.js";

const ARCHIVE_EXTENSION = /\.(?:rar|zip|7z)(?:$|[?#])/i;

function decodeHtml(value: string): string {
  return value
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .replace(/&#0*38;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'");
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

export function extractMegaDBDownloadUrl(
  html: string,
  baseUrl: string
): string {
  const candidates: string[] = [];
  const htmlWithDecodedSlashes = decodeHtml(html);
  const hrefPattern =
    /(?:href|data-url|data-download-url)\s*=\s*(["'])(.*?)\1/gi;

  for (const match of htmlWithDecodedSlashes.matchAll(hrefPattern)) {
    candidates.push(match[2]);
  }

  const absoluteUrlPattern = /https?:\/\/[^\s"'<>\\]+/gi;
  for (const match of htmlWithDecodedSlashes.matchAll(absoluteUrlPattern)) {
    candidates.push(match[0]);
  }

  const urls = candidates
    .map((candidate) => isHttpUrl(candidate, baseUrl))
    .filter((candidate): candidate is string => candidate !== undefined);

  const tokenUrl = urls.find((candidate) =>
    /[?&]download_token=/i.test(candidate)
  );
  if (tokenUrl) return tokenUrl;

  const archiveUrl = urls.find((candidate) =>
    ARCHIVE_EXTENSION.test(candidate)
  );
  if (archiveUrl) return archiveUrl;

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
  if (hostname !== "megadb.net" && !hostname.endsWith(".megadb.net")) {
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
      return hostname === "megadb.net" || hostname.endsWith(".megadb.net");
    } catch {
      return false;
    }
  }

  public static async getDownloadUrl(uri: string): Promise<string> {
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
      const response = await axios.get<string>(pageUrl, {
        headers: {
          "User-Agent": HOSTER_USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
        timeout: 30000,
      });

      return extractMegaDBDownloadUrl(
        response.data,
        response.request?.res?.responseUrl || pageUrl
      );
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw new Error(`MegaDB file page was not found (404): ${pageUrl}`, {
          cause: error,
        });
      }

      if (
        error instanceof Error &&
        error.message === "MegaDB download link was not found on the page"
      ) {
        throw new Error(
          `MegaDB file page did not contain a fresh download token or direct archive link: ${pageUrl}`,
          { cause: error }
        );
      }

      throw new Error(
        `Failed to fetch or resolve the MegaDB file page ${pageUrl}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
}
