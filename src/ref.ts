import { config } from "./config";
import { viewFunction } from "./near";
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
let scannedCount = 0;

async function fetchPoolPage(fromIndex: number, limit: number): Promise<RawPool[]> {
  const page = await viewFunction<RawPool[]>(config.refExchangeId, "get_pools", {
    from_index: fromIndex,
    limit,
  });
  return page ?? [];
}

/**
 * Scan simple pools on the exchange. Ref testnet carries a modest number
 * of pools, so a bounded scan (default 500 pools, pages of 100) is fine
 * and cached for a minute. DCL pools are scanned separately in dcl.ts.
 */
export async function scanPools(maxPools = 500): Promise<RefPool[]> {
  if (Date.now() - poolScanAt < 60_000 && scannedCount > 0) {
    return [...poolCache.values()].sort((a, b) => a.id - b.id);
  }
  poolCache.clear();
  let index = 0;
  let total = 0;
  while (total < maxPools) {
    const page = await fetchPoolPage(index, 100);
    if (page.length === 0) break;
    for (const raw of page) {
      const id = index;
      index += 1;
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
    if (page.length < 100) break;
  }
  scannedCount = total;
  poolScanAt = Date.now();
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

  for (const pool of direct) {
    try {
      const out = await getReturn(pool.id, tokenIn, tokenOut, amountInRaw);
      if (out <= 0n) continue;
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
    } catch {
      continue;
    }
  }
  if (best) return best;

  // Two hop route through wNEAR.
  const mid = config.wnearId;
  if (tokenIn !== mid && tokenOut !== mid) {
    const firstLegs = pools.filter((p) => p.tokenIds.includes(tokenIn) && p.tokenIds.includes(mid));
    const secondLegs = pools.filter((p) => p.tokenIds.includes(mid) && p.tokenIds.includes(tokenOut));
    for (const p1 of firstLegs) {
      let midOut: bigint;
      try {
        midOut = await getReturn(p1.id, tokenIn, mid, amountInRaw);
      } catch {
        continue;
      }
      if (midOut <= 0n) continue;
      for (const p2 of secondLegs) {
        try {
          const out = await getReturn(p2.id, mid, tokenOut, midOut);
          if (out <= 0n) continue;
          consider({
            tokenIn,
            tokenOut,
            amountInRaw,
            amountOutRaw: out,
            kind: "simple",
            exchangeId: config.refExchangeId,
            actions: [
              {
                pool_id: p1.id,
                token_in: tokenIn,
                token_out: mid,
                amount_in: amountInRaw.toString(),
                min_amount_out: "0",
              },
              {
                pool_id: p2.id,
                token_in: mid,
                token_out: tokenOut,
                min_amount_out: applySlippage(out, config.slippageBps).toString(),
              },
            ],
            dclPoolIds: [],
            description: `${tokenIn} -> ${mid} -> ${tokenOut} via pools ${p1.id} and ${p2.id}`,
          });
        } catch {
          continue;
        }
      }
    }
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
