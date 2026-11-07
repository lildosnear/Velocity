import { config } from "./config";
import { parallelMap, viewFunction } from "./near";

/**
 * Rhea DCL (discretized concentrated liquidity) exchange reads.
 *
 * Method surface verified live against mainnet dclv2.ref-labs.near on
 * 2026-11-06 by direct RPC view calls:
 * - list_pools {from_index, limit} returns pool objects with pool_id,
 *   token_x, token_y, fee, point_delta, current_point and liquidity.
 *   A pool id is the string "token_x|token_y|fee" with the two token ids
 *   in sorted order, for example "token.near|wrap.near|10000".
 * - get_pool {pool_id} returns one pool object or null.
 * - quote {pool_ids, input_token, output_token, input_amount, tag}
 *   returns {amount, tag} where amount is the raw output for the exact
 *   input across the given pool path. Verified live: 0.1 wNEAR quoted
 *   370071 raw of the bridged USDC token through its 2000 fee pool, and
 *   401075849685359005391 raw NEARLY through its 10000 fee pool.
 * - Swaps arrive as ft_transfer_call on the input token with the message
 *   {"Swap":{"pool_ids":[...],"output_token":"...","min_output_amount":"..."}},
 *   the format real mainnet DCL trades use.
 *
 * Fee tiers in the wild: 100, 400, 2000 and 10000 (hundredths of a
 * percent, so 10000 is a 1 percent pool fee). Point delta follows the
 * tier (2000 gives 40, 10000 gives 200).
 *
 * Testnet state, verified the same day: no DCL deployment exists on
 * testnet. dclv2.ref-labs.testnet and every plausible variant account
 * either does not exist or holds no contract code, so scanDclPools on
 * testnet returns an empty list and routing uses simple pools there.
 * Quotes for DCL pairs are proven against mainnet views in read only
 * mode (see the smoke test), never with mainnet transactions.
 */

export interface DclPool {
  /** "token_x|token_y|fee" */
  poolId: string;
  tokenX: string;
  tokenY: string;
  /** pool fee in hundredths of a percent (fee / 10000 = fraction) */
  fee: number;
  pointDelta: number;
  currentPoint: number;
  liquidity: bigint;
}

interface RawDclPool {
  pool_id: string;
  token_x: string;
  token_y: string;
  fee: number;
  point_delta: number;
  current_point: number;
  liquidity: string;
}

/** Build a DCL pool id from its two tokens and fee tier. Token order is sorted, as the contract stores it. Pure, unit tested. */
export function dclPoolId(tokenA: string, tokenB: string, fee: number): string {
  const [x, y] = [tokenA, tokenB].sort();
  return `${x}|${y}|${fee}`;
}

const dclCache = new Map<string, DclPool>();
let dclScanAt = 0;
let dclScanDone = false;
let dclScanned = 0;

/**
 * Scan DCL pools on the configured DCL exchange. Mainnet carries
 * thousands of pools, so the scan is bounded (default 2000 pools, pages
 * of 100 fetched in parallel batches of 8). The completed scan is
 * cached for a minute, the same pattern as the simple pool scan, and
 * the cache also holds when the scan finds nothing, so testnet does
 * not re-probe the missing contract on every quote. Returns an empty
 * list when the contract does not exist on this network, which is the
 * testnet case today.
 */
export async function scanDclPools(maxPools = 2000): Promise<DclPool[]> {
  if (dclScanDone && Date.now() - dclScanAt < 60_000) {
    return [...dclCache.values()];
  }
  dclCache.clear();
  const PAGE = 100;
  const BATCH = 8;
  let total = 0;
  let exhausted = false;
  while (total < maxPools && !exhausted) {
    const starts: number[] = [];
    for (let s = total; s < Math.min(total + PAGE * BATCH, maxPools); s += PAGE) starts.push(s);
    const pages = await parallelMap(starts, BATCH, async (from) => {
      try {
        return await viewFunction<RawDclPool[]>(config.dclExchangeId, "list_pools", {
          from_index: from,
          limit: PAGE,
        });
      } catch {
        return undefined;
      }
    });
    for (const page of pages) {
      if (!page || page.length === 0) {
        exhausted = true;
        break;
      }
      for (const raw of page) {
        total += 1;
        if (!raw.pool_id || !raw.token_x || !raw.token_y) continue;
        dclCache.set(raw.pool_id, {
          poolId: raw.pool_id,
          tokenX: raw.token_x,
          tokenY: raw.token_y,
          fee: Number(raw.fee),
          pointDelta: Number(raw.point_delta),
          currentPoint: Number(raw.current_point),
          liquidity: BigInt(raw.liquidity ?? "0"),
        });
      }
      if (page.length < PAGE) {
        exhausted = true;
        break;
      }
    }
  }
  dclScanned = total;
  dclScanAt = Date.now();
  dclScanDone = true;
  return [...dclCache.values()];
}

