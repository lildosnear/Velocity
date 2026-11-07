import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromRaw, toRaw } from "../src/market";
import { applySlippage, findRoute, instantSwapMsg } from "../src/ref";

test("raw conversion is exact for NEAR and stablecoin decimals", () => {
  assert.equal(toRaw(1, 24), 10n ** 24n);
  assert.equal(toRaw(0.1, 24), 10n ** 23n);
  assert.equal(toRaw(1.5, 6), 1_500_000n);
  assert.equal(toRaw(0.000001, 6), 1n);
  assert.equal(toRaw(0, 6), 0n);
  assert.equal(fromRaw(1_500_000n, 6), 1.5);
  assert.equal(fromRaw(10n ** 24n, 24), 1);
});

test("slippage math: min out is quote minus the slippage fraction", () => {
  assert.equal(applySlippage(1000n, 100), 990n); // 1 percent
  assert.equal(applySlippage(1000n, 0), 1000n);
  assert.equal(applySlippage(1000n, 50), 995n); // 0.5 percent
  assert.equal(applySlippage(3n, 100), 2n); // integer floor, never above the quote
});

test("instant swap message carries the actions in the Execute envelope", () => {
  const msg = JSON.parse(
    instantSwapMsg([
      { pool_id: 7, token_in: "wrap.testnet", token_out: "token.testnet", amount_in: "1000", min_amount_out: "900" },
      { pool_id: 9, token_in: "token.testnet", token_out: "other.testnet", min_amount_out: "5" },
    ]),
  );
  assert.ok(msg.Execute);
  assert.equal(msg.Execute.actions.length, 2);
  assert.equal(msg.Execute.actions[0].pool_id, 7);
  assert.equal(msg.Execute.actions[0].amount_in, "1000");
  assert.equal(msg.Execute.actions[1].amount_in, undefined); // chained hop takes the previous output
  assert.equal(msg.Execute.referral_id, undefined);
});

test("instant swap message includes the referral when given", () => {
  const msg = JSON.parse(instantSwapMsg([], "velocitybot.testnet"));
  assert.equal(msg.Execute.referral_id, "velocitybot.testnet");
});

test("same token route is a no swap passthrough with no network needed", async () => {
  const route = await findRoute("wrap.testnet", "wrap.testnet", 12345n);
  assert.equal(route.amountOutRaw, 12345n);
  assert.equal(route.actions.length, 0);
});
