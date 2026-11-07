import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import type { EncryptedKey } from "./crypto";

/**
 * Store: a single JSON file, same shape as the Forge store.
 * Secret keys are stored ONLY in encrypted form (see crypto.ts).
 * Nothing here ever logs a key.
 * Token holdings are read live on chain, so unlike Forge there are no
 * paper balances: the store keeps the list of tokens each user has traded
 * so balances and positions can be enumerated.
 */

export interface TradedToken {
  /** fungible token contract account id */
  id: string;
  symbol: string;
  decimals: number;
}

export interface UserRecord {
  telegramId: number;
  username?: string;
  /** NEAR account id of the hot wallet (implicit hex id, or a named account) */
  accountId: string;
  /** encrypted NEAR secret key ("ed25519:...") */
  encSecret: EncryptedKey;
  /** which currency the user pays with: "NEAR", "USDC" or "USDT" */
  payCurrency: string;
  /** tokens this user has traded, by contract id */
  tokens: Record<string, TradedToken>;
  /** telegramId of the referrer, set once when a new user joins via a referral link */
  referredBy?: number;
  /** how many of this user's manual trades counted toward the referral program */
  refTradeCount?: number;
  /** NEAR earned as a referrer, withdrawable via /ref withdraw */
  referralEarnedNear?: number;
  ai?: AiConfig;
  createdAt: string;
}

export interface TradeRecord {
  at: string;
  telegramId: number;
  side: "buy" | "sell";
  /** token contract account id */
  tokenId: string;
  symbol: string;
  /** total paid (buy) or received (sell), in the pay currency, human units */
  payAmount: number;
  payCurrency: string;
  /** the same trade valued in NEAR at the trade price (reporting and PnL basis) */
  nearValue: number;
  tokenAmount: number;
  /** price in NEAR per token */
  priceNear: number;
  /** bot fee actually charged on this trade, in NEAR value terms */
  feeNear: number;
  /** which pool kind filled the trade, when a pool filled it */
  poolKind?: "simple" | "dcl";
  viaAi?: boolean;
  txids: string[];
}

export interface PendingSettlement {
  at: string;
  telegramId: number;
  description: string;
  txids: string[];
}

export interface WatchedWallet {
  id: string;
  ownerTelegramId: number;
  /** NEAR account id being watched */
  accountId: string;
  mode: "notify" | "auto";
  createdAt: string;
}

export interface CopyPosition {
  tokenId: string;
  symbol: string;
  amount: number;
  entryPriceNear: number;
  /** pay currency the position was opened in, sells pay out in the same currency */
  payCurrency: string;
  watchedWalletId: string;
  openedAt: string;
}

export interface AiConfig {
  enabled: boolean;
  /** NEAR account id of the separate AI wallet */
  accountId: string;
  encSecret: EncryptedKey;
  /** per trade size, denominated in the user's current pay currency */
  perTradeAmount: number;
  /** daily loss limit in NEAR, AI pauses when hit */
  dailyLossLimitNear?: number;
  /** optional stop loss, e.g. 0.6 = close at 60 percent down */
  stopLossPct?: number;
  /** ISO timestamp until which auto mode is paused (daily limit hit) */
  pausedUntil?: string;
  positions: CopyPosition[];
  dailyPnl: { date: string; realizedNear: number };
}

interface StoreShape {
  users: Record<string, UserRecord>;
  trades: TradeRecord[];
  pendingSettlements: PendingSettlement[];
  watched: Record<string, WatchedWallet>;
}

const storePath = join(config.dataDir, "store.json");

function load(): StoreShape {
  if (!existsSync(storePath)) return { users: {}, trades: [], pendingSettlements: [], watched: {} };
  const parsed = JSON.parse(readFileSync(storePath, "utf8")) as Partial<StoreShape>;
  return {
    users: parsed.users ?? {},
    trades: parsed.trades ?? [],
    pendingSettlements: parsed.pendingSettlements ?? [],
    watched: parsed.watched ?? {},
  };
}

function save(shape: StoreShape): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(storePath, JSON.stringify(shape, null, 2), "utf8");
}

export const store = {
  getUser(telegramId: number): UserRecord | undefined {
    return load().users[String(telegramId)];
  },
  saveUser(user: UserRecord): void {
    const shape = load();
    shape.users[String(user.telegramId)] = user;
    save(shape);
  },
  logTrade(trade: TradeRecord): void {
    const shape = load();
    shape.trades.push(trade);
    save(shape);
  },
  logPending(p: PendingSettlement): void {
    const shape = load();
    shape.pendingSettlements.push(p);
    save(shape);
  },
  watch(w: WatchedWallet): void {
    const shape = load();
    shape.watched[w.id] = w;
    save(shape);
  },
  unwatch(id: string): void {
    const shape = load();
    delete shape.watched[id];
    save(shape);
  },
  listWatched(ownerTelegramId: number): WatchedWallet[] {
    return Object.values(load().watched).filter((w) => w.ownerTelegramId === ownerTelegramId);
  },
  allWatched(): WatchedWallet[] {
    return Object.values(load().watched);
  },
  allUsers(): UserRecord[] {
    return Object.values(load().users);
  },
  recentTrades(telegramId: number, n = 5): TradeRecord[] {
    return load()
      .trades.filter((t) => t.telegramId === telegramId)
      .slice(-n)
      .reverse();
  },
  /** Full trade history for a user, used for cost basis and PnL math. */
  userTrades(telegramId: number): TradeRecord[] {
    return load().trades.filter((t) => t.telegramId === telegramId);
  },
};

/** Every token worth watching or pricing: configured tokens plus anything any user has traded. */
export function tokenRegistry(): TradedToken[] {
  const byId = new Map<string, TradedToken>();
  for (const t of config.knownTokens) byId.set(t.id, { id: t.id, symbol: t.symbol, decimals: t.decimals });
  for (const u of store.allUsers()) {
    for (const t of Object.values(u.tokens ?? {})) byId.set(t.id, t);
  }
  byId.set(config.wnearId, { id: config.wnearId, symbol: "wNEAR", decimals: 24 });
  return [...byId.values()];
}
