import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config";
import { store, type UserRecord } from "../src/store";
import {
  creditApplies,
  creditReferrer,
  discountApplies,
  effectiveFeeBps,
  feeForTrade,
  referrerCut,
} from "../src/market";
import { encryptPrivateKey } from "../src/crypto";

function makeUser(telegramId: number, referredBy?: number, refTradeCount = 0): UserRecord {
  const user: UserRecord = {
    telegramId,
    accountId: `${"a".repeat(60)}${String(telegramId).padStart(4, "0")}`,
    encSecret: encryptPrivateKey("ed25519:test"),
    tokens: {},
    payCurrency: "NEAR",
    referredBy,
    refTradeCount,
    createdAt: new Date().toISOString(),
  };
  store.saveUser(user);
  return user;
}

test("fee math: full fee is 1 percent of NEAR value", () => {
  assert.equal(config.botFeeBps, 100);
  assert.equal(feeForTrade(10, 100), 0.1);
  assert.equal(feeForTrade(2.5, 100), 0.025);
  assert.equal(feeForTrade(0, 100), 0);
});

test("fee math: referral discount takes 25 percent off the fee", () => {
  assert.equal(feeForTrade(10, 75), 0.075);
});

test("referrer cut is 25 percent of the captured fee", () => {
  assert.equal(referrerCut(0.1), 0.025);
  assert.equal(referrerCut(0), 0);
});

test("effective fee: no referrer means full fee", () => {
  const user = makeUser(1001);
  assert.equal(effectiveFeeBps(user), 100);
  assert.equal(discountApplies(user), false);
  assert.equal(creditApplies(user), false);
});

test("effective fee: referred friend pays 75 bps for the first 10 trades", () => {
  makeUser(1002);
  const friend = makeUser(1003, 1002, 0);
  assert.equal(effectiveFeeBps(friend), 75);
  const almostDone = makeUser(1004, 1002, 9);
  assert.equal(effectiveFeeBps(almostDone), 75);
  assert.equal(discountApplies(almostDone), true);
});

test("effective fee: discount hard stops at trade 10, back to full fee", () => {
  makeUser(1005);
  const friend = makeUser(1006, 1005, 10);
  assert.equal(effectiveFeeBps(friend), 100);
  assert.equal(discountApplies(friend), false);
});

test("referrer credit continues for life after the discount ends", () => {
  const referrer = makeUser(1007);
  const friend = makeUser(1008, referrer.telegramId, 0);
  // 12 manual trades, fee 0.1 NEAR each time.
  for (let i = 0; i < 12; i++) {
    const fresh = store.getUser(friend.telegramId)!;
    creditReferrer(fresh, 0.1);
  }
  const after = store.getUser(referrer.telegramId)!;
  assert.ok(Math.abs((after.referralEarnedNear ?? 0) - 12 * 0.025) < 1e-12);
  const friendAfter = store.getUser(friend.telegramId)!;
  assert.equal(friendAfter.refTradeCount, 12);
  assert.equal(creditApplies(friendAfter), true); // still earning for the referrer
  assert.equal(effectiveFeeBps(friendAfter), 100); // but no more discount
});

test("creditReferrer with no referrer is a no op", () => {
  const solo = makeUser(1009);
  creditReferrer(solo, 0.5);
  const after = store.getUser(1009)!;
  assert.equal(after.refTradeCount, 0);
  assert.equal(after.referralEarnedNear, undefined);
});

test("AI trades never touch referral counters", () => {
  // The copy engine logs AI trades with viaAi set and never calls
  // creditReferrer. This test pins the contract: logging an AI trade
  // leaves both the discount count and the referrer balance untouched.
  const referrer = makeUser(1010);
  const friend = makeUser(1011, referrer.telegramId, 3);
  store.logTrade({
    at: new Date().toISOString(),
    telegramId: friend.telegramId,
    side: "buy",
    tokenId: "token.testnet",
    symbol: "TOKEN",
    payAmount: 1,
    payCurrency: "NEAR",
    nearValue: 1,
    tokenAmount: 10,
    priceNear: 0.1,
    feeNear: 0.01,
    viaAi: true,
    txids: ["deadbeef"],
  });
  const friendAfter = store.getUser(friend.telegramId)!;
  assert.equal(friendAfter.refTradeCount, 3);
  const referrerAfter = store.getUser(referrer.telegramId)!;
  assert.equal(referrerAfter.referralEarnedNear, undefined);
});
