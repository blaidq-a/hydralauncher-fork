import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSteamRipPageIndex,
  extractSteamRipPageUrl,
  normalizeHosterUri,
} from "./steamrip-referer-core.js";

describe("SteamRIP referer lookup", () => {
  it("normalizes hoster links", () => {
    assert.equal(
      normalizeHosterUri("https://www.BZZHR.to/t5w7osooelhn/"),
      "bzzhr.to/t5w7osooelhn"
    );
  });

  it("extracts the SteamRIP game page from descriptionHtml", () => {
    assert.equal(
      extractSteamRipPageUrl(
        '<p>Source: <a href="https://steamrip.com/god-of-war-free-download/">SteamRIP</a></p>'
      ),
      "https://steamrip.com/god-of-war-free-download/"
    );
    assert.equal(
      extractSteamRipPageUrl('<a href="https://example.com/x">x</a>'),
      null
    );
    assert.equal(extractSteamRipPageUrl(undefined), null);
  });

  it("indexes every uri of an entry to its game page", () => {
    const index = buildSteamRipPageIndex({
      downloads: [
        {
          uris: ["https://bzzhr.to/t5w7osooelhn", "https://gofile.io/d/abc"],
          descriptionHtml:
            "<a href='https://steamrip.com/god-of-war-free-download/'>page</a>",
        },
        { uris: ["https://bzzhr.to/nopage"], descriptionHtml: "<p>none</p>" },
      ],
    });

    assert.equal(
      index.get("bzzhr.to/t5w7osooelhn"),
      "https://steamrip.com/god-of-war-free-download/"
    );
    assert.equal(index.has("bzzhr.to/nopage"), false);
  });
});
