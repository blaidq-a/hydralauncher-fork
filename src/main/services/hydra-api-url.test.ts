import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_HYDRA_API_URL,
  DEFAULT_HYDRA_AUTH_URL,
  DEFAULT_HYDRA_CHECKOUT_URL,
  resolveHydraApiBaseUrl,
  resolveHydraAuthUrl,
  resolveHydraCheckoutUrl,
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

describe("resolveHydraAuthUrl", () => {
  it("uses the official Hydra Auth when the environment value is absent", () => {
    assert.equal(resolveHydraAuthUrl(), DEFAULT_HYDRA_AUTH_URL);
    assert.equal(resolveHydraAuthUrl("  "), DEFAULT_HYDRA_AUTH_URL);
  });

  it("uses a valid configured Auth URL without trailing slashes", () => {
    assert.equal(
      resolveHydraAuthUrl("https://auth.example.test/"),
      "https://auth.example.test"
    );
  });

  it("falls back to the official Auth URL for malformed or unsupported URLs", () => {
    assert.equal(resolveHydraAuthUrl("not a URL"), DEFAULT_HYDRA_AUTH_URL);
  });
});

describe("resolveHydraCheckoutUrl", () => {
  it("uses the official Hydra Checkout when the environment value is absent", () => {
    assert.equal(resolveHydraCheckoutUrl(), DEFAULT_HYDRA_CHECKOUT_URL);
    assert.equal(resolveHydraCheckoutUrl("  "), DEFAULT_HYDRA_CHECKOUT_URL);
  });

  it("uses a valid configured Checkout URL without trailing slashes", () => {
    assert.equal(
      resolveHydraCheckoutUrl("https://checkout.example.test/"),
      "https://checkout.example.test"
    );
  });
});

