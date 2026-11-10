import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_PARALLEL_CONNECTIONS,
  ParallelRangeHttpStatusError,
  ParallelRangeUnsupportedError,
  reduceParallelConnections,
} from "./parallel-range-download.js";

describe("reduceParallelConnections", () => {
  it("allows enough connections for per-connection throttled hosters", () => {
    assert.ok(MAX_PARALLEL_CONNECTIONS >= 32);
  });

  it("halves connections on rate limits down to two", () => {
    const tooMany = new ParallelRangeHttpStatusError(429, null);
    assert.equal(reduceParallelConnections(32, tooMany), 16);
    assert.equal(reduceParallelConnections(3, tooMany), 2);
    assert.equal(reduceParallelConnections(2, tooMany), 2);
    assert.equal(
      reduceParallelConnections(
        16,
        new ParallelRangeHttpStatusError(503, null)
      ),
      8
    );
  });

  it("keeps at least four connections after other transient failures", () => {
    const reset = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    assert.equal(reduceParallelConnections(32, reset), 16);
    assert.equal(reduceParallelConnections(6, reset), 4);
    assert.equal(reduceParallelConnections(4, reset), 4);
  });

  it("stops using ranges only when the server does not honour them", () => {
    assert.equal(
      reduceParallelConnections(
        32,
        new ParallelRangeUnsupportedError("ranges not honoured")
      ),
      null
    );
  });
});
