import assert from "node:assert/strict";
import axios, { AxiosHeaders } from "axios";
import { afterEach, describe, it } from "node:test";
import {
  extractMegaDBDownloadUrl,
  getMegaDBPageUrl,
  MegaDBApi,
} from "./megadb.js";

const originalAdapter = axios.defaults.adapter;

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
});

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

  it("preserves a direct signed archive URL without treating it as a file page", async () => {
    assert.equal(
      await MegaDBApi.getDownloadUrl(
        "https://cdn.megadb.net/files/game.zip?sig=1"
      ),
      "https://cdn.megadb.net/files/game.zip?sig=1"
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

  it("returns a fresh MegaDB token endpoint from the file page", async () => {
    axios.defaults.adapter = async (config) => ({
      data: '<a href="/download?download_token=fresh-token">Download</a>',
      status: 200,
      statusText: "OK",
      headers: new AxiosHeaders(),
      config,
    });

    assert.equal(
      await MegaDBApi.getDownloadUrl("https://megadb.net/file/abc"),
      "https://megadb.net/download?download_token=fresh-token"
    );
  });

  it("uses the download destination from a form redirect", async () => {
    axios.defaults.adapter = async (config) => {
      if (config.url === "https://megadb.net/file/abc") {
        return {
          data: '<form method="post" action="/file/abc/download"><input name="token" value="fresh"></form>',
          status: 200,
          statusText: "OK",
          headers: new AxiosHeaders(),
          config,
        };
      }

      return {
        data: "",
        status: 302,
        statusText: "Found",
        headers: new AxiosHeaders({
          location: "https://cdn.megadb.net/files/game.zip?sig=1",
        }),
        config,
      };
    };

    assert.equal(
      await MegaDBApi.getDownloadUrl("https://megadb.net/file/abc"),
      "https://cdn.megadb.net/files/game.zip?sig=1"
    );
  });
});