export async function getDclPool(poolId: string): Promise<DclPool | undefined> {
  const cached = dclCache.get(poolId);
  if (cached) return cached;
  const raw = await viewFunction<RawDclPool>(config.dclExchangeId, "get_pool", { pool_id: poolId });
  if (!raw) return undefined;
  const pool: DclPool = {
    poolId: raw.pool_id,
    tokenX: raw.token_x,
    tokenY: raw.token_y,
    fee: Number(raw.fee),
    pointDelta: Number(raw.point_delta),
    currentPoint: Number(raw.current_point),
    liquidity: BigInt(raw.liquidity ?? "0"),
  };
  dclCache.set(poolId, pool);
  return pool;
}

export interface DclQuoteResult {
  amountOutRaw: bigint;
}

/** Quote an exact input across a DCL pool path through the contract quote view. */
export async function quoteDcl(
  poolIds: string[],
  tokenIn: string,
  tokenOut: string,
  amountInRaw: bigint,
): Promise<bigint> {
  const res = await viewFunction<{ amount: string }>(config.dclExchangeId, "quote", {
    pool_ids: poolIds,
    input_token: tokenIn,
    output_token: tokenOut,
    input_amount: amountInRaw.toString(),
    tag: "velocity",
  });
  if (!res || res.amount === undefined) throw new Error(`DCL quote failed for ${poolIds.join(" -> ")}.`);
  return BigInt(res.amount);
}

export interface DclRouteQuote {
  tokenIn: string;
  tokenOut: string;
  amountInRaw: bigint;
  amountOutRaw: bigint;
  poolIds: string[];
  description: string;
}

export interface DclDeps {
  pools: DclPool[];
  quote: (poolIds: string[], tokenIn: string, tokenOut: string, amountInRaw: bigint) => Promise<bigint>;
}

/**
 * Find the best DCL route for an exact input: a direct pool at any fee
 * tier, or two hops through wNEAR where both legs exist. The quote
 * function is injectable so the selection logic is unit tested without
 * a network. Pools with no liquidity are never quoted.
 */
export async function findDclRoute(
  tokenIn: string,
  tokenOut: string,
  amountInRaw: bigint,
  deps?: DclDeps,
): Promise<DclRouteQuote> {
  const pools = deps?.pools ?? (await scanDclPools());
  const quote = deps?.quote ?? quoteDcl;
  const pair = (p: DclPool, a: string, b: string) =>
    (p.tokenX === a && p.tokenY === b) || (p.tokenX === b && p.tokenY === a);

  let best: DclRouteQuote | undefined;
  const consider = (q: DclRouteQuote) => {
    if (q.amountOutRaw <= 0n) return;
    if (!best || q.amountOutRaw > best.amountOutRaw) best = q;
  };

  // Quote candidate pools in parallel (bounded), then consider the
  // results in pool order so ties resolve as the sequential version did.
  const direct = pools.filter((p) => p.liquidity > 0n && pair(p, tokenIn, tokenOut));
  const directOuts = await parallelMap(direct, 8, async (pool) => {
    try {
      return await quote([pool.poolId], tokenIn, tokenOut, amountInRaw);
    } catch {
      return 0n;
    }
  });
  direct.forEach((pool, i) => {
    consider({
      tokenIn,
      tokenOut,
      amountInRaw,
      amountOutRaw: directOuts[i],
      poolIds: [pool.poolId],
      description: `${tokenIn} -> ${tokenOut} via DCL pool ${pool.poolId}`,
    });
  });
  if (best) return best;

  // Two hops through wNEAR, quoted as one pool path by the contract.
  const mid = config.wnearId;
  if (tokenIn !== mid && tokenOut !== mid) {
    const firstLegs = pools.filter((p) => p.liquidity > 0n && pair(p, tokenIn, mid));
    const secondLegs = pools.filter((p) => p.liquidity > 0n && pair(p, mid, tokenOut));
    const combos: { p1: DclPool; p2: DclPool }[] = [];
    for (const p1 of firstLegs) {
      for (const p2 of secondLegs) combos.push({ p1, p2 });
    }
    const comboOuts = await parallelMap(combos, 8, async (c) => {
      try {
        return await quote([c.p1.poolId, c.p2.poolId], tokenIn, tokenOut, amountInRaw);
      } catch {
        return 0n;
      }
    });
    combos.forEach((c, i) => {
      consider({
        tokenIn,
        tokenOut,
        amountInRaw,
        amountOutRaw: comboOuts[i],
        poolIds: [c.p1.poolId, c.p2.poolId],
        description: `${tokenIn} -> ${mid} -> ${tokenOut} via DCL pools ${c.p1.poolId} and ${c.p2.poolId}`,
      });
    });
  }
  if (best) return best;
  throw new Error(`No DCL route from ${tokenIn} to ${tokenOut} on ${config.dclExchangeId}.`);
}

/** Build the ft_transfer_call message for a DCL swap. Pure, unit tested. */
export function dclSwapMsg(poolIds: string[], outputToken: string, minOutputAmountRaw: bigint): string {
  return JSON.stringify({
    Swap: {
      pool_ids: poolIds,
      output_token: outputToken,
      min_output_amount: minOutputAmountRaw.toString(),
    },
  });
}
