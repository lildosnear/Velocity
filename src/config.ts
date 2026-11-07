import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}
function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/**
 * Pay currencies the bot accepts. NEAR is native. USDC and USDT are fungible
 * tokens (NEP 141) whose contract ids come from the environment, because
 * they differ per network and I do not hardcode contract ids from memory.
 * On testnet there is no canonical USDC or USDT, so both slots default to
 * clearly labelled placeholder contract ids (the Ref testnet fake tokens)
 * that the operator can replace. A pay currency with no contract id fails
 * plainly at runtime, never silently.
 */
export interface PayCurrency {
  id: string;
  symbol: string;
  kind: "native" | "ft";
  /** fungible token contract account id, for kind "ft" */
  contractId?: string;
  decimals: number;
}

export interface KnownToken {
  /** fungible token contract account id */
  id: string;
  symbol: string;
  decimals: number;
}

function parseKnownTokens(wnearId: string, network: string): KnownToken[] {
  const raw = process.env["KNOWN_TOKENS"];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as KnownToken[];
      return parsed.map((t) => ({
        id: String(t.id).toLowerCase(),
        symbol: String(t.symbol).toUpperCase(),
        decimals: Number(t.decimals ?? 24),
      }));
    } catch {
      throw new Error("KNOWN_TOKENS is not valid JSON (see .env.example)");
    }
  }
  // Sensible defaults: wrapped NEAR itself is always tradable by wrapping.
  void network;
  return [{ id: wnearId, symbol: "wNEAR", decimals: 24 }];
}

/**
 * Default NEAR RPC endpoints, in failover order. Public endpoints rate
 * limit in bursts (the legacy near.org endpoint now intermittently
 * answers with a -429 deprecation error, and FastNear returned HTTP 429
 * under trade bursts in live use on 2026-11-07), so the bot always
 * carries more than one and rotates when one refuses a call. Verified
 * live on 2026-11-07: all six answer status calls. Lava testnet is
 * discontinued and deliberately not used.
 */
export const DEFAULT_RPC_URLS: Record<"testnet" | "mainnet", string[]> = {
  testnet: [
    "https://rpc.testnet.fastnear.com",
    "https://near-testnet.drpc.org",
    "https://rpc.testnet.near.org",
  ],
  mainnet: [
    "https://rpc.mainnet.fastnear.com",
    "https://near.drpc.org",
    "https://rpc.mainnet.near.org",
  ],
};

/**
 * Parse a NEAR_RPC_URL value into an ordered endpoint list. The value is
 * comma separated; blank entries are dropped and duplicates removed.
 * An unset or empty value falls back to the network defaults. Pure,
 * unit tested.
 */
export function parseRpcUrls(raw: string | undefined, network: string): string[] {
  const fallback = DEFAULT_RPC_URLS[network === "mainnet" ? "mainnet" : "testnet"];
  if (!raw) return [...fallback];
  const urls = [...new Set(raw.split(",").map((u) => u.trim()).filter((u) => u.length > 0))];
  return urls.length > 0 ? urls : [...fallback];
}

/**
 * Parse a NEAR amount typed by a human ("0.002") into yocto, exactly,
 * with string math only: floats cannot represent these values. Returns
 * undefined when the string is not a plain non negative decimal with
 * at most 24 fractional digits. Pure, unit tested.
 */
export function parseNearToYocto(raw: string): bigint | undefined {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) return undefined;
  const frac = m[2] ?? "";
  if (frac.length > 24) return undefined;
  return BigInt(m[1]) * 10n ** 24n + BigInt(frac.padEnd(24, "0") || "0");
}

const network = optional("NEAR_NETWORK", "testnet") as "testnet" | "mainnet";
const nearRpcUrls = parseRpcUrls(process.env["NEAR_RPC_URL"], network);
const wnearId = optional("WNEAR_ID", network === "mainnet" ? "wrap.near" : "wrap.testnet");
// Verified live on 2026-11-06: v2.ref-finance.testnet does not exist.
// The live Ref exchange on testnet is ref-finance.testnet (196 simple
// pools at check time). Mainnet keeps the v2 contract id.
const refExchangeId = optional(
  "REF_EXCHANGE_ID",
  network === "mainnet" ? "v2.ref-finance.near" : "ref-finance.testnet",
);
// DCL (concentrated liquidity) exchange, verified live on mainnet on
// 2026-11-06: dclv2.ref-labs.near answers list_pools, get_pool and quote.
// No DCL deployment exists on testnet (checked dclv2.ref-labs.testnet and
// every plausible variant by RPC on 2026-11-06, none has contract code),
// so on testnet the DCL scan simply finds no pools and routing falls back
// to simple pools. The id is still configurable for the day one appears.
const dclExchangeId = optional(
  "DCL_EXCHANGE_ID",
  network === "mainnet" ? "dclv2.ref-labs.near" : "dclv2.ref-labs.testnet",
);

const payCurrencies: PayCurrency[] = [
  { id: "NEAR", symbol: "NEAR", kind: "native", decimals: 24 },
  {
    id: "USDC",
    symbol: "USDC",
    kind: "ft",
    contractId: optional("USDC_CONTRACT_ID", network === "mainnet" ? "" : "usdc.fakes.testnet") || undefined,
    decimals: 6,
  },
  {
    id: "USDT",
    symbol: "USDT",
    kind: "ft",
    contractId: optional("USDT_CONTRACT_ID", network === "mainnet" ? "" : "usdt.fakes.testnet") || undefined,
    decimals: 6,
  },
];

