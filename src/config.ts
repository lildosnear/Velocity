import "dotenv/config";

type Env = NodeJS.ProcessEnv;

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}
function optional(env: Env, name: string, fallback: string): string {
  return env[name] ?? fallback;
}

/**
 * Pay currencies the bot accepts. NEAR is native. USDC and USDT are fungible
 * tokens (NEP 141) whose contract ids differ per network, so config selects
 * a verified default per network and the operator can override either one.
 *
 * Mainnet defaults, decided from live evidence on 2026-11-07:
 * - USDC: the bridged USDC at a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near
 *   (metadata name "Bridged USDC", symbol USDC.e, 6 decimals). The account
 *   usdc.near exists but holds no contract code and answers no ft_metadata,
 *   so it is not a token and is never used. The bridged token carries the
 *   deep liquidity: simple pool 3 against wrap.near held about 10,991 wNEAR
 *   and 40,105 USDC.e at check time, and its DCL pool (fee tier 2000)
 *   quoted better than the simple pool for 0.1 NEAR.
 * - USDT: usdt.tether-token.near (metadata name "Tether USD", symbol USDt,
 *   6 decimals), the canonical Tether issued token. Simple pool 6063
 *   against wrap.near held about 46,885 wNEAR and 169,047 USDt, and it has
 *   liquid DCL pools (fee tiers 100 and 2000). The bridged USDT.e at
 *   dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near also
 *   exists with a deep simple pool (pool 4) but no liquid DCL pools, so
 *   the canonical token wins on route coverage.
 * On testnet there is no canonical USDC or USDT, so both slots default to
 * the Ref testnet fake tokens. A pay currency with no contract id fails
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

function parseKnownTokens(env: Env, wnearId: string): KnownToken[] {
  const raw = env["KNOWN_TOKENS"];
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

/** TRADING_ENABLED parsing: anything clearly negative pauses trading, everything else (including unset) leaves it on. Pure, unit tested. */
export function parseTradingEnabled(raw: string | undefined): boolean {
  if (raw == null) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}

