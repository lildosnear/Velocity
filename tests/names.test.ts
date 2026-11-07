import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { config, parseNearToYocto } from "../src/config";
import {
  candidateLabelFor,
  fullNameId,
  getCreatorWallet,
  isImplicitId,
  maxLabelLength,
  namesEnabled,
  sanitizeLabel,
} from "../src/names";
import type { UserRecord } from "../src/store";

test("sanitize keeps a plain username as is, lowercased", () => {
  assert.equal(sanitizeLabel("swifttrader"), "swifttrader");
  assert.equal(sanitizeLabel("DesmondUzor"), "desmonduzor");
  assert.equal(sanitizeLabel("trader123"), "trader123");
});

test("sanitize turns separator runs into single dashes", () => {
  assert.equal(sanitizeLabel("King_1504"), "king-1504");
  assert.equal(sanitizeLabel("a--b__c"), "a-b-c");
  assert.equal(sanitizeLabel("john.doe"), "john-doe");
  assert.equal(sanitizeLabel("my name here"), "my-name-here");
});

test("sanitize drops invalid characters and trims separators at the edges", () => {
  assert.equal(sanitizeLabel("a!!b##c"), "a-b-c");
  assert.equal(sanitizeLabel("__king__"), "king");
  assert.equal(sanitizeLabel("@desmond!"), "desmond");
  assert.equal(sanitizeLabel("-x-y-"), "x-y");
});

test("sanitize returns undefined when nothing usable remains", () => {
  assert.equal(sanitizeLabel(undefined), undefined);
  assert.equal(sanitizeLabel(null), undefined);
  assert.equal(sanitizeLabel(""), undefined);
  assert.equal(sanitizeLabel("!!!"), undefined);
  assert.equal(sanitizeLabel("___"), undefined);
  assert.equal(sanitizeLabel("a"), undefined, "a single character is too short");
  assert.equal(sanitizeLabel("ab"), "ab", "two characters is the floor");
});

test("sanitize enforces the NEAR 64 character account id limit", () => {
  const max = maxLabelLength();
  assert.equal(max, 64 - config.nameSuffix.length);
  assert.equal(sanitizeLabel("a".repeat(max)), "a".repeat(max));
  assert.equal(sanitizeLabel("a".repeat(max + 1)), undefined);
});

test("candidate derivation uses the telegram username, and full ids carry the network suffix", () => {
  const user = { username: "King_1504" } as UserRecord;
  assert.equal(candidateLabelFor(user), "king-1504");
  assert.equal(candidateLabelFor({} as UserRecord), undefined);
  assert.equal(fullNameId("king-1504"), `king-1504${config.nameSuffix}`);
  assert.equal(config.registrarId, "testnet");
  assert.equal(config.nameSuffix, ".testnet");
});

test("isImplicitId only matches 64 character hex ids", () => {
  assert.equal(isImplicitId("8cc1762621292d79d0ce41a476021e4bb7c7227a02e681e57f1377dbc243a39b"), true);
  assert.equal(isImplicitId("king-1504.testnet"), false);
  assert.equal(isImplicitId("velocitybot.testnet"), false);
});

test("parseNearToYocto parses plain decimals exactly", () => {
  assert.equal(parseNearToYocto("0.01"), 10n ** 22n);
  assert.equal(parseNearToYocto("0.002"), 2n * 10n ** 21n);
  assert.equal(parseNearToYocto("1"), 10n ** 24n);
  assert.equal(parseNearToYocto("0.0001"), 10n ** 20n);
  assert.equal(parseNearToYocto("2.5"), 25n * 10n ** 23n);
  assert.equal(parseNearToYocto("0"), 0n);
  assert.equal(parseNearToYocto(" 0.01 "), 10n ** 22n);
});

test("parseNearToYocto rejects junk instead of guessing", () => {
  assert.equal(parseNearToYocto(""), undefined);
  assert.equal(parseNearToYocto("abc"), undefined);
  assert.equal(parseNearToYocto("-1"), undefined);
  assert.equal(parseNearToYocto("1.2.3"), undefined);
  assert.equal(parseNearToYocto("0.0000000000000000000000001"), undefined, "more than 24 decimal places");
  assert.equal(parseNearToYocto("1e-3"), undefined);
});

test("named wallet config defaults: wallet standard deposit, no creator in tests", () => {
  // The test environment does not set NAME_CREATION_DEPOSIT_NEAR or a creator.
  assert.equal(config.nameCreationDepositYocto, 10n ** 22n, "default creation deposit is 0.01 NEAR");
  assert.equal(getCreatorWallet(), undefined);
  assert.equal(namesEnabled(), false, "creation stays dormant with no creator configured");
});
