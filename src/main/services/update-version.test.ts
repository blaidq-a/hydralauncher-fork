import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compareVersions } from "./update-version.js";

describe("compareVersions", () => {
  it("orders versions numerically, not alphabetically", () => {
    assert.equal(compareVersions("4.10.0", "4.9.9"), 1);
    assert.equal(compareVersions("4.4.0", "4.1.6"), 1);
    assert.equal(compareVersions("4.1.6", "4.4.0"), -1);
  });

  it("treats tags with a v prefix and equal versions as equal", () => {
    assert.equal(compareVersions("v4.4.0", "4.4.0"), 0);
  });

  it("ignores pre-release suffixes beyond the patch number", () => {
    assert.equal(compareVersions("4.4.1-fork.2", "4.4.0"), 1);
    assert.equal(compareVersions("4.4.0-beta", "4.4.0"), 0);
  });
});
