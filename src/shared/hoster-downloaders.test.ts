import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getHosterDownloader } from "./hoster-routing.js";
import { Downloader } from "./constants.js";

describe("getDownloadersForUri hoster routing", () => {
  it("routes MegaDB and Qiwi links through the supported filters", () => {
    assert.deepEqual(
      getHosterDownloader("https://www.megadb.net/file/abc"),
      Downloader.MegaDB
    );
    assert.deepEqual(
      getHosterDownloader("https://megadb.xyz/file/abc"),
      Downloader.MegaDB
    );
    assert.deepEqual(
      getHosterDownloader("https://cdn.megadb.net/files/game.zip?sig=1"),
      Downloader.MegaDB
    );
    assert.deepEqual(
      getHosterDownloader("https://qiwi.gg/abc"),
      Downloader.Hydra
    );
  });

  it("routes Buzzheavier and bzzhr.to links to Buzzheavier", () => {
    assert.deepEqual(
      getHosterDownloader("https://buzzheavier.com/abc"),
      Downloader.Buzzheavier
    );
    assert.deepEqual(
      getHosterDownloader("https://bzzhr.to/abc"),
      Downloader.Buzzheavier
    );
    assert.equal(
      getHosterDownloader("https://bzzhr.co/abc"),
      Downloader.Buzzheavier
    );
    assert.equal(
      getHosterDownloader("https://fuckingfast.net/abc"),
      Downloader.Buzzheavier
    );
    assert.equal(
      getHosterDownloader("https://flashbang.sh/downloads/signed-file"),
      Downloader.Buzzheavier
    );
  });

  it("continues recognizing existing hosters across source URL variants", () => {
    const cases: [string, Downloader][] = [
      ["http://www.gofile.io/d/abc", Downloader.Gofile],
      ["https://www.pixeldrain.com/u/abc", Downloader.PixelDrain],
      ["http://datanodes.to/file/abc", Downloader.Datanodes],
      ["https://www.mediafire.com/file/abc", Downloader.Mediafire],
      ["https://sub.fuckingfast.co/file/abc", Downloader.FuckingFast],
      ["http://www.vikingfile.com/d/abc", Downloader.VikingFile],
      ["https://www.rootz.so/d/abc", Downloader.Rootz],
      ["https://1fichier.com/?abc", Downloader.RealDebrid],
      ["https://mediafire.com/file/abc", Downloader.RealDebrid],
    ];

    for (const [uri, expected] of cases) {
      assert.equal(getHosterDownloader(uri), expected, uri);
    }
  });

  it("does not match lookalike hostnames", () => {
    assert.equal(
      getHosterDownloader("https://gofile.io.example.org/d/abc"),
      undefined
    );
  });
});
