import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_HYDRA_API_URL,
  resolveHydraApiBaseUrl,
} from "./hydra-api-url.js";

describe("resolveHydraApiBaseUrl", () => {
  it("uses the official Hydra API when the environment value is absent", () => {
    assert.equal(resolveHydraApiBaseUrl(), DEFAULT_HYDRA_API_URL);
    assert.equal(resolveHydraApiBaseUrl("  "), DEFAULT_HYDRA_API_URL);
  });

  it("uses a valid configured HTTP API URL without trailing slashes", () => {
    assert.equal(
      resolveHydraApiBaseUrl("https://api.example.test/base/"),
      "https://api.example.test/base"
    );
  });

  it("falls back to the official API for malformed or unsupported URLs", () => {
    assert.equal(resolveHydraApiBaseUrl("not a URL"), DEFAULT_HYDRA_API_URL);
    assert.equal(
      resolveHydraApiBaseUrl("file:///etc/passwd"),
      DEFAULT_HYDRA_API_URL
    );
  });
});
