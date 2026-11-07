import { config } from "./config";
import { parallelMap, viewFunction } from "./near";
import { findDclRoute } from "./dcl";

/**
 * Rhea / Ref Finance exchange reads and route finding across both pool
 * kinds. Simple pools live on the Ref exchange contract (get_pools to
 * enumerate, get_return to quote). Concentrated liquidity pools live on
 * the DCL exchange contract and are handled in dcl.ts. findRoute quotes
 * both kinds and returns whichever pays more for the exact input, so
 * callers never need to care which kind filled a trade. Everything here
 * is a view call, no signing.
 */

export interface RefPool {
  id: number;
  tokenIds: string[];
  amountsRaw: bigint[];
  totalFee: number; // in hundredths of a percent units used by the contract (fee / 10000 = fraction)
  sharesTotalSupply: bigint;
}

interface RawPool {
  token_account_ids: string[];
  amounts: string[];
  total_fee: number;
  shares_total_supply: string;
  amp?: number;
}

const poolCache = new Map<number, RefPool>();
let poolScanAt = 0;
let poolScanDone = false;
let scannedCount = 0;

/** How long a completed pool scan is reused before rescanning. */
export const POOL_SCAN_TTL_MS = 60_000;

async function fetchPoolPage(fromIndex: number, limit: number): Promise<RawPool[]> {
  const page = await viewFunction<RawPool[]>(config.refExchangeId, "get_pools", {
    from_index: fromIndex,
    limit,
  });
  return page ?? [];
}

/**
 * Scan simple pools on the exchange. The scan bound comes from config
 * and is network aware: testnet carries a modest number of pools (bound
 * 500), while mainnet held 9014 pools at the 2026-11-07 check, with
 * important pairs far past a testnet sized bound (the deep USDt pool
 * against wNEAR sits at index 6063), so the mainnet bound is 10000.
 * Pages of 100 are fetched in parallel batches of 5 and the completed
 * scan is cached for a minute, so repeat quotes and watcher ticks do
 * not rescan the exchange (a full rescan per quote used to take ~20s
 * and trip public RPC rate limits). DCL pools are scanned in dcl.ts.
 */
export async function scanPools(maxPools = config.simplePoolScanLimit): Promise<RefPool[]> {
  if (poolScanDone && Date.now() - poolScanAt < POOL_SCAN_TTL_MS) {
    return [...poolCache.values()].sort((a, b) => a.id - b.id);
  }
  poolCache.clear();
  const PAGE = 100;
  const BATCH = 5;
  let total = 0;
  let exhausted = false;
  while (total < maxPools && !exhausted) {
    const starts: number[] = [];
    for (let s = total; s < Math.min(total + PAGE * BATCH, maxPools); s += PAGE) starts.push(s);
    const pages = await parallelMap(starts, BATCH, (from) => fetchPoolPage(from, PAGE));
    for (let b = 0; b < pages.length; b++) {
      const page = pages[b];
      for (let i = 0; i < page.length; i++) {
        const raw = page[i];
        const id = starts[b] + i;
        total += 1;
        // Simple pools have exactly the plain shape; skip anything exotic.
        if (!Array.isArray(raw.token_account_ids) || !Array.isArray(raw.amounts)) continue;
        poolCache.set(id, {
          id,
          tokenIds: raw.token_account_ids,
          amountsRaw: raw.amounts.map((a) => BigInt(a)),
          totalFee: Number(raw.total_fee),
          sharesTotalSupply: BigInt(raw.shares_total_supply ?? "0"),
        });
      }
      if (page.length < PAGE) {
        exhausted = true;
        break;
      }
    }
  }
  scannedCount = total;
  poolScanAt = Date.now();
  poolScanDone = true;
  return [...poolCache.values()].sort((a, b) => a.id - b.id);
}

export async function getPool(poolId: number): Promise<RefPool | undefined> {
  const cached = poolCache.get(poolId);
  if (cached) return cached;
  const raw = await viewFunction<RawPool>(config.refExchangeId, "get_pool", { pool_id: poolId });
  if (!raw) return undefined;
  const pool: RefPool = {
    id: poolId,
    tokenIds: raw.token_account_ids,
    amountsRaw: raw.amounts.map((a) => BigInt(a)),
    totalFee: Number(raw.total_fee),
    sharesTotalSupply: BigInt(raw.shares_total_supply ?? "0"),
  };
  poolCache.set(poolId, pool);
  return pool;
}

