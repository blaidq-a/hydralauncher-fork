import { BrowserWindow } from "electron";

const MEGADB_REFERER = "https://steamrip.com/";
const MEGADB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const MEGADB_HOSTS = ["megadb.net", "megadb.xyz", "steamrip.com"];

const TIMEOUT_MS = 60000; // toplam bekleme süresi
const TICK_MS = 700; // sayfa kaç ms'de bir taranır
const CLICK_GAP_MS = 1500; // aynı butona tekrar basmadan önceki bekleme
const FREE_CLICK_GAP_MS = 4000; // "Free Download" sonrası sayfa geçişi beklemesi
const DIAG_AFTER_MS = 10000; // tıklanacak buton bulunamazsa loglama süresi

function isMegaDBHost(hostname: string): boolean {
  return MEGADB_HOSTS.some(
    (host) => hostname.toLowerCase() === host || hostname.toLowerCase().endsWith(`.${host}`)
  );
}

function isTorrentLink(url?: string): boolean {
  if (!url) return false;
  const l = url.toLowerCase();
  if (l.includes(".css") || l.includes(".js") || l.includes(".png") || l.includes(".jpg") || l.includes(".woff")) return false;
  return /\.torrent(?:[?#]|\$)/i.test(l) || l.includes(".torrent");
}

function isDirectDownloadLink(url?: string): boolean {
  if (!url) return false;
  if (isTorrentLink(url)) return false; // Torrent linkleri doğrudan indirme sayılmasın

  const l = url.toLowerCase();

  if (l.includes(".css") || l.includes(".js") || l.includes(".png") || l.includes(".jpg") || l.includes(".woff")) return false;
  if (l.includes("steamrip.com") && !l.includes("download_token")) return false;

  if (l.includes("download_token=")) return true;
  if (/\.(rar|zip|7z|bin|iso|exe|tar|gz)(?:[?#]|\$)/i.test(l)) return true;
  if (/https?:\/\/(?:fs|cdn)\d*\.megadb\.(?:xyz|net)/i.test(l)) return true;

  return false;
}

export function getMegaDBPageUrl(uri: string): string {
  let cleanUri = (uri || "").trim();
  if (cleanUri.includes("steamrip.com/http")) cleanUri = cleanUri.split("steamrip.com/").pop() || cleanUri;

  try {
    const pageUrl = new URL(cleanUri);
    if (pageUrl.hostname.includes("steamrip.com")) return pageUrl.href;
    pageUrl.protocol = "https:";
    pageUrl.hostname = "megadb.net";
    return pageUrl.href;
  } catch {
    throw new Error("Invalid MegaDB URL.");
  }
}

type ProbeTarget = {
  kind: "download" | "free";
  x: number;
  y: number;
  text: string;
  covered: boolean;
};
type ProbeResult = { links: string[]; target: ProbeTarget | null };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const stripHash = (u: string) => u.split("#")[0];

const PROBE_SCRIPT = String.raw`(() => {
  try {
    if (!document.body || document.readyState === "loading") return null;

    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const textOf = (el) => norm(el.innerText || el.value || el.textContent);
    const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
    const short = (el, max) => { const t = textOf(el); return t.length > 0 && t.length <= max; };

    const shown = (el) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return false;
      if (typeof el.checkVisibility === "function") {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      } else {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
      }
      return getComputedStyle(el).pointerEvents !== "none";
    };

    const enabled = (el) =>
      !el.disabled && el.getAttribute("aria-disabled") !== "true" && !el.classList.contains("disabled");

    const pick = (list) => {
      const all = Array.from(new Set(list));
      const leaf = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
      const ok = leaf.filter((el) => shown(el) && enabled(el)).sort((a, b) => area(b) - area(a));
      return ok[0] || null;
    };

    const describe = (kind, el) => {
      let r = el.getBoundingClientRect();
      if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) {
        el.scrollIntoView({ block: "center", inline: "center" });
        r = el.getBoundingClientRect();
      }
      const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
      const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
      const top = document.elementFromPoint(x, y);
      return { kind: kind, x: x, y: y, text: textOf(el).slice(0, 40), covered: !!top && !el.contains(top) };
    };

    const links = [];
    const exts = [".rar", ".zip", ".7z", ".torrent"];
    const here = location.href.split("#")[0];
    for (const a of document.querySelectorAll("a[href]")) {
      const href = (a.href || "").split("#")[0];
      if (!href || href === here || href.startsWith("javascript:")) continue;
      const path = href.split("?")[0].toLowerCase();
      if (href.includes("download_token=") || exts.some((e) => path.endsWith(e))) {
        links.push(href);
        if (links.length >= 10) break;
      }
    }

    const all = Array.from(document.querySelectorAll(
      'a, button, input[type="submit"], input[type="button"], [role="button"], .btn, div[id*="download"]'
    ));
    const exact = ["download", "download file", "download link", "click here to download", "start download", "direct download"];

    const rules = [
      ["download", () => all.filter((e) => short(e, 40) && textOf(e).includes("download now"))],
      ["free", () => [].concat(
        Array.from(document.querySelectorAll('input[name="method_free"], button[name="method_free"], input[value*="Free"]')),
        all.filter((e) => short(e, 40) && textOf(e).includes("free download"))
      )],
      ["download", () => all.filter((e) => exact.includes(textOf(e)) && !e.closest("nav, header, footer"))],
      ["download", () => Array.from(document.querySelectorAll(
        '#btn_download, #downloadbtn, .download-btn, form[name="F1"] button, form[name="F1"] input[type="submit"]'
      )).filter((e) => !textOf(e).includes("premium"))],
    ];

    for (const rule of rules) {
      const el = pick(rule[1]());
      if (el) return { links: links, target: describe(rule[0], el) };
    }
    return { links: links, target: null };
  } catch (e) {
    return null;
  }
})()`;

const DIAG_SCRIPT = String.raw`(() => {
  const out = [];
  const sel = 'a, button, input[type="submit"], input[type="button"], [role="button"], .btn';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const t = String(el.innerText || el.value || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!t) continue;
    const cs = getComputedStyle(el);
    const flags =
      (el.disabled || el.classList.contains("disabled") || el.getAttribute("aria-disabled") === "true" ? "[disabled]" : "") +
      (cs.pointerEvents === "none" ? "[pointer-events:none]" : "") +
      (cs.visibility === "hidden" || cs.opacity === "0" ? "[hidden]" : "");
    out.push(el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + flags + ' "' + t + '"');
    if (out.length >= 15) break;
  }
  return out;
})()`;

async function realClick(wc: Electron.WebContents, x: number, y: number): Promise<void> {
  const z = wc.getZoomFactor();
  const px = Math.round(x * z);
  const py = Math.round(y * z);

  wc.focus();
  wc.sendInputEvent({ type: "mouseMove", x: px, y: py });
  await sleep(60);
  if (wc.isDestroyed()) return;
  wc.sendInputEvent({ type: "mouseDown", x: px, y: py, button: "left", clickCount: 1 });
  await sleep(70);
  if (wc.isDestroyed()) return;
  wc.sendInputEvent({ type: "mouseUp", x: px, y: py, button: "left", clickCount: 1 });
}

export class MegaDBApi {
  public static canHandle(uri: string): boolean {
    try {
      return isMegaDBHost(new URL(uri).hostname);
    } catch {
      return false;
    }
  }

  public static async getDownloadUrl(uri: string): Promise<string> {
    const rawUri = (uri || "").trim();

    if (isTorrentLink(rawUri)) {
      throw new Error("Bu dosya torrent lütfen başka bi hoster deneyin");
    }
    if (isDirectDownloadLink(rawUri)) return rawUri;

    const pageUrl = getMegaDBPageUrl(rawUri);

    return new Promise<string>((resolve, reject) => {
      const win = new BrowserWindow({
        show: false,
        width: 1024,
        height: 768,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webSecurity: false,
          backgroundThrottling: false,
          partition: "persist:megadb",
        },
      });
      const wc = win.webContents;
      const ses = wc.session;

      let finished = false;
      let busy = false;
      let clicks = 0;
      let loads = 0;
      let lastClickAt = 0;
      let lastClickKind = "";
      let lastSeenTargetAt = Date.now();
      let lastDiagAt = 0;
      let errorLogs = 0;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let tickId: ReturnType<typeof setInterval> | undefined;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (tickId) clearInterval(tickId);
        ses.removeAllListeners("will-download");
        ses.webRequest.onBeforeRequest(null);
        ses.webRequest.onBeforeRedirect(null);
        if (!win.isDestroyed()) win.destroy();
      };
      const succeed = (url: string) => {
        if (finished) return;
        finished = true;
        console.log("[MegaDB] Direkt indirme linki yakalandı.");
        resolve(url);
        setImmediate(cleanup);
      };
      const fail = (err: Error) => {
        if (finished) return;
        finished = true;
        reject(err);
        setImmediate(cleanup);
      };

      wc.setAudioMuted(true);
      wc.setWindowOpenHandler(() => ({ action: "deny" }));
      win.on("closed", () => fail(new Error("MegaDB penceresi kapatıldı.")));
      wc.on("did-finish-load", () => {
        loads++;
        lastClickAt = 0;
        console.log(`[MegaDB] Sayfa yüklendi (#${loads}): ${new URL(wc.getURL() || "about:blank").host}`);
      });

      timeoutId = setTimeout(
        () => fail(new Error(`MegaDB Reddedildi: ${TIMEOUT_MS / 1000} saniye içinde indirme bağlantısı alınamadı.`)),
        TIMEOUT_MS
      );

      // 1. Ağ isteklerini yakala
      ses.webRequest.onBeforeRequest((details, callback) => {
        if (isTorrentLink(details.url)) {
          callback({ cancel: true });
          fail(new Error("Bu dosya torrent lütfen başka bi hoster deneyin"));
          return;
        }
        if (isDirectDownloadLink(details.url)) {
          callback({ cancel: true });
          succeed(details.url);
          return;
        }
        callback({});
      });

      // 2. Yönlendirmeleri yakala
      ses.webRequest.onBeforeRedirect((details) => {
        if (isTorrentLink(details.redirectURL)) {
          fail(new Error("Bu dosya torrent lütfen başka bi hoster deneyin"));
          return;
        }
        if (isDirectDownloadLink(details.redirectURL)) succeed(details.redirectURL);
      });

      // 3. Tarayıcı indirmesini yakala
      ses.on("will-download", (event, item) => {
        event.preventDefault();
        const url = item.getURL();
        if (isTorrentLink(url)) {
          fail(new Error("Bu dosya torrent lütfen başka bi hoster deneyin"));
          return;
        }
        if (isDirectDownloadLink(url)) succeed(url);
      });

      // 4. Bot tık döngüsü
      const tick = async () => {
        if (finished || busy || wc.isDestroyed()) return;
        busy = true;
        try {
          const probe = (await wc.executeJavaScript(PROBE_SCRIPT)) as ProbeResult | null;
          if (finished || !probe) return;

          const here = stripHash(wc.getURL());

          // Torrent linki tespit edilirse direkt torrent uyarısı ver
          const torrentDirect = probe.links.find(
            (l) => stripHash(l) !== here && stripHash(l) !== stripHash(pageUrl) && isTorrentLink(l)
          );
          if (torrentDirect) {
            fail(new Error("Bu dosya torrent lütfen başka bi hoster deneyin"));
            return;
          }

          const direct = probe.links.find(
            (l) => stripHash(l) !== here && stripHash(l) !== stripHash(pageUrl) && isDirectDownloadLink(l)
          );
          if (direct) {
            succeed(direct);
            return;
          }

          const t = probe.target;
          if (!t) {
            const now = Date.now();
            if (now - lastSeenTargetAt > DIAG_AFTER_MS && now - lastDiagAt > DIAG_AFTER_MS) {
              lastDiagAt = now;
              const seen = (await wc.executeJavaScript(DIAG_SCRIPT)) as string[];
              console.log("[MegaDB] Basılacak buton bulunamadı. Sayfadaki butonlar:", seen);
            }
            return;
          }
          lastSeenTargetAt = Date.now();

          const gap = t.kind === "free" ? FREE_CLICK_GAP_MS : CLICK_GAP_MS;
          if (t.kind === lastClickKind && Date.now() - lastClickAt < gap) return;

          lastClickAt = Date.now();
          lastClickKind = t.kind;
          clicks++;
          console.log(
            `[MegaDB] Tık #${clicks} -> ${t.kind} "${t.text}"` + (t.covered ? " (üstü kapalı, reklam katmanı olabilir)" : "")
          );
          await realClick(wc, t.x, t.y);
        } catch (err) {
          if (errorLogs++ < 3) console.warn("[MegaDB] tick hatası:", (err as Error)?.message ?? err);
        } finally {
          busy = false;
        }
      };
      tickId = setInterval(tick, TICK_MS);

      win
        .loadURL(pageUrl, { userAgent: MEGADB_USER_AGENT, httpReferrer: MEGADB_REFERER })
        .catch((err: { code?: string; errno?: number; message?: string }) => {
          if (err?.code === "ERR_ABORTED" || err?.errno === -3) return;
          fail(new Error(`MegaDB sayfası açılamadı: ${err?.message ?? err}`));
        });
    });
  }
}