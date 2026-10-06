import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDownloadByteRanges,
  MAX_SEGMENTED_DOWNLOAD_CONNECTIONS,
  SEGMENTED_DOWNLOAD_CONNECTIONS,
} from "./js-http-downloader-helpers.ts";

describe("createDownloadByteRanges", () => {
  it("uses eight connections for segmented downloads", () => {
    assert.equal(SEGMENTED_DOWNLOAD_CONNECTIONS, 8);
    assert.equal(MAX_SEGMENTED_DOWNLOAD_CONNECTIONS, 12);
  });

  it("supports a maximum of twelve byte ranges", () => {
    assert.equal(
      createDownloadByteRanges(12_000, MAX_SEGMENTED_DOWNLOAD_CONNECTIONS)
        .length,
      MAX_SEGMENTED_DOWNLOAD_CONNECTIONS
    );
  });

  it("creates contiguous non-overlapping ranges that cover the whole file", () => {
    const fileSize = 10_000_003;
    const ranges = createDownloadByteRanges(
      fileSize,
      SEGMENTED_DOWNLOAD_CONNECTIONS
    );

    assert.equal(ranges.length, SEGMENTED_DOWNLOAD_CONNECTIONS);
    assert.equal(ranges[0].start, 0);
    assert.equal(ranges.at(-1)?.end, fileSize - 1);

    for (let index = 1; index < ranges.length; index++) {
      assert.equal(ranges[index].start, ranges[index - 1].end + 1);
    }

    assert.equal(
      ranges.reduce((total, range) => total + range.end - range.start + 1, 0),
      fileSize
    );
  });

  it("handles files smaller than the requested connection count", () => {
    assert.deepEqual(createDownloadByteRanges(3, 8), [
      { start: 0, end: 0 },
      { start: 1, end: 1 },
      { start: 2, end: 2 },
    ]);
  });

  it("rejects invalid sizes and connection counts", () => {
    assert.deepEqual(createDownloadByteRanges(0), []);
    assert.deepEqual(createDownloadByteRanges(-1), []);
    assert.deepEqual(createDownloadByteRanges(Number.POSITIVE_INFINITY), []);
    assert.deepEqual(createDownloadByteRanges(100, 0), []);
  });
});