export interface SwapAction {
  pool_id: number;
  token_in: string;
  token_out: string;
  amount_in?: string;
  amount_out?: string;
  min_amount_out: string;
}

export type PoolKind = "simple" | "dcl";

export interface RouteQuote {
  tokenIn: string;
  tokenOut: string;
  amountInRaw: bigint;
  amountOutRaw: bigint;
  /** which pool kind quoted this route */
  kind: PoolKind;
  /** the exchange contract the swap must be sent to */
  exchangeId: string;
  /** simple pools only: actions ready to embed in the instant swap message; later actions chain off the previous output */
  actions: SwapAction[];
  /** DCL only: pool ids ready to embed in the DCL swap message */
  dclPoolIds: string[];
  /** human readable route, e.g. "wNEAR -> token.testnet" */
  description: string;
}

/** Pick the route that pays the most for the same input. Pure, unit tested. */
export function selectBestRoute(routes: RouteQuote[]): RouteQuote | undefined {
  let best: RouteQuote | undefined;
  for (const r of routes) {
    if (r.amountOutRaw <= 0n) continue;
    if (!best || r.amountOutRaw > best.amountOutRaw) best = r;
  }
  return best;
}

/** Quote one pool hop through the contract itself (source of truth for pricing). */
export async function getReturn(poolId: number, tokenIn: string, tokenOut: string, amountInRaw: bigint): Promise<bigint> {
  const out = await viewFunction<string>(config.refExchangeId, "get_return", {
    pool_id: poolId,
    token_in: tokenIn,
    token_out: tokenOut,
    amount_in: amountInRaw.toString(),
  });
  if (out === undefined) throw new Error(`get_return failed for pool ${poolId}.`);
  return BigInt(out);
}

