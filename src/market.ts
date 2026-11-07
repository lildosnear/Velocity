import { config, getPayCurrency, payCurrencyTokenId } from "./config";
import { decryptPrivateKey, type EncryptedKey } from "./crypto";
import { store, type TradedToken, type UserRecord } from "./store";
import {
  ensureFtStorage,
  getFtMetadata,
  readFtBalanceRaw,
  readNearBalanceYocto,
  transferFt,
  transferNear,
  unwrapNear,
  wrapNear,
  callFunction,
  viewFunction,
  GAS,
  type WalletCreds,
} from "./near";
import { applySlippage, findRoute, type PoolKind, type RouteQuote } from "./ref";
import { dclSwapMsg } from "./dcl";
import { getNearValueOfFt, getTokenPriceNear, tokenDecimals } from "./prices";

/**
 * The Velocity market layer. Forge was its own market maker because Arch
 * had no live market. Velocity routes every trade through Rhea instead:
 * a quote is what the exchange views say across simple pools and DCL
 * pools, and settlement is one swap through ft_transfer_call to
 * whichever exchange quoted better.
 *
 * Fees: a flat bot fee (BOT_FEE_BPS, default 100 = 1 percent) on the NEAR
 * value of each successful swap, charged from the leg the user controls:
 * buys deduct it from the amount paid in, sells deduct it from the amount
 * paid out. The fee moves on chain to the fee wallet (scripts/make-fee-wallet).
 * When no fee wallet is configured the fee is skipped cleanly with a log
 * line, the full amount trades, and no referral credit accrues, because no
 * fee was captured. One behaviour, stated everywhere it matters.
 */

export function toRaw(amount: number, decimals: number): bigint {
  if (!(amount > 0)) return 0n;
  // Round through a 12 place decimal string first: amounts typed by users
  // never carry more precision than that, and it stops binary float noise
  // (0.1 stored as 0.1000000000000000055...) leaking into yocto amounts.
  const places = Math.min(decimals, 12);
  const fixed = amount.toFixed(places);
  const [whole, frac = ""] = fixed.split(".");
  return BigInt(whole + frac.padEnd(decimals, "0").slice(0, decimals));
}

