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

const network = optional("NEAR_NETWORK", "testnet") as "testnet" | "mainnet";
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
  nearRpcUrl: optional(
    "NEAR_RPC_URL",
    network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org",
  ),
  refExchangeId,
  dclExchangeId,
  wnearId,
  /** Watcher discovery: cap on how many pool discovered tokens the watcher tracks per account, and how long the discovered set is cached. */
  watchDiscoveryMax: Number(optional("WATCH_DISCOVERY_MAX", "250")),
  watchDiscoveryTtlSecs: Number(optional("WATCH_DISCOVERY_TTL_SECS", "600")),
  /** Optional bot fee wallet (see scripts/make-fee-wallet). When unset, fees are skipped on chain with a log line and referral credit still accrues in the store. */
  feeAccountId: optional("FEE_ACCOUNT_ID", ""),
  feeAccountSecretEnc: optional("FEE_ACCOUNT_SECRET_ENC", ""),
  slippageBps: Number(optional("SLIPPAGE_BPS", "100")),
  botFeeBps: Number(optional("BOT_FEE_BPS", "100")),
  maxTradeNear: Number(optional("MAX_TRADE_NEAR", "10")),
  priceTtlSecs: Number(optional("PRICE_TTL_SECS", "15")),
  watchPollSecs: Number(optional("WATCH_POLL_SECS", "20")),
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
