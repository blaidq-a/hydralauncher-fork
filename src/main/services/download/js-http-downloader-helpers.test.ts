import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, it } from "node:test";
import {
  areDownloadByteRangesComplete,
  areDownloadByteRangesContiguous,
  createDownloadByteRanges,
  createPositionalWriteStream,
  isDownloadCompleteOnDisk,
  MAX_SEGMENTED_DOWNLOAD_CONNECTIONS,
  MAX_SEGMENT_RANGE_BYTES,
  SEGMENTED_DOWNLOAD_CONNECTIONS,
  splitDownloadByteRange,
} from "./js-http-downloader-helpers.ts";

describe("isDownloadCompleteOnDisk", () => {
  it("requires the local file to reach the expected byte count before extraction", () => {
    assert.equal(isDownloadCompleteOnDisk(1024, 1024), true);
    assert.equal(isDownloadCompleteOnDisk(1023, 1024), false);
    assert.equal(isDownloadCompleteOnDisk(0, 100), false);
    assert.equal(isDownloadCompleteOnDisk(10, null), true);
    assert.equal(isDownloadCompleteOnDisk(0, null), false);
  });
});

describe("createDownloadByteRanges", () => {
  it("uses at least ten and at most twenty connections for segmented downloads", () => {
    assert.equal(SEGMENTED_DOWNLOAD_CONNECTIONS, 10);
    assert.equal(MAX_SEGMENTED_DOWNLOAD_CONNECTIONS, 20);
  });

  it("supports a maximum of twenty byte ranges", () => {
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

  it("keeps dynamically split segments contiguous and resume-safe", () => {
    const ranges = [
      { start: 0, end: 999 },
      { start: 1000, end: 1999 },
      { start: 2000, end: 2999 },
    ];
    const offsets = [250, 0, 0];
    const split = splitDownloadByteRange(ranges[0], offsets[0], 100);

    assert.ok(split);
    const [leftRange, rightRange] = split;
    ranges.splice(0, 1, leftRange, rightRange);
    offsets.splice(0, 1, offsets[0], 0);

    assert.ok(areDownloadByteRangesContiguous(ranges, 3000));
    assert.deepEqual(ranges, [
      { start: 0, end: 499 },
      { start: 500, end: 999 },
      { start: 1000, end: 1999 },
      { start: 2000, end: 2999 },
    ]);
    assert.deepEqual(offsets, [250, 0, 0, 0]);
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

  it("simulates segmented download resume across multiple ranges without data corruption", async () => {
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "hydra-segmented-sim-")
    );
    const targetPath = path.join(temporaryDirectory, "game.bin");
    const totalFileSize = 100 * 1024; // 100 KB
    const expectedData = Buffer.alloc(totalFileSize);
    for (let i = 0; i < totalFileSize; i++) {
      expectedData[i] = (i * 31) % 256;
    }

    // Preallocate target file as in real segmented download
    const targetHandle = await fs.open(targetPath, "w+");
    await targetHandle.truncate(totalFileSize);

    const ranges = createDownloadByteRanges(totalFileSize, 4);
    const offsets = ranges.map(() => 0);

    // Simulate downloading segment 0 partially, then interrupting
    const seg0Range = ranges[0];
    const seg0Total = seg0Range.end - seg0Range.start + 1;
    const seg0Part1Len = Math.floor(seg0Total / 2);

    const abortController1 = new AbortController();
    await pipeline(
      Readable.from([
        expectedData.subarray(seg0Range.start, seg0Range.start + seg0Part1Len),
      ]),
      createPositionalWriteStream(
        targetHandle,
        seg0Range.start + offsets[0],
        4096,
        async (bytes) => {
          offsets[0] += bytes;
        },
        abortController1.signal
      )
    );

    assert.equal(offsets[0], seg0Part1Len);

    // Simulate resume of segment 0 from its saved offset
    const seg0Part2Len = seg0Total - offsets[0];
    const abortController2 = new AbortController();
    await pipeline(
      Readable.from([
        expectedData.subarray(
          seg0Range.start + offsets[0],
          seg0Range.start + offsets[0] + seg0Part2Len
        ),
      ]),
      createPositionalWriteStream(
        targetHandle,
        seg0Range.start + offsets[0],
        4096,
        async (bytes) => {
          offsets[0] += bytes;
        },
        abortController2.signal
      )
    );

    assert.equal(offsets[0], seg0Total);

    // Download remaining segments 1, 2, 3 completely
    for (let idx = 1; idx < ranges.length; idx++) {
      const range = ranges[idx];
      await pipeline(
        Readable.from([expectedData.subarray(range.start, range.end + 1)]),
        createPositionalWriteStream(
          targetHandle,
          range.start + offsets[idx],
          4096,
          async (bytes) => {
            offsets[idx] += bytes;
          },
          new AbortController().signal
        )
      );
    }

    assert.ok(areDownloadByteRangesComplete(ranges, offsets, totalFileSize));

    await targetHandle.close();
    const diskData = await fs.readFile(targetPath);
    assert.equal(Buffer.compare(diskData, expectedData), 0);

    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });
});
