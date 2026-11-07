import { Bot } from "grammy";
import { config } from "./config";
import { accountExists, rpcBlockHeight } from "./near";
import { scanPools } from "./ref";
import { registerCommands } from "./commands";
import { setAlertSender, setSender } from "./notifier";
import { startWatcher, watchTick } from "./watcher";
import { stopLossTick } from "./copy";
import { verifyStoredSecrets } from "./store";
import { isChainReady, setChainReady } from "./readiness";
import { logError, logInfo, logWarn } from "./log";

/**
 * Boot sequence (the 2026-11-07 hardening pass):
 * 1. The master key is checked against the stored wallets before
 *    anything else. A store full of wallets nobody can decrypt is a
 *    stopped bot with a clear message, not a running bot whose every
 *    trade fails mysteriously.
 * 2. Chain readiness is probed (RPC height, exchange presence, pool
 *    scan) and reported in ONE readiness line. If the network is
 *    unreachable the bot still starts: a background probe keeps
 *    checking, and until it succeeds the trade paths answer plainly
 *    that the network is unreachable (see readiness.ts and
 *    market.ts), while info commands work as far as the chain allows.
 */

async function probeChain(): Promise<{ height: number }> {
  const height = await rpcBlockHeight();
  const exists = await accountExists(config.refExchangeId);
  if (!exists) throw new Error(`Ref exchange account ${config.refExchangeId} not found on ${config.network}`);
  return { height };
}

function readinessLine(height: number, pools: number): string {
  return (
    `Velocity ready: NEAR ${config.network}, block ${height}, ${pools} Ref pools seen, ` +
    `trading ${config.tradingEnabled ? "enabled" : "PAUSED"}, ` +
    `fee wallet ${config.feeAccountId ? `set (${config.feeAccountId})` : "not set (fees skipped)"}.`
  );
}

async function main() {
  const net = config.network;
  console.log(`Starting Velocity (NEAR ${net})...`);
  if (net === "mainnet") {
    console.warn("WARNING: mainnet mode. Real funds. Trade small.");
  }
  if (!config.tradingEnabled) {
    console.warn("Trading is PAUSED (TRADING_ENABLED=false). Info commands only, no buys or sells will execute.");
  }

  // Master key gate: refuse to start when the stored wallets cannot
  // be decrypted with the configured key (or the store itself cannot
  // be loaded). One clear message, no crash loop.
  const secrets = verifyStoredSecrets();
  if (!secrets.ok) {
    const storeBroken = (secrets.detail ?? "").includes("could not be loaded");
    const msg = storeBroken
      ? `${secrets.detail} Refusing to start.`
      : `MASTER_KEY does not match the stored wallets: ${secrets.detail}. ` +
        `The bot holds ${secrets.userCount} user wallet(s) it cannot sign for with this key. ` +
        "Fix MASTER_KEY in .env (it must be the exact key the wallets were encrypted with) and restart. Refusing to start.";
    console.error(msg);
    logError("boot", msg);
    process.exit(1);
  }
  if (secrets.userCount > 0) {
    console.log(`Store ok: ${secrets.userCount} user wallet(s), master key verified.`);
  }

  // Readiness probe. The bot starts either way; only the readiness
  // line waits for the chain.
  try {
    const { height } = await probeChain();
    const pools = await scanPools().catch(() => []);
    setChainReady(true);
    const line = readinessLine(height, pools.length);
    console.log(line);
    logInfo("boot", line);
  } catch (err: any) {
    setChainReady(false);
    const msg =
      `NEAR RPC is unreachable at boot (${err?.message ?? err}). Starting anyway: ` +
      "trades will answer plainly that the network is unreachable until a probe succeeds, and the bot keeps retrying in the background.";
    console.warn(msg);
    logWarn("boot", msg);
  }

  // Background probe: keeps the readiness flag honest in both
  // directions while the bot runs. Two light calls every 30 seconds.
  const prober = setInterval(async () => {
    try {
      const { height } = await probeChain();
      if (!isChainReady()) {
        setChainReady(true);
        const line = `NEAR RPC is reachable again (block ${height}); trading is unblocked.`;
        console.log(line);
        logInfo("boot", line);
      }
    } catch {
      if (isChainReady()) {
        setChainReady(false);
        logWarn("boot", "NEAR RPC probe failed; trades are on hold until a probe or a signed call succeeds");
      }
    }
  }, 30_000);
  prober.unref();

  const bot = new Bot(config.telegramBotToken);
  registerCommands(bot);

  bot.catch((err) => {
    // Never leak keys: our errors never contain them, but stay disciplined here.
    console.error("Bot error:", err.message);
    logError("telegram", `bot error: ${err.message}`);
  });

  // Background jobs talk back to users through the notifier.
  setSender(async (telegramId, text) => {
    await bot.api.sendMessage(telegramId, text);
  });

  // Trader alerts go out with their Buy and Ignore keyboard, and the
  // watcher records where each one landed so taps can edit it later.
  setAlertSender(async (telegramId, text, keyboard) => {
    const msg = await bot.api.sendMessage(telegramId, text, { reply_markup: keyboard });
    return { chatId: msg.chat.id, messageId: msg.message_id };
  });

  // Wallet watcher plus stop loss checker.
  startWatcher(async () => {
    await watchTick();
    await stopLossTick();
  });

  console.log("Bot running. Press Ctrl+C to stop.");
  await bot.start();
}

main().catch((err) => {
  console.error("Fatal:", err?.message ?? err);
  logError("boot", `fatal: ${err?.message ?? err}`);
  process.exit(1);
});
