import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyBuyNearValue, isOverTradeCap } from "../src/copy";
import { config } from "../src/config";

// Regression coverage for the per trade cap in the copy engine.
// Before the fix, onTraderBuy called swapBuy with the stored per
// trade size unchecked: /ai setup refused an over cap size only when
// the pay currency happened to be the default at setup time, so a
// stored size could still spend past MAX_TRADE_NEAR (pay currency
// changed afterwards, or the operator lowered the cap). The cap is
// now enforced at the point of spending, mirroring executeBuy.

test("a NEAR per trade size is its own NEAR value for the cap", async () => {
  assert.equal(await copyBuyNearValue("NEAR", 0.1), 0.1);
  assert.equal(await copyBuyNearValue("NEAR", 25), 25);
});

test("the cap comparison is strict: at the cap trades, above it does not", () => {
  assert.equal(isOverTradeCap(9.99, 10), false);
  assert.equal(isOverTradeCap(10, 10), false);
  assert.equal(isOverTradeCap(10.01, 10), true);
  assert.equal(isOverTradeCap(0, 10), false);
});

test("a per trade size above the configured cap is over, one below is not", async () => {
  const over = await copyBuyNearValue("NEAR", config.maxTradeNear + 1);
  assert.equal(isOverTradeCap(over, config.maxTradeNear), true);
  const under = await copyBuyNearValue("NEAR", config.maxTradeNear / 2);
  assert.equal(isOverTradeCap(under, config.maxTradeNear), false);
});