export function loadConfig(env: Env = process.env) {
  const network = optional(env, "NEAR_NETWORK", "testnet") as "testnet" | "mainnet";
  const nearRpcUrls = parseRpcUrls(env["NEAR_RPC_URL"], network);
  const wnearId = optional(env, "WNEAR_ID", network === "mainnet" ? "wrap.near" : "wrap.testnet");
  // Verified live on 2026-11-06: v2.ref-finance.testnet does not exist.
  // The live Ref exchange on testnet is ref-finance.testnet (196 simple
  // pools at check time). Mainnet keeps the v2 contract id (verified
  // live on 2026-11-07: contract code present, 9014 simple pools).
  const refExchangeId = optional(
    env,
    "REF_EXCHANGE_ID",
    network === "mainnet" ? "v2.ref-finance.near" : "ref-finance.testnet",
  );
  // DCL (concentrated liquidity) exchange, verified live on mainnet on
  // 2026-11-06 and again on 2026-11-07: dclv2.ref-labs.near answers
  // list_pools, get_pool and quote, with about 6,300 pools.
  // No DCL deployment exists on testnet (checked dclv2.ref-labs.testnet and
  // every plausible variant by RPC on 2026-11-06, none has contract code),
  // so on testnet the DCL scan simply finds no pools and routing falls back
  // to simple pools. The id is still configurable for the day one appears.
  const dclExchangeId = optional(
    env,
    "DCL_EXCHANGE_ID",
    network === "mainnet" ? "dclv2.ref-labs.near" : "dclv2.ref-labs.testnet",
  );

  const payCurrencies: PayCurrency[] = [
    { id: "NEAR", symbol: "NEAR", kind: "native", decimals: 24 },
    {
      id: "USDC",
      symbol: "USDC",
      kind: "ft",
      contractId:
        optional(
          env,
          "USDC_CONTRACT_ID",
          network === "mainnet"
            ? "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near"
            : "usdc.fakes.testnet",
        ) || undefined,
      decimals: 6,
    },
    {
      id: "USDT",
      symbol: "USDT",
      kind: "ft",
      contractId:
        optional(env, "USDT_CONTRACT_ID", network === "mainnet" ? "usdt.tether-token.near" : "usdt.fakes.testnet") ||
        undefined,
      decimals: 6,
    },
  ];

  const loaded = {
    telegramBotToken: required(env, "TELEGRAM_BOT_TOKEN"),
    masterKeyHex: required(env, "MASTER_KEY"),
    network,
    /** Ordered RPC endpoint list (NEAR_RPC_URL accepts a comma separated list); calls fail over down the list. */
    nearRpcUrls,
    /** First (preferred) RPC endpoint, for display and single endpoint callers. */
    nearRpcUrl: nearRpcUrls[0],
    refExchangeId,
    dclExchangeId,
    wnearId,
    /**
     * Pool scan bounds. Mainnet is a different scale from testnet: the
     * Ref exchange held 9014 simple pools on 2026-11-07 (the deep USDt
     * pool sits at index 6063, far past the testnet bound of 500) and
     * the DCL exchange held about 6,300 pools. Scans are cached for a
     * minute, so the wider bounds cost one slower first quote, not a
     * slower every quote.
     */
    simplePoolScanLimit: Number(optional(env, "SIMPLE_POOL_SCAN_LIMIT", network === "mainnet" ? "10000" : "500")),
    dclPoolScanLimit: Number(optional(env, "DCL_POOL_SCAN_LIMIT", network === "mainnet" ? "6500" : "2000")),
    /**
     * Master trading switch (TRADING_ENABLED, default on). When off,
     * buys, sells, trader alert buttons and AI copy executions refuse
     * plainly with a trading paused message, while balances, watch
     * lists and every info command keep working. The operator's
     * kill switch for real money.
     */
    tradingEnabled: parseTradingEnabled(env["TRADING_ENABLED"]),
    /** Watcher discovery: cap on how many pool discovered tokens the watcher tracks per account, and how long the discovered set is cached. */
    watchDiscoveryMax: Number(optional(env, "WATCH_DISCOVERY_MAX", "250")),
    watchDiscoveryTtlSecs: Number(optional(env, "WATCH_DISCOVERY_TTL_SECS", "600")),
    /** Optional bot fee wallet (see scripts/make-fee-wallet). When unset, fees are skipped on chain with a log line and referral credit still accrues in the store. */
    feeAccountId: optional(env, "FEE_ACCOUNT_ID", ""),
    feeAccountSecretEnc: optional(env, "FEE_ACCOUNT_SECRET_ENC", ""),
    /**
     * Named wallets: the registrar account that creates top level named
     * accounts ("testnet" on testnet, "near" on mainnet), and the suffix
     * every named user wallet carries. Creation is a create_account call
     * on the registrar signed by a funded creator account (see
     * scripts/make-creator-wallet). When no creator is configured, named
     * wallets stay dormant and every user keeps the implicit hex wallet.
     *
     * Mainnet evidence, 2026-11-07: the near account runs the standard
     * near-linkdrop contract (the same family as the testnet registrar).
     * Its create_account method exists on chain and its source carries
     * no caller whitelist and no minimum deposit assert: it creates the
     * account, adds the given key and forwards the attached deposit in
     * full, with a refund to the caller if creation fails. Protocol
     * config confirms only the registrar side can create top level
     * names (min_allowed_top_level_account_length is 65, longer than
     * any legal account id), which the registrar contract satisfies
     * because every .near name is its own subaccount. So the testnet
     * flow carries over to mainnet unchanged.
     */
    registrarId: network === "mainnet" ? "near" : "testnet",
    nameSuffix: network === "mainnet" ? ".near" : ".testnet",
    creatorAccountId: optional(env, "CREATOR_ACCOUNT_ID", ""),
    creatorSecretEnc: optional(env, "CREATOR_SECRET_ENC", ""),
    /**
     * Deposit attached to each create_account call, in yocto. Verified
     * live on testnet on 2026-11-07: the attached deposit becomes the new
     * account's starting balance in full (the registrar charges nothing
     * at creation), so this is a starter balance for the user's new name,
     * not a burned fee. The amount is 0.01 NEAR because of a second live
     * finding: a plain transfer out of a fresh account holding only 0.002
     * was rejected by the node with NotEnoughBalance, the operation
     * costed at 0.00810744245625 NEAR (the node's worst case gas
     * prepayment for the sender, mostly refunded after execution). At
     * 0.01 the named account can send immediately, proven live on
     * testnet; the same node costing applies on mainnet. The protocol
     * minimum is only the new account's storage cost (its account record
     * plus one key, well under 0.01 NEAR at the 1e19 yocto per byte
     * storage price read from mainnet protocol config on 2026-11-07).
     */
    nameCreationDepositYocto:
      parseNearToYocto(optional(env, "NAME_CREATION_DEPOSIT_NEAR", "0.01")) ?? 10n ** 22n,
    slippageBps: Number(optional(env, "SLIPPAGE_BPS", "100")),
    botFeeBps: Number(optional(env, "BOT_FEE_BPS", "100")),
    /** Per trade cap in NEAR value. Mainnet defaults lower (5) than testnet (10): real money starts cautious, the operator can raise it. */
    maxTradeNear: Number(optional(env, "MAX_TRADE_NEAR", network === "mainnet" ? "5" : "10")),
    priceTtlSecs: Number(optional(env, "PRICE_TTL_SECS", "15")),
    watchPollSecs: Number(optional(env, "WATCH_POLL_SECS", "20")),
    /**
     * NEAR spent when a user taps a trader alert's Buy button and has no
     * AI per trade size configured (see ALERT_BUY_NEAR). With an AI size
     * set, the button uses that size instead. MAX_TRADE_NEAR caps both.
     */
    alertBuyNear: Number(optional(env, "ALERT_BUY_NEAR", "0.1")),
    botUsername: optional(env, "BOT_USERNAME", ""),
    referralEnabled: optional(env, "REFERRAL_ENABLED", "true") === "true",
    refereeDiscountPct: Number(optional(env, "REFEREE_DISCOUNT_PCT", "25")),
    referrerBonusPct: Number(optional(env, "REFERRER_BONUS_PCT", "25")),
    referralTradeLimit: Number(optional(env, "REFERRAL_TRADE_LIMIT", "10")),
    payCurrencies,
    defaultPayCurrency: optional(env, "DEFAULT_PAY_CURRENCY", "NEAR"),
    knownTokens: parseKnownTokens(env, wnearId),
    dataDir: optional(env, "DATA_DIR", "./data"),
    /** 1 NEAR = 1e24 yocto. */
    yoctoPerNear: 10n ** 24n,
  };

  if (!/^[0-9a-fA-F]{64}$/.test(loaded.masterKeyHex)) {
    throw new Error("MASTER_KEY must be 64 hex chars (32 bytes).");
  }
  if (!loaded.payCurrencies.some((c) => c.id === loaded.defaultPayCurrency)) {
    throw new Error(`DEFAULT_PAY_CURRENCY "${loaded.defaultPayCurrency}" is not a pay currency.`);
  }
  return loaded;
}

export const config = loadConfig();

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