export function applySlippage(amountRaw: bigint, slippageBps: number): bigint {
  return (amountRaw * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * Find the best SIMPLE pool route from tokenIn to tokenOut for an exact
 * input amount: a direct pool, or two hops through wNEAR. Quotes come
 * from the contract get_return view, so a route is only returned when
 * the exchange itself says it can fill it. Throws when no route exists.
 */
export async function findSimpleRoute(tokenIn: string, tokenOut: string, amountInRaw: bigint): Promise<RouteQuote> {
  if (tokenIn === tokenOut) {
    return {
      tokenIn,
      tokenOut,
      amountInRaw,
      amountOutRaw: amountInRaw,
      kind: "simple",
      exchangeId: config.refExchangeId,
      actions: [],
      dclPoolIds: [],
      description: `${tokenIn} (no swap needed)`,
    };
  }
  const pools = await scanPools();
  const direct = pools.filter((p) => p.tokenIds.includes(tokenIn) && p.tokenIds.includes(tokenOut));

  let best: RouteQuote | undefined;
  const consider = (q: RouteQuote) => {
    if (!best || q.amountOutRaw > best.amountOutRaw) best = q;
  };

  // Quote every direct pool in parallel (bounded), then consider the
  // results in pool order so ties resolve exactly as the sequential
  // version did: first pool with the best output wins.
  const directOuts = await parallelMap(direct, 8, async (pool) => {
    try {
      return await getReturn(pool.id, tokenIn, tokenOut, amountInRaw);
    } catch {
      return 0n;
    }
  });
  direct.forEach((pool, i) => {
    const out = directOuts[i];
    if (out <= 0n) return;
    consider({
      tokenIn,
      tokenOut,
      amountInRaw,
      amountOutRaw: out,
      kind: "simple",
      exchangeId: config.refExchangeId,
      actions: [
        {
          pool_id: pool.id,
          token_in: tokenIn,
          token_out: tokenOut,
          amount_in: amountInRaw.toString(),
          min_amount_out: applySlippage(out, config.slippageBps).toString(),
        },
      ],
      dclPoolIds: [],
      description: `${tokenIn} -> ${tokenOut} via pool ${pool.id}`,
    });
  });
  if (best) return best;

  // Two hop route through wNEAR.
  const mid = config.wnearId;
  if (tokenIn !== mid && tokenOut !== mid) {
    const firstLegs = pools.filter((p) => p.tokenIds.includes(tokenIn) && p.tokenIds.includes(mid));
    const secondLegs = pools.filter((p) => p.tokenIds.includes(mid) && p.tokenIds.includes(tokenOut));
    const midOuts = await parallelMap(firstLegs, 8, async (p1) => {
      try {
        return await getReturn(p1.id, tokenIn, mid, amountInRaw);
      } catch {
        return 0n;
      }
    });
    const combos: { p1: RefPool; p2: RefPool; midOut: bigint }[] = [];
    firstLegs.forEach((p1, i) => {
      if (midOuts[i] <= 0n) return;
      for (const p2 of secondLegs) combos.push({ p1, p2, midOut: midOuts[i] });
    });
    const comboOuts = await parallelMap(combos, 8, async (c) => {
      try {
        return await getReturn(c.p2.id, mid, tokenOut, c.midOut);
      } catch {
        return 0n;
      }
    });
    combos.forEach((c, i) => {
      const out = comboOuts[i];
      if (out <= 0n) return;
      consider({
        tokenIn,
        tokenOut,
        amountInRaw,
        amountOutRaw: out,
        kind: "simple",
        exchangeId: config.refExchangeId,
        actions: [
          {
            pool_id: c.p1.id,
            token_in: tokenIn,
            token_out: mid,
            amount_in: amountInRaw.toString(),
            min_amount_out: "0",
          },
          {
            pool_id: c.p2.id,
            token_in: mid,
            token_out: tokenOut,
            min_amount_out: applySlippage(out, config.slippageBps).toString(),
          },
        ],
        dclPoolIds: [],
        description: `${tokenIn} -> ${mid} -> ${tokenOut} via pools ${c.p1.id} and ${c.p2.id}`,
      });
    });
  }
  if (best) return best;
  throw new Error(`No simple pool route from ${tokenIn} to ${tokenOut} on ${config.refExchangeId}.`);
}

/**
 * Find the best route across BOTH pool kinds for an exact input amount.
 * Simple pools and DCL pools are quoted through their own contract
 * views and the better quote wins. Throws a plain factual error when
 * neither kind has a route.
 */
export async function findRoute(tokenIn: string, tokenOut: string, amountInRaw: bigint): Promise<RouteQuote> {
  if (tokenIn === tokenOut) return findSimpleRoute(tokenIn, tokenOut, amountInRaw);
  const candidates: RouteQuote[] = [];
  try {
    candidates.push(await findSimpleRoute(tokenIn, tokenOut, amountInRaw));
  } catch {
    // No simple route; the DCL side may still have one.
  }
  try {
    const dcl = await findDclRoute(tokenIn, tokenOut, amountInRaw);
    candidates.push({
      tokenIn,
      tokenOut,
      amountInRaw,
      amountOutRaw: dcl.amountOutRaw,
      kind: "dcl",
      exchangeId: config.dclExchangeId,
      actions: [],
      dclPoolIds: dcl.poolIds,
      description: dcl.description,
    });
  } catch {
    // No DCL route; the simple side may still have one.
  }
  const best = selectBestRoute(candidates);
  if (best) return best;
  throw new Error(
    `No route found from ${tokenIn} to ${tokenOut} across simple pools (${config.refExchangeId}) and DCL pools (${config.dclExchangeId}). ` +
      `The token may have no pool paired with a tradable asset yet, or its pools may hold no liquidity right now.`,
  );
}

/**
 * Build the ft_transfer_call message for an instant swap on Ref.
 * Kept as a utility and covered by tests: the live testnet exchange
 * rejects instant swap messages today (verified on 2026-11-06), so
 * execution settles through the deposit, swap, withdraw flow instead
 * (see executeRoutedSwap in market.ts).
 */
export function instantSwapMsg(actions: SwapAction[], referralId?: string): string {
  return JSON.stringify({
    Execute: {
      actions,
      referral_id: referralId && referralId.length > 0 ? referralId : undefined,
    },
  });
}
