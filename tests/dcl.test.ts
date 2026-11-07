import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dclPoolId, dclSwapMsg, findDclRoute, type DclPool } from "../src/dcl";
import { selectBestRoute, type RouteQuote } from "../src/ref";

function pool(poolId: string, tokenX: string, tokenY: string, fee: number, liquidity: bigint): DclPool {
  return { poolId, tokenX, tokenY, fee, pointDelta: 40, currentPoint: 0, liquidity };
}

test("dcl pool id sorts the token pair and carries the fee tier", () => {
  assert.equal(dclPoolId("wrap.near", "abc.near", 10000), "abc.near|wrap.near|10000");
  assert.equal(dclPoolId("abc.near", "wrap.near", 10000), "abc.near|wrap.near|10000");
  assert.equal(dclPoolId("wrap.near", "abc.near", 100), "abc.near|wrap.near|100");
});

test("dcl swap message carries pool ids, output token and the min output floor", () => {
  const msg = JSON.parse(dclSwapMsg(["a.near|wrap.near|2000", "b.near|wrap.near|10000"], "b.near", 990n));
  assert.deepEqual(msg.Swap.pool_ids, ["a.near|wrap.near|2000", "b.near|wrap.near|10000"]);
  assert.equal(msg.Swap.output_token, "b.near");
  assert.equal(msg.Swap.min_output_amount, "990");
});

test("dcl route finding picks the fee tier that pays the most", async () => {
  const cheap = pool("tok.testnet|wrap.testnet|2000", "tok.testnet", "wrap.testnet", 2000, 1000n);
  const rich = pool("tok.testnet|wrap.testnet|10000", "tok.testnet", "wrap.testnet", 10000, 1000n);
  const quote = async (poolIds: string[]) => (poolIds[0] === rich.poolId ? 130n : 100n);
  const route = await findDclRoute("wrap.testnet", "tok.testnet", 1000n, { pools: [cheap, rich], quote });
  assert.equal(route.amountOutRaw, 130n);
  assert.deepEqual(route.poolIds, [rich.poolId]);
});

test("dcl route finding chains two hops through wNEAR as one pool path", async () => {
  const leg1 = pool("aaa.testnet|wrap.testnet|2000", "aaa.testnet", "wrap.testnet", 2000, 5000n);
  const leg2 = pool("bbb.testnet|wrap.testnet|2000", "bbb.testnet", "wrap.testnet", 2000, 5000n);
  const seen: string[][] = [];
  const quote = async (poolIds: string[]) => {
    seen.push(poolIds);
    return 777n;
  };
  const route = await findDclRoute("aaa.testnet", "bbb.testnet", 1000n, { pools: [leg1, leg2], quote });
  assert.equal(route.amountOutRaw, 777n);
  assert.deepEqual(route.poolIds, [leg1.poolId, leg2.poolId]);
  assert.deepEqual(seen, [[leg1.poolId, leg2.poolId]]);
});

test("dcl route finding skips empty pools and fails plainly when nothing routes", async () => {
  const empty = pool("tok.testnet|wrap.testnet|2000", "tok.testnet", "wrap.testnet", 2000, 0n);
  const quote = async () => 100n;
  await assert.rejects(
    () => findDclRoute("wrap.testnet", "tok.testnet", 1000n, { pools: [empty], quote }),
    /No DCL route/,
  );
});

test("best route selection compares simple and dcl quotes for the same input", () => {
  const base = { tokenIn: "wrap.near", tokenOut: "tok.near", amountInRaw: 1000n, exchangeId: "x", actions: [], dclPoolIds: [] };
  const simple: RouteQuote = { ...base, kind: "simple", amountOutRaw: 100n, description: "simple" };
  const dcl: RouteQuote = { ...base, kind: "dcl", amountOutRaw: 250n, description: "dcl", dclPoolIds: ["tok.near|wrap.near|2000"] };
  assert.equal(selectBestRoute([simple, dcl])?.kind, "dcl");
  assert.equal(selectBestRoute([dcl, simple])?.kind, "dcl");
  assert.equal(selectBestRoute([simple])?.kind, "simple");
  assert.equal(selectBestRoute([{ ...simple, amountOutRaw: 0n }]), undefined);
  assert.equal(selectBestRoute([]), undefined);
});
