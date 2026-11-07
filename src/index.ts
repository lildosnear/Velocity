import { Bot } from "grammy";
import { config } from "./config";
import { rpcBlockHeight } from "./near";
import { registerCommands } from "./commands";
import { setSender } from "./notifier";
import { startWatcher, watchTick } from "./watcher";
import { stopLossTick } from "./copy";

async function main() {
  const net = config.network;
  console.log(`Starting Velocity (NEAR ${net})...`);
  if (net === "mainnet") {
    console.warn("WARNING: mainnet mode. Real funds. Trade small.");
  }

  // Fail fast if the NEAR RPC is unreachable.
  const height = await rpcBlockHeight();
  console.log(`Connected to NEAR RPC. Block height: ${height}`);

  const bot = new Bot(config.telegramBotToken);
  registerCommands(bot);

  bot.catch((err) => {
    // Never leak keys: our errors never contain them, but stay disciplined here.
    console.error("Bot error:", err.message);
  });

  // Background jobs talk back to users through the notifier.
  setSender(async (telegramId, text) => {
    await bot.api.sendMessage(telegramId, text);
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
  process.exit(1);
});
