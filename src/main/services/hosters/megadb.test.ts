import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractMegaDBDownloadUrl,
  getMegaDBPageUrl,
  MegaDBApi,
} from "./megadb.js";

describe("MegaDBApi", () => {
  it("recognizes MegaDB hosts but not lookalike domains", () => {
    assert.equal(MegaDBApi.canHandle("https://megadb.net/file/abc"), true);
    assert.equal(MegaDBApi.canHandle("https://www.megadb.net/file/abc"), true);
    assert.equal(
      MegaDBApi.canHandle("https://megadb.net.example.org/x"),
      false
    );
  });

  it("prefers an anchor containing a download token", () => {
    assert.equal(
      extractMegaDBDownloadUrl(
        '<a href="/download?download_token=secret">Download</a>',
        "https://megadb.net/file/abc"
      ),
      "https://megadb.net/download?download_token=secret"
    );
  });

  it("finds direct archive CDN links in the page", () => {
    assert.equal(
      extractMegaDBDownloadUrl(
        '<a href="https://cdn.megadb.net/files/game.7z?sig=1">Download</a>',
        "https://megadb.net/file/abc"
      ),
      "https://cdn.megadb.net/files/game.7z?sig=1"
    );
  });

  it("normalizes file links by removing stale token parameters", () => {
    assert.equal(
      getMegaDBPageUrl(
        "http://www.megadb.net/file/abc?download_token=expired&other=1#download"
      ),
      "https://megadb.net/file/abc"
    );
  });

  it("converts a download endpoint with a file id to its file page", () => {
    assert.equal(
      getMegaDBPageUrl(
        "https://megadb.net/download?file_id=abc&download_token=expired"
      ),
      "https://megadb.net/file/abc"
    );
  });

  it("rejects download tokens without a file page identifier", () => {
    assert.throws(
      () => getMegaDBPageUrl("https://megadb.net/download?download_token=x"),
      /does not identify its file page/
    );
  });
});