export const config = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  masterKeyHex: required("MASTER_KEY"),
  network,
  /** Ordered RPC endpoint list (NEAR_RPC_URL accepts a comma separated list); calls fail over down the list. */
  nearRpcUrls,
  /** First (preferred) RPC endpoint, for display and single endpoint callers. */
  nearRpcUrl: nearRpcUrls[0],
  refExchangeId,
  dclExchangeId,
  wnearId,
  /** Watcher discovery: cap on how many pool discovered tokens the watcher tracks per account, and how long the discovered set is cached. */
  watchDiscoveryMax: Number(optional("WATCH_DISCOVERY_MAX", "250")),
  watchDiscoveryTtlSecs: Number(optional("WATCH_DISCOVERY_TTL_SECS", "600")),
  /** Optional bot fee wallet (see scripts/make-fee-wallet). When unset, fees are skipped on chain with a log line and referral credit still accrues in the store. */
  feeAccountId: optional("FEE_ACCOUNT_ID", ""),
  feeAccountSecretEnc: optional("FEE_ACCOUNT_SECRET_ENC", ""),
  /**
   * Named wallets: the registrar account that creates top level named
   * accounts ("testnet" on testnet, "near" on mainnet), and the suffix
   * every named user wallet carries. Creation is a create_account call
   * on the registrar signed by a funded creator account (see
   * scripts/make-creator-wallet). When no creator is configured, named
   * wallets stay dormant and every user keeps the implicit hex wallet.
   */
  registrarId: network === "mainnet" ? "near" : "testnet",
  nameSuffix: network === "mainnet" ? ".near" : ".testnet",
  creatorAccountId: optional("CREATOR_ACCOUNT_ID", ""),
  creatorSecretEnc: optional("CREATOR_SECRET_ENC", ""),
  /**
   * Deposit attached to each create_account call, in yocto. Verified
   * live on testnet on 2026-11-07: the attached deposit becomes the new
   * account's starting balance in full (the testnet registrar charges
   * nothing at creation, even a zero deposit lands), so this is a
   * starter balance for the user's new name, not a burned fee. The
   * amount is 0.01 NEAR because of a second live finding: a plain
   * transfer out of a fresh account holding only 0.002 was rejected by
   * the node with NotEnoughBalance, the operation costed at
   * 0.00810744245625 NEAR (the node's worst case gas prepayment for
   * the sender, mostly refunded after execution). At 0.01 the named
   * account can send immediately, proven live.
   */
  nameCreationDepositYocto:
    parseNearToYocto(optional("NAME_CREATION_DEPOSIT_NEAR", "0.01")) ?? 10n ** 22n,
  slippageBps: Number(optional("SLIPPAGE_BPS", "100")),
  botFeeBps: Number(optional("BOT_FEE_BPS", "100")),
  maxTradeNear: Number(optional("MAX_TRADE_NEAR", "10")),
  priceTtlSecs: Number(optional("PRICE_TTL_SECS", "15")),
  watchPollSecs: Number(optional("WATCH_POLL_SECS", "20")),
  /**
   * NEAR spent when a user taps a trader alert's Buy button and has no
   * AI per trade size configured (see ALERT_BUY_NEAR). With an AI size
   * set, the button uses that size instead. MAX_TRADE_NEAR caps both.
   */
  alertBuyNear: Number(optional("ALERT_BUY_NEAR", "0.1")),
  botUsername: optional("BOT_USERNAME", ""),
  referralEnabled: optional("REFERRAL_ENABLED", "true") === "true",
  refereeDiscountPct: Number(optional("REFEREE_DISCOUNT_PCT", "25")),
  referrerBonusPct: Number(optional("REFERRER_BONUS_PCT", "25")),
  referralTradeLimit: Number(optional("REFERRAL_TRADE_LIMIT", "10")),
  payCurrencies,
  defaultPayCurrency: optional("DEFAULT_PAY_CURRENCY", "NEAR"),
  knownTokens: parseKnownTokens(wnearId, network),
  dataDir: optional("DATA_DIR", "./data"),
  /** 1 NEAR = 1e24 yocto. */
  yoctoPerNear: 10n ** 24n,
};

if (!/^[0-9a-fA-F]{64}$/.test(config.masterKeyHex)) {
  throw new Error("MASTER_KEY must be 64 hex chars (32 bytes).");
}
if (!config.payCurrencies.some((c) => c.id === config.defaultPayCurrency)) {
  throw new Error(`DEFAULT_PAY_CURRENCY "${config.defaultPayCurrency}" is not a pay currency.`);
}

export function getPayCurrency(id: string): PayCurrency {
  const found = config.payCurrencies.find((c) => c.id.toLowerCase() === id.toLowerCase());
  if (!found) {
    throw new Error(`Unknown pay currency "${id}". Available: ${config.payCurrencies.map((c) => c.id).join(", ")}`);
  }
  return found;
}

/** The fungible token contract that represents a pay currency on chain (NEAR itself uses wNEAR inside pools). */
export function payCurrencyTokenId(currencyId: string): string {
  const c = getPayCurrency(currencyId);
  if (c.kind === "native") return config.wnearId;
  if (!c.contractId) throw new Error(`${c.id} is not configured yet (set ${c.id}_CONTRACT_ID in .env).`);
  return c.contractId;
}

export function findKnownToken(ref: string): KnownToken | undefined {
  const lower = ref.toLowerCase();
  return config.knownTokens.find((t) => t.id === lower || t.symbol.toLowerCase() === lower);
}
