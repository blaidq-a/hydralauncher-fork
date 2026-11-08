import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildWindowsProcessIndex,
  matchWindowsGameProcess,
} from "./process-path-match.js";

const indexOf = (paths: string[]) =>
  buildWindowsProcessIndex(new Map([["any", new Set(paths)]]));

describe("matchWindowsGameProcess", () => {
  it("matches the executable regardless of case and slash style", () => {
    const index = indexOf(["c:\\games\\cuphead\\Cuphead.exe"]);

    assert.equal(
      matchWindowsGameProcess("C:/Games/Cuphead/cuphead.exe", index, {
        allowFolderMatch: false,
      }),
      true
    );
  });

  it("matches a binary launched from the game folder only when allowed", () => {
    const index = indexOf([
      "C:\\Games\\Stray\\Hk_project\\Binaries\\Win64\\Stray-Win64-Shipping.exe",
    ]);

    assert.equal(
      matchWindowsGameProcess("C:\\Games\\Stray\\Stray.exe", index, {
        allowFolderMatch: false,
      }),
      false
    );
    assert.equal(
      matchWindowsGameProcess("C:\\Games\\Stray\\Stray.exe", index, {
        allowFolderMatch: true,
      }),
      true
    );
  });

  it("ignores crash handlers and shared library roots", () => {
    assert.equal(
      matchWindowsGameProcess(
        "C:\\Games\\Hollow\\hollow_knight.exe",
        indexOf(["C:\\Games\\Hollow\\UnityCrashHandler64.exe"]),
        { allowFolderMatch: true }
      ),
      false
    );
    assert.equal(
      matchWindowsGameProcess(
        "C:\\Games\\game.exe",
        indexOf(["C:\\Games\\Other\\other.exe"]),
        { allowFolderMatch: true }
      ),
      false
    );
  });
});
