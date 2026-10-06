import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, it } from "node:test";
import {
  areDownloadByteRangesComplete,
  createDownloadByteRanges,
  createPositionalWriteStream,
  MAX_SEGMENTED_DOWNLOAD_CONNECTIONS,
  MAX_SEGMENT_RANGE_BYTES,
  SEGMENTED_DOWNLOAD_CONNECTIONS,
  splitDownloadByteRange,
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

  it("keeps large downloads split into bounded work-stealing ranges", () => {
    const fileSize = 50 * 1024 * 1024 * 1024;
    const workers = MAX_SEGMENTED_DOWNLOAD_CONNECTIONS;
    const rangeCount = Math.max(
      workers,
      Math.ceil(fileSize / MAX_SEGMENT_RANGE_BYTES)
    );
    const ranges = createDownloadByteRanges(fileSize, rangeCount);

    assert.equal(ranges.length, rangeCount);
    assert.ok(
      ranges.every(
        (range) => range.end - range.start + 1 <= MAX_SEGMENT_RANGE_BYTES
      )
    );
    assert.equal(ranges.at(-1)?.end, fileSize - 1);
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

  it("splits a slow tail while preserving bytes already written", () => {
    const range = { start: 100, end: 1000 };
    const split = splitDownloadByteRange(range, 600, 100);

    assert.deepEqual(split, [
      { start: 100, end: 699 },
      { start: 700, end: 1000 },
    ]);
    assert.equal(splitDownloadByteRange(range, 850, 100), null);
  });

  it("validates full range coverage independently of dynamic range order", () => {
    const ranges = [
      { start: 0, end: 49 },
      { start: 100, end: 149 },
      { start: 50, end: 99 },
    ];

    assert.equal(
      areDownloadByteRangesComplete(ranges, [50, 50, 50], 150),
      true
    );
    assert.equal(
      areDownloadByteRangesComplete(ranges, [50, 49, 50], 150),
      false
    );
    assert.equal(
      areDownloadByteRangesComplete([{ start: 0, end: 998 }], [998], 1000),
      false
    );
  });

  it("rejects invalid sizes and connection counts", () => {
    assert.deepEqual(createDownloadByteRanges(0), []);
    assert.deepEqual(createDownloadByteRanges(-1), []);
    assert.deepEqual(createDownloadByteRanges(Number.POSITIVE_INFINITY), []);
    assert.deepEqual(createDownloadByteRanges(100, 0), []);
  });

  it("writes each buffer at its assigned file offset and resumes within a range", async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hydra-positional-write-")
    );
    const targetPath = path.join(temporaryDirectory, "target.bin");
    await fs.writeFile(targetPath, "0123456789");
    const fileHandle = await fs.open(targetPath, "r+");
    const signal = new AbortController().signal;
    const writtenLengths: number[] = [];

    try {
      await pipeline(
        Readable.from([Buffer.from("ABC")]),
        createPositionalWriteStream(
          fileHandle,
          4,
          1024,
          async (length) => {
            writtenLengths.push(length);
          },
          signal
        )
      );
      await pipeline(
        Readable.from([Buffer.from("xy")]),
        createPositionalWriteStream(
          fileHandle,
          1,
          1024,
          async (length) => {
            writtenLengths.push(length);
          },
          signal
        )
      );

      assert.equal((await fs.readFile(targetPath)).toString(), "0xy3ABC789");
      assert.deepEqual(writtenLengths, [3, 2]);
    } finally {
      await fileHandle.close();
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
