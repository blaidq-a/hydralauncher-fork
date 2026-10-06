import { Downloader } from "./constants.js";

function hasHost(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function getHosterDownloader(uri: string): Downloader | undefined {
  let hostname: string | undefined;
  try {
    hostname = new URL(uri.trim()).hostname.toLowerCase();
  } catch {
    return undefined;
  }

  if (hasHost(hostname, "megadb.net")) return Downloader.MegaDB;
  if (hasHost(hostname, "buzzheavier.com") || hasHost(hostname, "bzzhr.to"))
    return Downloader.Buzzheavier;
  if (hasHost(hostname, "gofile.io")) return Downloader.Gofile;
  if (hasHost(hostname, "pixeldrain.com")) return Downloader.PixelDrain;
  if (hasHost(hostname, "datanodes.to")) return Downloader.Datanodes;
  if (hostname === "www.mediafire.com") return Downloader.Mediafire;
  if (hasHost(hostname, "fuckingfast.co")) return Downloader.FuckingFast;
  if (
    hasHost(hostname, "vikingfile.com") ||
    hasHost(hostname, "vik1ngfile.site")
  ) {
    return Downloader.VikingFile;
  }
  if (hostname === "www.rootz.so") return Downloader.Rootz;
  if (hasHost(hostname, "1fichier.com") || hasHost(hostname, "mediafire.com"))
    return Downloader.RealDebrid;

  return undefined;
}
