import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cleanFolderGameTitle,
  getArchiveFolderNames,
  isConfidentTitleMatch,
  pickConfidentTitleMatch,
} from "./folder-game-title.js";

describe("cleanFolderGameTitle", () => {
  it("strips release groups, sites and versions", () => {
    assert.equal(cleanFolderGameTitle("God-of-War-SteamRIP.com"), "God of War");
    assert.equal(
      cleanFolderGameTitle("Call-Of-Duty-Black-Ops-AnkerGames"),
      "Call Of Duty Black Ops"
    );
    assert.equal(
      cleanFolderGameTitle("Pummel.Party.v1.14.1k-OFME"),
      "Pummel Party"
    );
    assert.equal(
      cleanFolderGameTitle("Assassins's Creed 4 - Black Flag [FitGirl Repack]"),
      "Assassins's Creed 4 Black Flag"
    );
    assert.equal(
      cleanFolderGameTitle("Forza-Horizon-5-AnkerGames"),
      "Forza Horizon 5"
    );
    assert.equal(
      cleanFolderGameTitle("Buckshot Roulette"),
      "Buckshot Roulette"
    );
  });
});

describe("isConfidentTitleMatch", () => {
  it("ignores punctuation, symbols and a leading article", () => {
    assert.equal(
      isConfidentTitleMatch("No I M Not A Human", "No, I'm Not a Human"),
      true
    );
    assert.equal(
      isConfidentTitleMatch("TheOutlastTrials", "The Outlast Trials"),
      true
    );
    assert.equal(
      isConfidentTitleMatch(
        "Call Of Duty Black Ops",
        "Call of Duty®: Black Ops"
      ),
      true
    );
    assert.equal(
      isConfidentTitleMatch("Outlast Trials", "The Outlast Trials"),
      true
    );
  });

  it("rejects partial, abbreviated and very short names", () => {
    assert.equal(
      isConfidentTitleMatch("BLEACH RoS", "BLEACH Rebirth of Souls"),
      false
    );
    assert.equal(
      isConfidentTitleMatch(
        "Call Of Duty Black Ops",
        "Call of Duty: Black Ops II"
      ),
      false
    );
    assert.equal(isConfidentTitleMatch("Run", "Run"), false);
  });
});

describe("pickConfidentTitleMatch", () => {
  const results = [
    { objectId: "1", title: "Machine Party" },
    { objectId: "2", title: "Machine Party Deluxe" },
  ];

  it("returns the only confident match", () => {
    assert.equal(
      pickConfidentTitleMatch("Machine Party", results)?.objectId,
      "1"
    );
  });

  it("returns null when several different games match", () => {
    assert.equal(
      pickConfidentTitleMatch("Machine Party", [
        ...results,
        { objectId: "3", title: "Machine-Party" },
      ]),
      null
    );
  });

  it("returns null when nothing matches", () => {
    assert.equal(pickConfidentTitleMatch("Fortnite", results), null);
  });
});

describe("getArchiveFolderNames", () => {
  it("maps archives to the folder they are extracted into", () => {
    assert.deepEqual(getArchiveFolderNames("God-of-War-SteamRIP.com.rar"), [
      "god-of-war-steamrip.com",
    ]);
    assert.deepEqual(getArchiveFolderNames("Game.part1.rar"), [
      "game.part1",
      "game",
    ]);
    assert.deepEqual(getArchiveFolderNames("Game.7z.001"), ["game.7z"]);
  });

  it("ignores files that are not archives", () => {
    assert.equal(getArchiveFolderNames("otozip.ps1"), null);
    assert.equal(getArchiveFolderNames("Buckshot Roulette"), null);
  });
});
