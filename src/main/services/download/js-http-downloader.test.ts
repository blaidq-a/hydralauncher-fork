import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { JsHttpDownloader } from "./js-http-downloader.js";

const FILE_SIZE = 32 * 1024 * 1024;
const FILE_CONTENT_BYTE = 0x5a;

describe("JsHttpDownloader segmented downloads", () => {
  it("downloads a byte-range file using concurrent HTTP requests", async () => {
    let activeRangeRequests = 0;
    let maxActiveRangeRequests = 0;
    const requestedRanges: string[] = [];
    const server = http.createServer((request, response) => {
      const range = request.headers.range;
      const match = range && /^bytes=(\d+)-(\d+)$/.exec(range);

      if (!match) {
        response.writeHead(200, {
          "content-length": FILE_SIZE,
          "content-type": "application/octet-stream",
        });
        response.end(Buffer.alloc(FILE_SIZE, FILE_CONTENT_BYTE));
        return;
      }

      requestedRanges.push(range);
      const start = Number.parseInt(match[1], 10);
      const end = Number.parseInt(match[2], 10);
      response.writeHead(206, {
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${FILE_SIZE}`,
        "content-type": "application/octet-stream",
      });

      if (start === 0 && end === 0) {
        response.end(Buffer.alloc(1, FILE_CONTENT_BYTE));
        return;
      }

      activeRangeRequests += 1;
      maxActiveRangeRequests = Math.max(
        maxActiveRangeRequests,
        activeRangeRequests
      );
      const rangeIndex = Math.floor(start / (FILE_SIZE / 20));
      const responseDelay = 50 + rangeIndex * 25;
      const responseTimer = setTimeout(() => {
        response.end(Buffer.alloc(end - start + 1, FILE_CONTENT_BYTE));
      }, responseDelay);
      response.once("close", () => {
        clearTimeout(responseTimer);
        activeRangeRequests -= 1;
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const savePath = await fs.mkdtemp(
      path.join(os.tmpdir(), "hydra-segmented-download-")
    );

    try {
      const downloader = new JsHttpDownloader();
      await downloader.startDownload({
        url: `http://127.0.0.1:${address.port}/download.bin`,
        savePath,
        filename: "download.bin",
      });

      const status = downloader.getDownloadStatus();
      assert.equal(status?.status, "complete");
      assert.equal(status?.bytesDownloaded, FILE_SIZE);
      assert.ok(
        maxActiveRangeRequests > 10,
        `Expected successful ranges to increase concurrency above ten; observed ${maxActiveRangeRequests} from ${JSON.stringify(requestedRanges)}`
      );
      assert.ok(
        maxActiveRangeRequests <= 20,
        `Expected no more than twenty concurrent byte-range requests; observed ${maxActiveRangeRequests}`
      );

      const downloadedFile = await fs.readFile(
        path.join(savePath, "download.bin")
      );
      assert.equal(downloadedFile.length, FILE_SIZE);
      assert.ok(downloadedFile.every((byte) => byte === FILE_CONTENT_BYTE));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await fs.rm(savePath, { recursive: true, force: true });
    }
  });

  it("resumes the contiguous downloaded prefix after a failed segment without overcounting", async () => {
    let fallbackResumeStart: number | null = null;
    const server = http.createServer((request, response) => {
      const range = request.headers.range;
      const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);

      if (!match) {
        response.writeHead(200, {
          "content-length": FILE_SIZE,
          "content-type": "application/octet-stream",
        });
        response.end(Buffer.alloc(FILE_SIZE, FILE_CONTENT_BYTE));
        return;
      }

      const start = Number.parseInt(match[1], 10);
      const end = match[2] ? Number.parseInt(match[2], 10) : FILE_SIZE - 1;
      if (!match[2]) fallbackResumeStart = start;
      if (start === 0 && end === 0) {
        response.writeHead(206, {
          "content-length": 1,
          "content-range": `bytes 0-0/${FILE_SIZE}`,
          "content-type": "application/octet-stream",
        });
        response.end(Buffer.alloc(1, FILE_CONTENT_BYTE));
        return;
      }

      if (match[2] && end === FILE_SIZE - 1) {
        setTimeout(() => {
          response.writeHead(404);
          response.end();
        }, 100);
        return;
      }

      response.writeHead(206, {
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${FILE_SIZE}`,
        "content-type": "application/octet-stream",
      });
      response.end(Buffer.alloc(end - start + 1, FILE_CONTENT_BYTE));
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const savePath = await fs.mkdtemp(
      path.join(os.tmpdir(), "hydra-segmented-fallback-")
    );

    try {
      const downloader = new JsHttpDownloader();
      await downloader.startDownload({
        url: `http://127.0.0.1:${address.port}/download.bin`,
        savePath,
        filename: "download.bin",
      });

      const status = downloader.getDownloadStatus();
      assert.equal(status?.status, "complete");
      assert.equal(status?.fileSize, FILE_SIZE);
      assert.equal(status?.bytesDownloaded, FILE_SIZE);
      assert.ok(
        fallbackResumeStart !== null && fallbackResumeStart > 0,
        "Expected the single-connection fallback to resume after the downloaded prefix"
      );
      assert.equal(
        (await fs.stat(path.join(savePath, "download.bin"))).size,
        FILE_SIZE
      );
      const downloadedFile = await fs.readFile(
        path.join(savePath, "download.bin")
      );
      assert.ok(downloadedFile.every((byte) => byte === FILE_CONTENT_BYTE));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await fs.rm(savePath, { recursive: true, force: true });
    }
  });
});
