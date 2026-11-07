import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeTraderAlert, type TraderAlertDiff } from "../src/watcher";
import type { TradedToken } from "../src/store";

const WNEAR = "wrap.testnet";

function token(id: string, symbol: string): TradedToken {
  return { id, symbol, decimals: 24 };
}

function diff(id: string, symbol: string, side: "buy" | "sell", amountTokens: number): TraderAlertDiff {
  return { token: token(id, symbol), side, amountTokens };
}

test("single token buy composes one plain alert", () => {
  const text = composeTraderAlert(
    "oxdevv.testnet",
    [diff("banana.ft-fin.testnet", "BANANA", "buy", 2889.42)],
    WNEAR,
  );
  assert.equal(text, "Trader alert: oxdevv.testnet bought 2,889.42 BANANA.");
});

test("wrap plus swap in one tick is one line with no wNEAR mention", () => {
  // The live case: the trader wrapped 0.10 NEAR into wNEAR, then paid
  // the wNEAR out for BANANA. Three diffs, one trade, one alert.
  const text = composeTraderAlert(
    "oxdevv.testnet",
    [
      diff(WNEAR, "wNEAR", "buy", 0.1),
      diff(WNEAR, "wNEAR", "sell", 0.1),
      diff("banana.ft-fin.testnet", "BANANA", "buy", 2889.42),
    ],
    WNEAR,
  );
  assert.equal(text, "Trader alert: oxdevv.testnet bought 2,889.42 BANANA.");
  assert.ok(text && !text.includes("wNEAR"));
});

test("a swap tick drops only the wNEAR payment leg, keeping a real sell", () => {
  const text = composeTraderAlert(
    "oxdevv.testnet",
    [
      diff(WNEAR, "wNEAR", "sell", 0.1),
      diff("old.testnet", "OLD", "sell", 40),
      diff("banana.ft-fin.testnet", "BANANA", "buy", 2889.42),
    ],
    WNEAR,
  );
  assert.equal(text, "Trader alert: oxdevv.testnet sold 40.00 OLD and bought 2,889.42 BANANA.");
});

test("wNEAR on its own still alerts, it is a real event", () => {
  assert.equal(
    composeTraderAlert("oxdevv.testnet", [diff(WNEAR, "wNEAR", "sell", 0.1)], WNEAR),
    "Trader alert: oxdevv.testnet sold 0.10 wNEAR.",
  );
  assert.equal(
    composeTraderAlert("oxdevv.testnet", [diff(WNEAR, "wNEAR", "buy", 0.25)], WNEAR),
    "Trader alert: oxdevv.testnet bought 0.25 wNEAR.",
  );
});

test("sells are stated before buys even when the buy diff came first", () => {
  const text = composeTraderAlert(
    "trader.testnet",
    [diff("x.testnet", "XXX", "buy", 3), diff("y.testnet", "YYY", "sell", 7)],
    WNEAR,
  );
  assert.equal(text, "Trader alert: trader.testnet sold 7.00 YYY and bought 3.00 XXX.");
});

test("multiple buys and sells in one tick list with commas and a final and", () => {
  const text = composeTraderAlert(
    "trader.testnet",
    [
      diff("a.testnet", "AAA", "sell", 10),
      diff("b.testnet", "BBB", "sell", 5),
      diff("c.testnet", "CCC", "buy", 100),
      diff("d.testnet", "DDD", "buy", 2.5),
      diff("e.testnet", "EEE", "buy", 1),
    ],
    WNEAR,
  );
  assert.equal(
    text,
    "Trader alert: trader.testnet sold 10.00 AAA and 5.00 BBB and bought 100.00 CCC, 2.50 DDD and 1.00 EEE.",
  );
});

test("no diffs means no alert", () => {
  assert.equal(composeTraderAlert("trader.testnet", [], WNEAR), undefined);
});
