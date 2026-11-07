import { config } from "./config";
import { getFtMetadata } from "./near";
import { findRoute } from "./ref";

/**
 * Pricing comes from the Rhea pools themselves: a price is what the
 * exchange get_return view says a swap would actually pay. No mirrored
 * prices like Forge needed, NEAR has a live market.
 * DEXScreener is used only as a display fallback for market cap figures
 * on share cards, and only ever on mainnet token ids.
 */

interface CacheEntry {
  at: number;
  value: number;
}

const priceCache = new Map<string, CacheEntry>();
const ttlMs = () => config.priceTtlSecs * 1000;

export async function tokenDecimals(tokenId: string): Promise<number> {
  const known = config.knownTokens.find((t) => t.id === tokenId);
  if (known) return known.decimals;
  for (const c of config.payCurrencies) {
    if (c.contractId === tokenId) return c.decimals;
  }
  const meta = await getFtMetadata(tokenId);
  if (!meta) throw new Error(`Could not read metadata for token ${tokenId}. Is the contract id right?`);
  return meta.decimals;
}

/** Live price of one whole token, in NEAR, quoted by selling one token into wNEAR. */
export async function getTokenPriceNear(tokenId: string): Promise<number> {
  if (tokenId === config.wnearId) return 1;
  const cached = priceCache.get(tokenId);
  if (cached && Date.now() - cached.at < ttlMs()) return cached.value;
  const decimals = await tokenDecimals(tokenId);
  const oneTokenRaw = 10n ** BigInt(decimals);
  const route = await findRoute(tokenId, config.wnearId, oneTokenRaw);
  const price = Number(route.amountOutRaw) / 1e24;
  if (!(price > 0)) throw new Error(`Pool quote for ${tokenId} came back at zero.`);
  priceCache.set(tokenId, { at: Date.now(), value: price });
  return price;
}

/** NEAR value of a fungible token amount, quoted through the pools at trade size. */
export async function getNearValueOfFt(contractId: string, amountHuman: number, decimals: number): Promise<number> {
  if (contractId === config.wnearId) return amountHuman;
  const raw = BigInt(Math.round(amountHuman * 10 ** decimals));
  if (raw <= 0n) return 0;
  const route = await findRoute(contractId, config.wnearId, raw);
  return Number(route.amountOutRaw) / 1e24;
}

// ---------------------------------------------------------------------------
// DEXScreener display fallback (share card market caps only)
// ---------------------------------------------------------------------------

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": "velocity-trade-bot/0.1" } });
  if (!res.ok) throw new Error(`DEXScreener ${res.status} for ${url}`);
  return res.json();
}

const mcCache = new Map<string, CacheEntry>();

/** Market cap in USD for a token contract id, or undefined when unavailable. Never used for trade pricing. */
export async function getTokenMarketCapUsd(contractId: string): Promise<number | undefined> {
  if (config.network !== "mainnet") return undefined; // testnet token ids are not listed
  const cached = mcCache.get(contractId);
  if (cached && Date.now() - cached.at < ttlMs()) return cached.value;
  try {
    const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${contractId}`);
    const pair = (json?.pairs ?? [])[0] as any;
    const mc = Number(pair?.marketCap ?? pair?.fdv);
    if (!Number.isFinite(mc) || mc <= 0) return undefined;
    mcCache.set(contractId, { at: Date.now(), value: mc });
    return mc;
  } catch {
    return undefined;
  }
}

/** USD price of a token contract id via DEXScreener, display only. */
export async function getTokenUsdDex(contractId: string): Promise<number | undefined> {
  if (config.network !== "mainnet") return undefined;
  try {
    const json = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${contractId}`);
    const price = Number(json?.pairs?.[0]?.priceUsd);
    return Number.isFinite(price) && price > 0 ? price : undefined;
  } catch {
    return undefined;
  }
}

/** NEAR price in USD via DEXScreener, display only. */
export async function getNearUsd(): Promise<number | undefined> {
  try {
    const json = await fetchJson(`https://api.dexscreener.com/latest/dex/search?q=NEAR`);
    const pairs = (json?.pairs ?? []) as any[];
    const near = pairs.find((p) => p?.baseToken?.symbol === "NEAR" && Number(p?.priceUsd) > 0) ?? pairs[0];
    const price = Number(near?.priceUsd);
    return Number.isFinite(price) && price > 0 ? price : undefined;
  } catch {
    return undefined;
  }
}
