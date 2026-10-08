import assert from "node:assert/strict";
import axios, { AxiosHeaders } from "axios";
import { afterEach, describe, it } from "node:test";
import {
  BuzzheavierApi,
  extractBuzzheavierDownloadAction,
  extractBuzzheavierDownloadToken,
  extractBuzzheavierRedirect,
} from "./buzzheavier.js";

const originalAdapter = axios.defaults.adapter;

afterEach(() => {
  axios.defaults.adapter = originalAdapter;
});

describe("BuzzheavierApi", () => {
  it("recognizes Buzzheavier and short-link hosts", () => {
    assert.equal(BuzzheavierApi.canHandle("https://buzzheavier.com/abc"), true);
    assert.equal(BuzzheavierApi.canHandle("https://bzzhr.to/abc"), true);
    assert.equal(BuzzheavierApi.canHandle("https://bzzhr.co/abc"), true);
    assert.equal(BuzzheavierApi.canHandle("https://fuckingfast.net/abc"), true);
    assert.equal(
      BuzzheavierApi.canHandle("https://flashbang.sh/file.zip"),
      true
    );
    assert.equal(
      BuzzheavierApi.canHandle("https://buzzheavier.com.example.org/abc"),
      false
    );
  });

  it("extracts an HTMX download action and its method", () => {
    assert.deepEqual(
      extractBuzzheavierDownloadAction(
        '<button hx-post="/abc/download">Download</button>',
        "https://buzzheavier.com/abc"
      ),
      { method: "post", url: "https://buzzheavier.com/abc/download" }
    );
  });

  it("accepts hx-redirect CDN URLs and rejects non-download targets", () => {
    assert.equal(
      extractBuzzheavierRedirect(
        { "hx-redirect": "https://ts.bzzhr.to/d/abc/game.zip" },
        "https://buzzheavier.com/abc/download"
      ),
      "https://ts.bzzhr.to/d/abc/game.zip"
    );
    assert.equal(
      extractBuzzheavierRedirect(
        { "hx-redirect": "javascript:alert(1)" },
        "https://buzzheavier.com/abc/download"
      ),
      undefined
    );
    assert.equal(
      extractBuzzheavierRedirect(
        { "hx-redirect": "https://flashbang.sh/downloads/signed-file" },
        "https://buzzheavier.com/abc/download"
      ),
      "https://flashbang.sh/downloads/signed-file"
    );
  });

  it("extracts the current query token from the download page", () => {
    assert.equal(
      extractBuzzheavierDownloadToken(
        '<a href="/abc/download?t=short-lived-token">Download</a>'
      ),
      "short-lived-token"
    );
  });

  it("uses the page token and accepts the current CDN redirect on mirrors", async () => {
    let resolvedDownloadEndpoint = "";
    axios.defaults.adapter = async (config) => {
      if (new URL(config.url ?? "").pathname === "/abc") {
        return {
          data: '<a href="/abc/download?t=short-lived-token">Download</a>',
          status: 200,
          statusText: "OK",
          headers: new AxiosHeaders(),
          config,
        };
      }

      resolvedDownloadEndpoint = config.url ?? "";
      return {
        data: "",
        status: 200,
        statusText: "OK",
        headers: new AxiosHeaders({
          "hx-redirect": "https://flashbang.sh/downloads/signed-file",
        }),
        config,
      };
    };

    assert.equal(
      await BuzzheavierApi.getDownloadUrl("https://bzzhr.co/abc"),
      "https://flashbang.sh/downloads/signed-file"
    );
    assert.equal(
      new URL(resolvedDownloadEndpoint).searchParams.get("t"),
      "short-lived-token"
    );
  });
});
