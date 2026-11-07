import { config } from "./config";
import { getFtMetadata } from "./near";
import { scanPools } from "./ref";
import { scanDclPools } from "./dcl";
import { tokenRegistry, type TradedToken } from "./store";

/**
 * Watcher token discovery.
 *
 * The watcher can only diff balances for tokens it knows about. The
 * known set is the union of:
 * - the registry (configured KNOWN_TOKENS plus every token any user has
 *   traded through the bot), and
 * - every token that appears in a simple pool or a DCL pool paired with
 *   wNEAR or with a registry token, on the configured exchanges.
 *
 * That second half is what makes a watched trader moving a launchpad
 * token the bot has never traded show up in alerts and holdings.
 *
 * The discovered set is cached for WATCH_DISCOVERY_TTL_SECS so polling
 * stays light: pool scans are cached underneath as well, and metadata
 * for a newly seen token is fetched once and cached by the chain layer.
 * The set is capped at WATCH_DISCOVERY_MAX tokens, strongest pools
 * first, so a poll never fans out into thousands of balance calls.
 */

let discoveryCache: { at: number; tokens: TradedToken[] } | undefined;

async function withMetadata(id: string): Promise<TradedToken | undefined> {
  const meta = await getFtMetadata(id).catch(() => undefined);
  if (!meta) return undefined;
  return { id, symbol: meta.symbol.toUpperCase(), decimals: meta.decimals };
}

export async function watchTokenSet(): Promise<TradedToken[]> {
  if (discoveryCache && Date.now() - discoveryCache.at < config.watchDiscoveryTtlSecs * 1000) {
    return discoveryCache.tokens;
  }
  const byId = new Map<string, TradedToken>();
  for (const t of tokenRegistry()) byId.set(t.id, t);
  const anchors = new Set<string>(byId.keys());
  const max = Math.max(byId.size, config.watchDiscoveryMax);

  const candidates = new Map<string, bigint>();
  const offer = (id: string, score: bigint) => {
    if (byId.has(id)) return;
    const prev = candidates.get(id);
    if (prev === undefined || score > prev) candidates.set(id, score);
  };

  // Simple pools paired with an anchor token.
  const simplePools = await scanPools().catch(() => []);
  for (const pool of simplePools) {
    pool.tokenIds.forEach((tokenId, i) => {
      if (!anchors.has(tokenId)) return;
      for (const other of pool.tokenIds) {
        if (other !== tokenId) offer(other, pool.amountsRaw[i] ?? 0n);
      }
    });
  }

  // DCL pools paired with an anchor token, ranked by pool liquidity.
  const dclPools = await scanDclPools().catch(() => []);
  for (const pool of dclPools) {
    if (pool.liquidity <= 0n) continue;
    if (anchors.has(pool.tokenX)) offer(pool.tokenY, pool.liquidity);
    if (anchors.has(pool.tokenY)) offer(pool.tokenX, pool.liquidity);
  }

  const ranked = [...candidates.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  for (const [id] of ranked) {
    if (byId.size >= max) break;
    const token = await withMetadata(id);
    if (token) byId.set(id, token);
  }

  const tokens = [...byId.values()];
  discoveryCache = { at: Date.now(), tokens };
  return tokens;
}
