import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BuzzheavierApi,
  extractBuzzheavierDownloadAction,
  extractBuzzheavierRedirect,
} from "./buzzheavier.js";

describe("BuzzheavierApi", () => {
  it("recognizes Buzzheavier and short-link hosts", () => {
    assert.equal(BuzzheavierApi.canHandle("https://buzzheavier.com/abc"), true);
    assert.equal(BuzzheavierApi.canHandle("https://bzzhr.to/abc"), true);
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
  });
});
