import assert from "node:assert/strict";
import axios, { AxiosHeaders } from "axios";
import { afterEach, describe, it } from "node:test";
import {
  BuzzheavierApi,
  extractBuzzheavierDownloadAction,
  extractBuzzheavierDownloadToken,
  extractBuzzheavierRedirect,
  isBuzzheavierPageLink,
  toCookieHeader,
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
  it("only treats permanent page links as Referer-gated", () => {
    assert.equal(isBuzzheavierPageLink("https://bzzhr.to/t5w7osooelhn"), true);
    assert.equal(isBuzzheavierPageLink("https://buzzheavier.com/abc"), true);
    assert.equal(
      isBuzzheavierPageLink("https://ts.bzzhr.to/d/abc/game.rar?v=1"),
      false
    );
    assert.equal(isBuzzheavierPageLink("https://flashbang.sh/x"), false);
    assert.equal(isBuzzheavierPageLink("https://gofile.io/d/abc"), false);
  });

  it("builds a Cookie header from Set-Cookie values", () => {
    assert.equal(
      toCookieHeader(["a=1; Path=/; HttpOnly", "b=2; Secure"]),
      "a=1; b=2"
    );
    assert.equal(toCookieHeader(undefined), undefined);
  });

  it("sends the SteamRIP Referer and page cookies while resolving", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    axios.defaults.adapter = async (config) => {
      const pathname = new URL(config.url ?? "").pathname;
      seen[pathname] = { ...(config.headers as Record<string, unknown>) };

      if (pathname === "/t5w7osooelhn") {
        return {
          data: '<button hx-get="/t5w7osooelhn/download?t=tok">Download</button>',
          status: 200,
          statusText: "OK",
          headers: new AxiosHeaders({ "set-cookie": ["sid=abc; Path=/"] }),
          config,
        };
      }

      return {
        data: "",
        status: 204,
        statusText: "No Content",
        headers: new AxiosHeaders({
          "hx-redirect": "https://ts.bzzhr.to/d/abc/game.rar?v=1",
        }),
        config,
      };
    };

    assert.equal(
      await BuzzheavierApi.getDownloadUrl("https://bzzhr.to/t5w7osooelhn", {
        referer: "https://steamrip.com/god-of-war-free-download/",
      }),
      "https://ts.bzzhr.to/d/abc/game.rar?v=1"
    );
    assert.equal(
      seen["/t5w7osooelhn"].Referer,
      "https://steamrip.com/god-of-war-free-download/"
    );
    assert.equal(seen["/t5w7osooelhn/download"].Cookie, "sid=abc");
  });
});