export function fromRaw(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

// ---------------------------------------------------------------------------
// Referral and fee math (ported from Forge, spread becomes the flat fee)
// ---------------------------------------------------------------------------

/** The friend gets the fee discount only for their first REFERRAL_TRADE_LIMIT manual trades. */
export function discountApplies(user: UserRecord): boolean {
  return (
    config.referralEnabled &&
    user.referredBy != null &&
    (user.refTradeCount ?? 0) < config.referralTradeLimit
  );
}

/** The referrer's cut applies to all of the friend's manual trades, forever. */
export function creditApplies(user: UserRecord): boolean {
  return config.referralEnabled && user.referredBy != null;
}

/** Bot fee in bps for this user's next manual trade (discounted while eligible). */
export function effectiveFeeBps(user: UserRecord): number {
  if (!discountApplies(user)) return config.botFeeBps;
  return Math.round(config.botFeeBps * (1 - config.refereeDiscountPct / 100));
}

/** Fee in NEAR for a trade of the given NEAR value at the given bps. Pure, unit tested. */
export function feeForTrade(nearValue: number, feeBps: number): number {
  return (nearValue * feeBps) / 10_000;
}

/** The referrer's lifetime cut of a captured fee. Pure, unit tested. */
export function referrerCut(feeNear: number): number {
  return feeNear * (config.referrerBonusPct / 100);
}

/**
 * Credit the referrer their lifetime bonus from a captured fee and count
 * the trade against the friend's discount limit. Call once per manual
 * trade, never for AI copy trades.
 */
export function creditReferrer(user: UserRecord, feeNear: number): void {
  const referrerId = user.referredBy;
  if (referrerId == null) return;
  const earned = referrerCut(feeNear);
  const referrer = store.getUser(referrerId);
  if (referrer && earned > 0) {
    referrer.referralEarnedNear = (referrer.referralEarnedNear ?? 0) + earned;
    store.saveUser(referrer);
  }
  user.refTradeCount = (user.refTradeCount ?? 0) + 1;
  store.saveUser(user);
}

// ---------------------------------------------------------------------------
// Fee wallet
// ---------------------------------------------------------------------------

export interface FeeWallet {
  accountId: string;
  /** present only when the operator gave the bot the fee wallet key (needed to pay referral withdrawals) */
  secret?: string;
}

export function getFeeWallet(): FeeWallet | undefined {
  if (!config.feeAccountId) return undefined;
  let secret: string | undefined;
  if (config.feeAccountSecretEnc) {
    try {
      secret = decryptPrivateKey(JSON.parse(config.feeAccountSecretEnc) as EncryptedKey);
    } catch {
      console.error("FEE_ACCOUNT_SECRET_ENC could not be decrypted, referral payouts disabled.");
    }
  }
  return { accountId: config.feeAccountId, secret };
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/** Resolve a user typed token ref (symbol or contract account id) to a tradable token. */
export async function resolveToken(ref: string): Promise<TradedToken> {
  const lower = ref.toLowerCase().trim();
  const known = config.knownTokens.find((t) => t.id === lower || t.symbol.toLowerCase() === lower);
  if (known) return { id: known.id, symbol: known.symbol, decimals: known.decimals };
  const looksLikeAccount = /^[a-z0-9._-]+$/.test(lower) && (lower.includes(".") || /^[0-9a-f]{64}$/.test(lower));
  if (!looksLikeAccount) throw new Error(`Unknown token "${ref}". Use /tokens to list, or paste a token contract account id.`);
  const meta = await getFtMetadata(lower);
  if (!meta) throw new Error(`No fungible token found at ${lower}. Check the contract account id.`);
  return { id: lower, symbol: meta.symbol.toUpperCase(), decimals: meta.decimals };
}

// ---------------------------------------------------------------------------
// Swap core (used by manual trades and by the AI copy engine)
// ---------------------------------------------------------------------------

export interface SwapResult {
  tokenId: string;
  symbol: string;
  side: "buy" | "sell";
  /** buy: total spent gross of fee. sell: total received net of fee. Human units of the pay currency. */
  payAmount: number;
  payCurrency: string;
  /** NEAR value of the swap itself, gross of fee */
  nearValue: number;
  tokenAmount: number;
  /** NEAR per token at the executed price */
  priceNear: number;
  /** fee actually charged, in NEAR value terms (0 when the fee was skipped) */
  feeNear: number;
  /** which pool kind filled the swap (absent for a plain wrap or unwrap) */
  poolKind?: PoolKind;
  /** human readable route that filled the swap */
  route?: string;
  txids: string[];
}

/**
 * Make sure the wallet has a funded internal account on the Ref
 * exchange. The exchange registers accounts behind a storage deposit
 * (minimum 0.00084 NEAR on testnet, read from the contract bounds) and
 * requires a NEAR storage balance inside the account before it accepts
 * token deposits, so the bot tops the account up to 0.01 NEAR once.
 * That deposit stays the user's, held by the exchange as their storage
 * balance, the standard Ref behaviour for every trader on it.
 */
async function ensureExchangeAccount(creds: WalletCreds): Promise<void> {
  const target = 10n ** 22n; // 0.01 NEAR
  const existing = await viewFunction<{ total: string } | null>(config.refExchangeId, "storage_balance_of", {
    account_id: creds.accountId,
  }).catch(() => null);
  const total = existing ? BigInt(existing.total) : 0n;
  if (total >= target) return;
  await callFunction(creds, config.refExchangeId, "storage_deposit", {
    account_id: creds.accountId,
    registration_only: false,
  }, target - total, GAS.T100);
}

/** Internal exchange balance of one token for the wallet, raw units. */
async function exchangeDeposit(creds: WalletCreds, tokenId: string): Promise<bigint> {
  const dep = await viewFunction<string>(config.refExchangeId, "get_deposit", {
    account_id: creds.accountId,
    token_id: tokenId,
  }).catch(() => undefined);
  return dep ? BigInt(dep) : 0n;
}

/**
 * The operator's trading switch (TRADING_ENABLED). Every execution
 * path funnels through swapBuy and swapSell below (manual commands,
 * trader alert buttons and the AI copy engine alike), so this one
 * check pauses all trading while balances, watch lists and info
 * commands keep working.
 */
export function assertTradingEnabled(): void {
  if (!config.tradingEnabled) {
    throw new Error("Trading is paused right now. Balances, watch lists and info commands still work.");
  }
}

/**
 * Execute a quoted route. DCL routes are one ft_transfer_call on the
 * input token to the DCL exchange with the Swap message and the
 * slippage floor applied to the quoted output.
 *
 * No storage deposit is made on the DCL exchange before a swap, for a
 * verified reason: a live mainnet trace on 2026-11-07 (transaction
 * EcQntbawww1C3sxzme3PPPkibTzn3V2p4CboXJMjCFry) shows a swapper whose
 * storage_balance_of on dclv2.ref-labs.near is null completing a swap
 * and receiving the output directly, with the unused part of the input
 * refunded automatically by the token contract's resolve transfer.
 * The DCL exchange only needs a registered internal account (bounds
 * minimum 0.5 NEAR) for its other features, which aggregators use;
 * plain swaps do not. An earlier version of this code deposited the
 * bounds minimum before a first DCL swap, which on mainnet would
 * have taken 0.5 NEAR out of a user wallet for no reason.
 *
 * Simple routes use the deposit, swap, withdraw flow on the Ref
 * exchange, for a verified reason: the live testnet exchange rejects
 * instant swap transfer messages (ERR_MSG_WRONG_FORMAT, checked with
 * six message variants on 2026-11-06, every attempt refunded), while
 * the deposit flow is the exchange's original settlement path and was
 * proven live the same day (deposit, swap and withdraw hashes in the
 * README live proof section). The fee and referral handling around
 * this call is identical for both kinds.
 */
async function executeRoutedSwap(
  creds: WalletCreds,
  route: RouteQuote,
  inputTokenId: string,
  amountRaw: bigint,
  referralId?: string,
): Promise<string[]> {
  if (route.kind === "dcl") {
    const tx = await callFunction(creds, inputTokenId, "ft_transfer_call", {
      receiver_id: config.dclExchangeId,
      amount: amountRaw.toString(),
      memo: "Velocity swap",
      msg: dclSwapMsg(route.dclPoolIds, route.tokenOut, applySlippage(route.amountOutRaw, config.slippageBps)),
    }, GAS.ONE_YOCTO);
    return [tx];
  }

  await ensureExchangeAccount(creds);
  const txids: string[] = [];
  // These calls run at 100 TGas, proven live for this flow: at 300 TGas
  // the signer balance check reserves prepaid gas at the current gas
  // price, which on testnet can exceed a small wallet balance and block
  // the trade before it starts.
  txids.push(
    await callFunction(creds, inputTokenId, "ft_transfer_call", {
      receiver_id: config.refExchangeId,
      amount: amountRaw.toString(),
      memo: "Velocity deposit",
      msg: "",
    }, GAS.ONE_YOCTO, GAS.T100),
  );
  const internalBefore = await exchangeDeposit(creds, route.tokenOut);
  txids.push(
    await callFunction(creds, config.refExchangeId, "swap", {
      actions: route.actions,
      referral_id: referralId ?? null,
    }, GAS.ONE_YOCTO, GAS.T100),
  );
  const internalAfter = await exchangeDeposit(creds, route.tokenOut);
  const gained = internalAfter - internalBefore;
  if (gained <= 0n) {
    throw new Error("The exchange swap landed but no output reached the internal account. Check the transaction before retrying.");
  }
  txids.push(
    await callFunction(creds, config.refExchangeId, "withdraw", {
      token_id: route.tokenOut,
      amount: gained.toString(),
      unregister: false,
    }, GAS.ONE_YOCTO, GAS.T100),
  );
  return txids;
}

function userCreds(user: UserRecord): WalletCreds {
  return { accountId: user.accountId, secret: decryptPrivateKey(user.encSecret) };
}

export function credsOf(user: UserRecord): WalletCreds {
  return userCreds(user);
}

/** Balance of a wallet in a pay currency, human units. */
export async function payBalance(creds: WalletCreds, currencyId: string): Promise<number> {
  const currency = getPayCurrency(currencyId);
  if (currency.kind === "native") return Number(await readNearBalanceYocto(creds.accountId)) / 1e24;
  const tokenId = payCurrencyTokenId(currencyId);
  return fromRaw(await readFtBalanceRaw(tokenId, creds.accountId), currency.decimals);
}

async function nearValueOfPay(payTokenId: string, payAmountHuman: number, payDecimals: number, token: TradedToken, tokenAmount: number): Promise<number> {
  try {
    return await getNearValueOfFt(payTokenId, payAmountHuman, payDecimals);
  } catch {
    try {
      return tokenAmount * (await getTokenPriceNear(token.id));
    } catch {
      return 0;
    }
  }
}

/** Buy a token, paying payAmount of the pay currency. Fee bps is supplied by the caller (manual trades pass the referral aware rate, AI trades pass the full rate and get no referral handling). */
export async function swapBuy(
  creds: WalletCreds,
  token: TradedToken,
  payAmount: number,
  payCurrencyId: string,
  feeBps: number,
): Promise<SwapResult> {
  assertTradingEnabled();
  const currency = getPayCurrency(payCurrencyId);
  const payTokenId = payCurrencyTokenId(payCurrencyId);
  if (token.id === payTokenId && currency.kind !== "native") {
    throw new Error(`You cannot buy ${token.symbol} with ${currency.id}, it is the same token.`);
  }
  const feeWallet = getFeeWallet();
  const chargeFee = feeWallet != null && feeBps > 0;
  if (!chargeFee && feeBps > 0) console.log("fee skipped: no fee wallet configured (FEE_ACCOUNT_ID).");
  const txids: string[] = [];

  // Degenerate and delightful case: buying wNEAR with NEAR is just a wrap.
  if (token.id === config.wnearId && currency.kind === "native") {
    const gross = toRaw(payAmount, 24);
    const balance = await readNearBalanceYocto(creds.accountId);
    if (balance < gross) throw new Error(`Insufficient NEAR (have ${Number(balance) / 1e24}, need ${payAmount}, plus a little for gas). Use /deposit.`);
    const feeRaw = chargeFee ? (gross * BigInt(feeBps)) / 10_000n : 0n;
    txids.push(await wrapNear(creds, gross - feeRaw));
    if (feeRaw > 0n) txids.push(await transferNear(creds, feeWallet!.accountId, feeRaw));
    const feeNear = fromRaw(feeRaw, 24);
    return {
      tokenId: token.id, symbol: token.symbol, side: "buy",
      payAmount, payCurrency: currency.id, nearValue: payAmount,
      tokenAmount: payAmount - feeNear, priceNear: 1, feeNear, txids,
    };
  }

  await ensureFtStorage(creds, token.id);

  let swapInRaw: bigint;
  let grossRaw: bigint;
  let inputIsNear = false;

  if (currency.kind === "native") {
    inputIsNear = true;
    grossRaw = toRaw(payAmount, 24);
    const balance = await readNearBalanceYocto(creds.accountId);
    if (balance < grossRaw) {
      throw new Error(`Insufficient NEAR (have ${Number(balance) / 1e24}, need ${payAmount}, plus a little for gas). Use /deposit.`);
    }
    const feeRaw = chargeFee ? (grossRaw * BigInt(feeBps)) / 10_000n : 0n;
    swapInRaw = grossRaw - feeRaw;
    txids.push(await wrapNear(creds, swapInRaw));
    if (feeRaw > 0n) txids.push(await transferNear(creds, feeWallet!.accountId, feeRaw));
  } else {
    grossRaw = toRaw(payAmount, currency.decimals);
    const balance = await readFtBalanceRaw(payTokenId, creds.accountId);
    if (balance < grossRaw) {
      throw new Error(`Insufficient ${currency.id} (have ${fromRaw(balance, currency.decimals)}, need ${payAmount}). Use /deposit.`);
    }
    const feeRaw = chargeFee ? (grossRaw * BigInt(feeBps)) / 10_000n : 0n;
    swapInRaw = grossRaw - feeRaw;
    if (feeRaw > 0n) txids.push(await transferFt(creds, payTokenId, feeWallet!.accountId, feeRaw, "Velocity fee"));
  }

  const route = await findRoute(payTokenId, token.id, swapInRaw);
  const before = await readFtBalanceRaw(token.id, creds.accountId);
  txids.push(...(await executeRoutedSwap(creds, route, payTokenId, swapInRaw, feeWallet?.accountId)));
  const after = await readFtBalanceRaw(token.id, creds.accountId);
  const receivedRaw = after - before;
  if (receivedRaw <= 0n) {
    throw new Error("The swap landed but no tokens arrived. The pool may have refunded the trade, check the transaction before retrying.");
  }
  const tokenAmount = fromRaw(receivedRaw, token.decimals);
  const nearValue = inputIsNear
    ? payAmount
    : await nearValueOfPay(payTokenId, payAmount, currency.decimals, token, tokenAmount);
  const feeNear = inputIsNear
    ? feeForTrade(payAmount, chargeFee ? feeBps : 0)
    : feeForTrade(nearValue, chargeFee ? feeBps : 0);
  void grossRaw;
  return {
    tokenId: token.id, symbol: token.symbol, side: "buy",
    payAmount, payCurrency: currency.id, nearValue,
    tokenAmount, priceNear: tokenAmount > 0 ? nearValue / tokenAmount : 0, feeNear,
    poolKind: route.kind, route: route.description, txids,
  };
}

/** Sell tokenAmount of a token, paid out in the pay currency. */
export async function swapSell(
  creds: WalletCreds,
  token: TradedToken,
  tokenAmount: number,
  payCurrencyId: string,
  feeBps: number,
): Promise<SwapResult> {
  assertTradingEnabled();
  const currency = getPayCurrency(payCurrencyId);
  const payTokenId = payCurrencyTokenId(payCurrencyId);
  if (token.id === payTokenId && currency.kind !== "native") {
    throw new Error(`You cannot sell ${token.symbol} for ${currency.id}, it is the same token.`);
  }
  const feeWallet = getFeeWallet();
  const chargeFee = feeWallet != null && feeBps > 0;
  if (!chargeFee && feeBps > 0) console.log("fee skipped: no fee wallet configured (FEE_ACCOUNT_ID).");
  const txids: string[] = [];

  const amountRaw = toRaw(tokenAmount, token.decimals);
  const held = await readFtBalanceRaw(token.id, creds.accountId);
  if (held < amountRaw) {
    throw new Error(`Insufficient ${token.symbol} (have ${fromRaw(held, token.decimals)}, need ${tokenAmount}).`);
  }

  // Selling wNEAR for NEAR is just an unwrap.
  if (token.id === config.wnearId && currency.kind === "native") {
    txids.push(await unwrapNear(creds, amountRaw));
    const feeRaw = chargeFee ? (amountRaw * BigInt(feeBps)) / 10_000n : 0n;
    if (feeRaw > 0n) txids.push(await transferNear(creds, feeWallet!.accountId, feeRaw));
    const feeNear = fromRaw(feeRaw, 24);
    return {
      tokenId: token.id, symbol: token.symbol, side: "sell",
      payAmount: tokenAmount - feeNear, payCurrency: currency.id, nearValue: tokenAmount,
      tokenAmount, priceNear: 1, feeNear, txids,
    };
  }

  await ensureFtStorage(creds, payTokenId);
  const route = await findRoute(token.id, payTokenId, amountRaw);
  const before = await readFtBalanceRaw(payTokenId, creds.accountId);
  txids.push(...(await executeRoutedSwap(creds, route, token.id, amountRaw, feeWallet?.accountId)));
  const after = await readFtBalanceRaw(payTokenId, creds.accountId);
  const receivedRaw = after - before;
  if (receivedRaw <= 0n) {
    throw new Error("The swap landed but no payout arrived. The pool may have refunded the trade, check the transaction before retrying.");
  }

  const feeRaw = chargeFee ? (receivedRaw * BigInt(feeBps)) / 10_000n : 0n;
  let netRaw = receivedRaw;
  if (feeRaw > 0n && currency.kind === "native") {
    // Payout arrived as wNEAR: send the fee on as wNEAR, unwrap the rest.
    txids.push(await transferFt(creds, config.wnearId, feeWallet!.accountId, feeRaw, "Velocity fee"));
    netRaw = receivedRaw - feeRaw;
    txids.push(await unwrapNear(creds, netRaw));
  } else if (feeRaw > 0n) {
    txids.push(await transferFt(creds, payTokenId, feeWallet!.accountId, feeRaw, "Velocity fee"));
    netRaw = receivedRaw - feeRaw;
  } else if (currency.kind === "native") {
    txids.push(await unwrapNear(creds, netRaw));
  }

  const grossReceived = fromRaw(receivedRaw, currency.decimals);
  const payAmount = fromRaw(netRaw, currency.decimals);
  const nearValue =
    currency.kind === "native"
      ? grossReceived
      : await nearValueOfPay(payTokenId, grossReceived, currency.decimals, token, tokenAmount);
  const feeNear = feeForTrade(nearValue, chargeFee ? feeBps : 0);
  return {
    tokenId: token.id, symbol: token.symbol, side: "sell",
    payAmount, payCurrency: currency.id, nearValue,
    tokenAmount, priceNear: tokenAmount > 0 ? nearValue / tokenAmount : 0, feeNear,
    poolKind: route.kind, route: route.description, txids,
  };
}

// ---------------------------------------------------------------------------
// Manual trades (referral aware wrappers, Forge executeBuy / executeSell)
// ---------------------------------------------------------------------------

function rememberToken(user: UserRecord, token: TradedToken): void {
  user.tokens[token.id] = token;
  store.saveUser(user);
}

export async function executeBuy(
  user: UserRecord,
  tokenRef: string,
  payAmount: number,
  payCurrencyId: string,
): Promise<SwapResult> {
  assertTradingEnabled();
  const token = await resolveToken(tokenRef);
  if (!(payAmount > 0)) throw new Error("Amount must be positive.");
  const currency = getPayCurrency(payCurrencyId);
  if (currency.kind === "native" && payAmount > config.maxTradeNear) {
    throw new Error(`Max single trade is ${config.maxTradeNear} NEAR.`);
  }
  if (currency.kind === "ft") {
    const est = await nearValueOfPay(payCurrencyTokenId(currency.id), payAmount, currency.decimals, token, 0).catch(() => 0);
    if (est > config.maxTradeNear) throw new Error(`That trade is worth about ${est.toFixed(2)} NEAR, over the per trade cap of ${config.maxTradeNear} NEAR.`);
  }
  const feeBps = effectiveFeeBps(user);
  const result = await swapBuy(credsOf(user), token, payAmount, currency.id, feeBps);
  rememberToken(user, token);
  store.logTrade({
    at: new Date().toISOString(), telegramId: user.telegramId, side: "buy",
    tokenId: token.id, symbol: token.symbol, payAmount: result.payAmount,
    payCurrency: currency.id, nearValue: result.nearValue, tokenAmount: result.tokenAmount,
    priceNear: result.priceNear, feeNear: result.feeNear, poolKind: result.poolKind, txids: result.txids,
  });
  if (creditApplies(user)) creditReferrer(user, result.feeNear);
  return result;
}

export async function executeSell(
  user: UserRecord,
  tokenRef: string,
  tokenAmount: number,
  payCurrencyId: string,
): Promise<SwapResult> {
  assertTradingEnabled();
  const token = await resolveToken(tokenRef);
  if (!(tokenAmount > 0)) throw new Error("Amount must be positive.");
  const currency = getPayCurrency(payCurrencyId);
  const price = await getTokenPriceNear(token.id).catch(() => 0);
  if (price * tokenAmount > config.maxTradeNear) {
    throw new Error(`That sale is worth about ${(price * tokenAmount).toFixed(2)} NEAR, over the per trade cap of ${config.maxTradeNear} NEAR.`);
  }
  const feeBps = effectiveFeeBps(user);
  const result = await swapSell(credsOf(user), token, tokenAmount, currency.id, feeBps);
  rememberToken(user, token);
  store.logTrade({
    at: new Date().toISOString(), telegramId: user.telegramId, side: "sell",
    tokenId: token.id, symbol: token.symbol, payAmount: result.payAmount,
    payCurrency: currency.id, nearValue: result.nearValue, tokenAmount: result.tokenAmount,
    priceNear: result.priceNear, feeNear: result.feeNear, poolKind: result.poolKind, txids: result.txids,
  });
  if (creditApplies(user)) creditReferrer(user, result.feeNear);
  return result;
}
