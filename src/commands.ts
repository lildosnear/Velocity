import { Bot, InlineKeyboard, InputFile } from "grammy";
import { config, findKnownToken, getPayCurrency } from "./config";
import { decryptPrivateKey, encryptPrivateKey } from "./crypto";
import { store, type TradedToken } from "./store";
import {
  accountExists,
  createWallet,
  readFtBalance,
  readNearBalance,
  transferNear,
} from "./near";
import {
  credsOf,
  executeBuy,
  executeSell,
  getFeeWallet,
  payBalance,
  resolveToken,
} from "./market";
import { getTokenPriceNear } from "./prices";
import {
  attemptNameForNewUser,
  candidateLabelFor,
  createNamedAccountFor,
  fullNameId,
  isImplicitId,
  maxLabelLength,
  namesEnabled,
  sanitizeLabel,
} from "./names";
import { aiActive } from "./copy";
import { getHoldings } from "./watcher";
import { pnlCaption, realizedCardInput, renderPnlCard, unrealizedCardInput } from "./share/pnl";

const FAUCET = "https://faucet.fastnear.com";

function fmt(n: number, digits = 6): string {
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

async function getOrCreateUser(ctx: any, refPayload?: string) {
  const telegramId = ctx.from.id;
  let user = store.getUser(telegramId);
  if (!user) {
    const wallet = createWallet();
    let referredBy: number | undefined;
    if (config.referralEnabled && refPayload?.startsWith("r_")) {
      const id = Number(refPayload.slice(2));
      // First link wins, no self referrals, referrer must exist.
      if (Number.isFinite(id) && id !== telegramId && store.getUser(id)) referredBy = id;
    }
    user = {
      telegramId,
      username: ctx.from.username,
      accountId: wallet.accountId,
      encSecret: encryptPrivateKey(wallet.secret),
      tokens: {},
      payCurrency: config.defaultPayCurrency,
      referredBy,
      createdAt: new Date().toISOString(),
    };
    store.saveUser(user);
  }
  if (!user.tokens) user.tokens = {};
  if (!user.payCurrency) user.payCurrency = config.defaultPayCurrency;
  // Keep the Telegram username current: the named wallet candidate is
  // derived from it, and usernames change.
  if (ctx.from.username && ctx.from.username !== user.username) {
    user.username = ctx.from.username;
    store.saveUser(user);
  }
  return user;
}

function isAccountId(s: string): boolean {
  return /^[a-z0-9._-]+$/.test(s) && (s.includes(".") || /^[0-9a-f]{64}$/.test(s)) && s.length >= 2 && s.length <= 64;
}

/** Find a token the user has traded (or a configured one) from a typed ref. */
function userToken(userTokens: Record<string, TradedToken>, ref: string): TradedToken | undefined {
  const lower = ref.toLowerCase();
  const known = findKnownToken(ref);
  if (known) return { id: known.id, symbol: known.symbol, decimals: known.decimals };
  return Object.values(userTokens).find((t) => t.id === lower || t.symbol.toLowerCase() === lower);
}

export function registerCommands(bot: Bot) {
  bot.command("start", async (ctx) => {
    const [, payload] = (ctx.message?.text ?? "").split(/\s+/);
    const isNewUser = ctx.from ? !store.getUser(ctx.from.id) : false;
    const user = await getOrCreateUser(ctx, payload);
    // Brand new users get a named wallet attempt right away, derived
    // from their Telegram username. Failure never breaks /start: the
    // hex wallet below is always a working wallet.
    let nameNote = "";
    if (isNewUser) {
      const attempt = await attemptNameForNewUser(user).catch(() => ({ state: "failed" as const, reason: "the name check hit a network error" }));
      if (attempt.state === "created") {
        nameNote = "\n\nThat account is a named wallet, created for you from your Telegram username. It is controlled by the same key as your wallet, there is just no long hex string to copy.";
      } else if (attempt.state === "unavailable") {
        nameNote = `\n\nThe name from your Telegram username (${attempt.reason ?? "the derived name"}) is already taken on chain, so your wallet stays as the address above for now. Pick your own any time with /name <name>.`;
      } else if (attempt.state === "failed") {
        nameNote = `\n\nI could not create a named wallet for you (${attempt.reason ?? "unknown error"}), so your wallet is the address above. You can try again any time with /name.`;
      } else if (attempt.state === "none") {
        nameNote = "\n\nTip: run /name <name> to give this wallet a human name instead of the long address above.";
      }
    }
    const net = config.network === "mainnet" ? "NEAR mainnet" : "NEAR testnet";
    const refLine =
      config.referralEnabled && user.referredBy
        ? `\n\nYou joined via a referral link, your first ${config.referralTradeLimit} trades get ${config.refereeDiscountPct}% off the bot fee.`
        : "";
    await ctx.reply(
      `Welcome to Velocity, the NEAR trading bot (${net}).\n\n` +
        "I made you a personal trading wallet. It is a hot wallet, only ever put in what you are ready to trade with." +
        refLine +
        "\n\n" +
        `Your wallet account:\n${user.accountId}\n\n` +
        "Send NEAR to that account to fund it. The account activates on chain with its first deposit." +
        (config.network === "testnet" ? `\nFree testnet NEAR: ${FAUCET}` : "") +
        nameNote +
        "\n\n" +
        "Commands:\n" +
        "/name, your wallet name (or pick one)\n" +
        "/tokens, list tradable tokens\n" +
        "/buy TOKEN AMOUNT [CURRENCY], buy (e.g. /buy wNEAR 0.5, or paste a token contract id)\n" +
        "/sell TOKEN AMOUNT [CURRENCY], sell tokens\n" +
        "/paycurrency, choose NEAR, USDC or USDT\n" +
        "/balance, your balances\n" +
        "/pnl [TOKEN], shareable PnL win card\n" +
        "/ref, your referral link and earnings\n" +
        "/withdraw ACCOUNT [AMOUNT], withdraw NEAR\n" +
        "/trades, your recent trades\n" +
        "/watch ACCOUNT [notify|auto], copy trade a wallet\n" +
        "/ai setup, AI auto trading",
    );
  });

  bot.command("deposit", async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const exists = await accountExists(user.accountId).catch(() => false);
    const lines = [
      `Send NEAR to your wallet account:\n${user.accountId}`,
      exists
        ? "Your account is live on chain."
        : "Your account is not on chain yet. The first NEAR deposit creates it.",
    ];
    if (config.network === "testnet") lines.push(`Free testnet NEAR: ${FAUCET}`);
    lines.push(
      "USDC and USDT also go to the same account id. On NEAR one account holds every token, there are no separate token accounts to fund.",
    );
    if (config.network === "testnet") lines.push("Nothing here has real value, this is testnet play money.");
    if (user.legacyAccountId && user.legacyAccountId !== user.accountId) {
      lines.push(
        `Your original address ${user.legacyAccountId} also still belongs to you (same key). Anything sent there stays yours; /name shows if anything is still sitting on it.`,
      );
    }
    await ctx.reply(lines.join("\n\n"));
  });

  bot.command("name", async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const [, arg] = (ctx.message?.text ?? "").split(/\s+/);

    if (!isImplicitId(user.accountId)) {
      const lines = [`Your wallet name is ${user.accountId}. It is your deposit address and it is controlled by the same key as your wallet.`];
      if (user.legacyAccountId && user.legacyAccountId !== user.accountId) {
        lines.push(`Your original address ${user.legacyAccountId} still belongs to you too. Anything sent there stays yours.`);
      }
      await ctx.reply(lines.join("\n\n"));
      return;
    }

    if (!namesEnabled()) {
      await ctx.reply(
        "Named wallets are not enabled on this bot yet. The operator has not configured a creator account, so every wallet stays as its long address for now. Nothing about your wallet changes: it works exactly as it is.",
      );
      return;
    }

    if (!arg) {
      const candidate = candidateLabelFor(user);
      const st = user.nameStatus;
      const lines: string[] = [];
      if (candidate) {
        lines.push(`The name from your Telegram username would be: ${fullNameId(candidate)}`);
        if (st?.state === "unavailable") lines.push("That name is already taken on chain. Pick a different one with /name <name>.");
        else if (st?.state === "failed") lines.push(`The last attempt to create it failed: ${st.reason ?? "unknown error"}\nRun /name ${candidate} to try again, or /name <name> to pick a different one.`);
        else lines.push(`Run /name ${candidate} to claim it, or /name <name> to pick a different one.`);
      } else {
        lines.push(
          `I cannot derive a name from your Telegram username${st?.reason ? ` (${st.reason})` : ""}. Pick one yourself with /name <name>, for example /name swift-trader.`,
        );
      }
      lines.push(`Your wallet today is the address ${user.accountId}, and it keeps working whatever you decide.`);
      await ctx.reply(lines.join("\n\n"));
      return;
    }

    const cleaned = sanitizeLabel(arg);
    if (!cleaned) {
      await ctx.reply(
        `That name cannot be used. NEAR names are lowercase letters and numbers separated by single dashes, between ${2} and ${maxLabelLength()} characters for the name part. Try /name <name> with a simpler one.`,
      );
      return;
    }
    if (cleaned !== arg.trim().toLowerCase()) {
      await ctx.reply(
        `NEAR names cannot use those characters as typed. Cleaned up, your name would be: ${fullNameId(cleaned)}\nRun /name ${cleaned} if that is the one you want.`,
      );
      return;
    }

    const wait = await ctx.reply(`Creating ${fullNameId(cleaned)}...`);
    void wait;
    const result = await createNamedAccountFor(user, cleaned);
    if (result.state === "created") {
      const lines = [
        `Your wallet name is now ${result.namedId}.`,
        "It is the same wallet with the same key, just a human name. Use it as your deposit address from now on.",
      ];
      if (result.sweptNear && result.sweptNear > 0) lines.push(`Moved ${fmt(result.sweptNear)} NEAR from your old address to the name.`);
      for (const line of result.leftovers ?? []) lines.push(line);
      if (user.legacyAccountId) lines.push(`Your old address ${user.legacyAccountId} still belongs to you. Anything sent there stays yours.`);
      await ctx.reply(lines.join("\n\n"));
      return;
    }
    if (result.state === "unavailable") {
      await ctx.reply(`${fullNameId(cleaned)} is already taken on chain. Try another with /name <name>. Your wallet is unchanged.`);
      return;
    }
    if (result.state === "disabled") {
      await ctx.reply("Named wallets just got disabled on this bot (no creator account configured), so nothing was created. Your wallet is unchanged.");
      return;
    }
    await ctx.reply(`Creating ${fullNameId(cleaned)} failed: ${result.reason ?? "unknown error"}\nYour wallet is unchanged and keeps working as ${user.accountId}.`);
  });

  bot.command("paycurrency", async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const [, id] = (ctx.message?.text ?? "").split(/\s+/);
    if (!id) {
      await ctx.reply(
        `Your pay currency: ${user.payCurrency}\nAvailable: ${config.payCurrencies.map((c) => c.id).join(", ")}\n` +
          "Change it: /paycurrency <id>",
      );
      return;
    }
    try {
      const currency = getPayCurrency(id);
      user.payCurrency = currency.id;
      store.saveUser(user);
      await ctx.reply(`Pay currency set to ${currency.id}. Buys, sells and AI trades now settle in ${currency.id}.`);
    } catch (err: any) {
      await ctx.reply(err?.message ?? String(err));
    }
  });

  bot.command("balance", async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const creds = credsOf(user);
    const lines: string[] = [];
    for (const c of config.payCurrencies) {
      try {
        const bal = await payBalance(creds, c.id);
        lines.push(`${c.id}: ${fmt(bal, c.kind === "native" ? 6 : 2)}`);
      } catch {
        lines.push(`${c.id}: not configured`);
      }
    }
    for (const token of Object.values(user.tokens)) {
      if (token.id === config.wnearId) continue;
      try {
        const bal = await readFtBalance(token.id, user.accountId, token.decimals);
        if (bal > 0) lines.push(`${token.symbol}: ${fmt(bal, 2)}`);
      } catch {
        continue;
      }
    }
    await ctx.reply("Your balances:\n" + lines.join("\n"));
  });

  bot.command("tokens", async (ctx) => {
    await getOrCreateUser(ctx);
    const lines: string[] = [];
    for (const t of config.knownTokens) {
      try {
        const price = await getTokenPriceNear(t.id);
        lines.push(`${t.symbol} (${t.id}) at ${fmt(price, 8)} NEAR`);
      } catch {
        lines.push(`${t.symbol} (${t.id}) at no pool price yet`);
      }
    }
    lines.push("\nYou can also paste any token contract account id into /buy, as long as it has a Rhea pool.");
    await ctx.reply("Tradable tokens:\n" + lines.join("\n"));
  });

  bot.command("buy", async (ctx) => {
    const [, tokenRef, amountStr, currencyArg] = (ctx.message?.text ?? "").split(/\s+/);
    if (!tokenRef || !amountStr || isNaN(Number(amountStr))) {
      await ctx.reply("Usage: /buy TOKEN AMOUNT [CURRENCY]  (e.g. /buy wNEAR 0.5, or /buy token.near 0.5 USDC)");
      return;
    }
    const user = await getOrCreateUser(ctx);
    let currencyId = user.payCurrency;
    if (currencyArg) {
      try {
        currencyId = getPayCurrency(currencyArg).id;
      } catch (err: any) {
        await ctx.reply(err?.message ?? String(err));
        return;
      }
    }
    const msg = await ctx.reply(`Quoting ${amountStr} ${currencyId} of ${tokenRef}...`);
    try {
      const result = await executeBuy(user, tokenRef, Number(amountStr), currencyId);
      await ctx.reply(
        `Bought ${fmt(result.tokenAmount, 2)} ${result.symbol} for ${fmt(result.payAmount, 4)} ${result.payCurrency} ` +
          `at ${fmt(result.priceNear, 6)} NEAR each.\nTx: ${result.txids.join(", ")}`,
      );
    } catch (err: any) {
      await ctx.reply(`Buy failed: ${err?.message ?? err}`, { reply_to_message_id: msg.message_id } as any);
    }
  });

  bot.command("sell", async (ctx) => {
    const [, tokenRef, amountStr, currencyArg] = (ctx.message?.text ?? "").split(/\s+/);
    if (!tokenRef || !amountStr || isNaN(Number(amountStr))) {
      await ctx.reply("Usage: /sell TOKEN AMOUNT [CURRENCY]  (e.g. /sell wNEAR 100, AMOUNT is the token amount)");
      return;
    }
    const user = await getOrCreateUser(ctx);
    let currencyId = user.payCurrency;
    if (currencyArg) {
      try {
        currencyId = getPayCurrency(currencyArg).id;
      } catch (err: any) {
        await ctx.reply(err?.message ?? String(err));
        return;
      }
    }
    // Sells pay out in the currency the position was opened in when the bot
    // knows it from AI positions; manual sells use the chosen currency.
    const msg = await ctx.reply(`Quoting sale of ${amountStr} ${tokenRef}...`);
    try {
      const result = await executeSell(user, tokenRef, Number(amountStr), currencyId);
      const shareKb = new InlineKeyboard().text("📤 Share PnL card", `pnl:${result.symbol}`);
      await ctx.reply(
        `Sold ${fmt(result.tokenAmount, 2)} ${result.symbol} for ${fmt(result.payAmount, 4)} ${result.payCurrency} ` +
          `at ${fmt(result.priceNear, 6)} NEAR each.\nTx: ${result.txids.join(", ")}`,
        { reply_markup: shareKb },
      );
    } catch (err: any) {
      await ctx.reply(`Sell failed: ${err?.message ?? err}`, { reply_to_message_id: msg.message_id } as any);
    }
  });

  bot.command("withdraw", async (ctx) => {
    const [, accountId, amountStr] = (ctx.message?.text ?? "").split(/\s+/);
    if (!accountId || !isAccountId(accountId)) {
      await ctx.reply("Usage: /withdraw <NEAR account id> [AMOUNT_NEAR]\nOmit the amount to withdraw everything above a small gas reserve.");
      return;
    }
    const user = await getOrCreateUser(ctx);
    const balance = await readNearBalance(user.accountId);
    const reserve = 0.05;
    const amount = amountStr ? Number(amountStr) : Math.max(0, balance - reserve);
    if (!(amount > 0) || amount > balance) {
      await ctx.reply(`Invalid amount (balance: ${fmt(balance)} NEAR).`);
      return;
    }
    try {
      const txid = await transferNear(credsOf(user), accountId, BigInt(Math.round(amount * 1e24)));
      await ctx.reply(`Withdrew ${fmt(amount)} NEAR to ${accountId}.\nTx: ${txid}`);
    } catch (err: any) {
      await ctx.reply(`Withdraw failed: ${err?.message ?? err}`);
    }
  });

  bot.command("trades", async (ctx) => {
    if (!ctx.from) return;
    const trades = store.recentTrades(ctx.from.id, 5);
    if (trades.length === 0) {
      await ctx.reply("No trades yet. Try /buy.");
      return;
    }
    const lines = trades.map(
      (t) =>
        `${t.side.toUpperCase()} ${fmt(t.tokenAmount, 2)} ${t.symbol} for ${fmt(t.payAmount, 4)} ${t.payCurrency}` +
        (t.viaAi ? " (AI)" : ""),
    );
    await ctx.reply("Recent trades:\n" + lines.join("\n"));
  });

  bot.command("pnl", async (ctx) => {
    const [, rawRef] = (ctx.message?.text ?? "").split(/\s+/);
    const user = await getOrCreateUser(ctx);
    let token: TradedToken | undefined = rawRef ? userToken(user.tokens, rawRef) : undefined;
    if (rawRef && !token) {
      try {
        token = await resolveToken(rawRef);
      } catch {
        token = undefined;
      }
    }
    if (!token) {
      // No arg (or unknown): pick the largest open position by NEAR value.
      let best: { token: TradedToken; amount: number; value: number } | undefined;
      for (const t of Object.values(user.tokens)) {
        try {
          const amount = await readFtBalance(t.id, user.accountId, t.decimals);
          if (!(amount > 0)) continue;
          const price = await getTokenPriceNear(t.id).catch(() => 0);
          const value = amount * price;
          if (!best || value > best.value) best = { token: t, amount, value };
        } catch {
          continue;
        }
      }
      if (!best) {
        await ctx.reply("No open positions. Buy something first with /buy.");
        return;
      }
      token = best.token;
    }
    const wait = await ctx.reply("Building your PnL card...");
    try {
      const amount = await readFtBalance(token.id, user.accountId, token.decimals);
      const data = await unrealizedCardInput(user.telegramId, token.id, token.symbol, amount);
      const png = await renderPnlCard(data);
      await ctx.replyWithPhoto(new InputFile(png, "velocity-pnl.png"), { caption: pnlCaption(data) });
    } catch (err: any) {
      await ctx.reply(`Could not build the card: ${err?.message ?? err}`);
    } finally {
      await ctx.api.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
    }
  });

  bot.command("ref", async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const [, sub] = (ctx.message?.text ?? "").split(/\s+/);
    const me = user.telegramId;

    if (sub === "withdraw") {
      const earned = user.referralEarnedNear ?? 0;
      if (!(earned > 1e-9)) {
        await ctx.reply("Nothing to withdraw yet. Share your link and earn from every trade your friends make.");
        return;
      }
      const feeWallet = getFeeWallet();
      if (!feeWallet?.secret) {
        await ctx.reply(
          `You have ${earned.toFixed(8)} NEAR of referral bonus banked. Payouts need the fee wallet key configured on the bot (FEE_ACCOUNT_SECRET_ENC), so this stays banked until the operator enables payouts.`,
        );
        return;
      }
      try {
        const feeBalance = await readNearBalance(feeWallet.accountId);
        if (feeBalance < earned + 0.02) {
          await ctx.reply(`The fee wallet is short (${feeBalance.toFixed(4)} NEAR) for your ${earned.toFixed(8)} NEAR bonus. It stays banked, ask the operator to top the fee wallet up.`);
          return;
        }
        const txid = await transferNear(
          { accountId: feeWallet.accountId, secret: feeWallet.secret },
          user.accountId,
          BigInt(Math.round(earned * 1e24)),
        );
        user.referralEarnedNear = 0;
        store.saveUser(user);
        await ctx.reply(`Withdrew ${earned.toFixed(8)} NEAR referral bonus.\nTx: ${txid}`);
      } catch (err: any) {
        await ctx.reply(`Withdraw failed: ${err?.message ?? err}`);
      }
      return;
    }

    const link = config.botUsername
      ? `https://t.me/${config.botUsername}?start=r_${me}`
      : "(set BOT_USERNAME in .env to activate your link)";
    const referees = store.allUsers().filter((u) => u.referredBy === me);
    let volume = 0;
    for (const r of referees) {
      volume += store.userTrades(r.telegramId).reduce((s, t) => s + t.nearValue, 0);
    }
    const earned = user.referralEarnedNear ?? 0;
    const lines = [
      "🎁 Referrals",
      `Your link: ${link}`,
      `Friends joined: ${referees.length}`,
      `Their volume: ${volume.toFixed(4)} NEAR`,
      `Your lifetime bonus: ${earned.toFixed(8)} NEAR`,
      `(${config.referrerBonusPct}% of the bot fee on every trade your friends make, for life)`,
    ];
    if (earned > 1e-9) lines.push("Cash out: /ref withdraw");
    if (config.referralEnabled && user.referredBy) {
      const left = Math.max(0, config.referralTradeLimit - (user.refTradeCount ?? 0));
      lines.push(`\nYour discount: ${left} of ${config.referralTradeLimit} discounted trades left.`);
    }
    await ctx.reply(lines.join("\n"));
  });

  bot.callbackQuery(/^pnl:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const symbol = ctx.match[1];
    const me = ctx.from.id;
    const lastSell = store
      .userTrades(me)
      .filter((t) => t.symbol === symbol && t.side === "sell")
      .at(-1);
    if (!lastSell) {
      await ctx.reply("No closed trade found for that card.");
      return;
    }
    const wait = await ctx.reply("Building your PnL card...");
    try {
      const data = await realizedCardInput(me, lastSell);
      const png = await renderPnlCard(data);
      await ctx.replyWithPhoto(new InputFile(png, "velocity-pnl.png"), { caption: pnlCaption(data) });
    } catch (err: any) {
      await ctx.reply(`Could not build the card: ${err?.message ?? err}`);
    } finally {
      await ctx.api.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "/start, create your trading wallet\n" +
        "/deposit, your deposit account\n" +
        "/name [NAME], your wallet name, or claim one\n" +
        "/paycurrency [ID], show or change pay currency (NEAR/USDC/USDT)\n" +
        "/tokens, list known tokens and pool prices\n" +
        "/buy TOKEN AMOUNT [CURRENCY], buy, TOKEN is a symbol or a contract account id\n" +
        "/sell TOKEN AMOUNT [CURRENCY], sell, AMOUNT is the token amount\n" +
        "/balance, balances\n" +
        "/pnl [TOKEN], shareable PnL win card\n" +
        "/ref, your referral link and earnings\n" +
        "/ref withdraw, cash out referral bonus in NEAR\n" +
        "/withdraw ACCOUNT [AMOUNT], withdraw NEAR\n" +
        "/trades, recent trades\n" +
        "/watch ACCOUNT [notify|auto], watch a trader's wallet\n" +
        "/unwatch ACCOUNT, stop watching\n" +
        "/watchlist, wallets you watch\n" +
        "/holdings [ACCOUNT], every registry token a watched wallet holds\n" +
        "/ai setup PER_TRADE [DAILY_LOSS_NEAR] [STOP_PCT], create the AI wallet\n" +
        "/ai status, AI funds, positions, today's P&L\n" +
        "/ai on|off, toggle auto copying",
    );
  });

  bot.command("watch", async (ctx) => {
    const [, accountId, modeRaw] = (ctx.message?.text ?? "").split(/\s+/);
    if (!accountId || !isAccountId(accountId)) {
      await ctx.reply("Usage: /watch <NEAR account id> [notify|auto]\nExample: /watch top-trader.near auto");
      return;
    }
    const mode = modeRaw === "auto" ? "auto" : "notify";
    const user = await getOrCreateUser(ctx);
    if (store.listWatched(user.telegramId).length >= 5) {
      await ctx.reply("You have hit the max of 5 watched wallets. /unwatch one first.");
      return;
    }
    if (mode === "auto" && !user.ai?.enabled) {
      await ctx.reply("Auto mode needs the AI wallet first. Run /ai setup, then add this watch again with auto.");
      return;
    }
    const id = `${user.telegramId}:${accountId.toLowerCase()}`;
    store.watch({
      id,
      ownerTelegramId: user.telegramId,
      accountId: accountId.toLowerCase(),
      mode,
      createdAt: new Date().toISOString(),
    });
    await ctx.reply(
      `Watching ${accountId} in ${mode} mode.\n` +
        (mode === "auto"
          ? "The AI will copy buys and sells instantly, within your per trade and daily limits."
          : "You will get a notification the moment this wallet's token balances move."),
    );
  });

  bot.command("unwatch", async (ctx) => {
    const [, accountId] = (ctx.message?.text ?? "").split(/\s+/);
    if (!accountId) {
      await ctx.reply("Usage: /unwatch <NEAR account id>");
      return;
    }
    if (!ctx.from) return;
    store.unwatch(`${ctx.from.id}:${accountId.toLowerCase()}`);
    await ctx.reply("Stopped watching that wallet.");
  });

  bot.command("watchlist", async (ctx) => {
    if (!ctx.from) return;
    const list = store.listWatched(ctx.from.id);
    if (list.length === 0) {
      await ctx.reply("You are not watching any wallets yet. Use /watch.");
      return;
    }
    await ctx.reply(
      "Watched wallets:\n" + list.map((w) => `${w.accountId} in ${w.mode} mode`).join("\n"),
    );
  });

  bot.command("holdings", async (ctx) => {
    if (!ctx.from) return;
    const [, accountId] = (ctx.message?.text ?? "").split(/\s+/);
    const list = store.listWatched(ctx.from.id);
    if (list.length === 0) {
      await ctx.reply("You are not watching any wallets yet. Use /watch first.");
      return;
    }
    const targets = accountId
      ? list.filter((w) => w.accountId === accountId.toLowerCase())
      : list;
    if (targets.length === 0) {
      await ctx.reply("That wallet is not in your watchlist.");
      return;
    }
    const msg = await ctx.reply("Reading holdings...");
    try {
      const sections: string[] = [];
      for (const w of targets) {
        const holdings = await getHoldings(w.accountId);
        const lines = holdings.map((h) => `  ${h.token.symbol}: ${h.amountTokens.toFixed(2)}`);
        sections.push(
          `${w.accountId} (${w.mode}):\n` +
            (lines.length > 0 ? lines.join("\n") : "  (no registry token balances)"),
        );
      }
      await ctx.reply(sections.join("\n\n"));
    } catch (err: any) {
      await ctx.reply(`Could not read holdings: ${err?.message ?? err}`, {
        reply_to_message_id: msg.message_id,
      } as any);
    }
  });

  bot.command("ai", async (ctx) => {
    const parts = (ctx.message?.text ?? "").split(/\s+/);
    const sub = parts[1];
    const user = await getOrCreateUser(ctx);

    if (sub === "setup") {
      const perTrade = Number(parts[2]);
      const dailyLoss = parts[3] ? Number(parts[3]) : undefined;
      const stopPct = parts[4] ? Number(parts[4]) : undefined;
      if (!(perTrade > 0) || (dailyLoss != null && !(dailyLoss > 0)) || (stopPct != null && !(stopPct > 0 && stopPct < 100))) {
        await ctx.reply(
          "Usage: /ai setup <per_trade_amount> [daily_loss_near] [stop_loss_pct]\n" +
            `Amounts are in your pay currency (currently ${user.payCurrency}), the daily loss limit is in NEAR.\n` +
            "Example: /ai setup 0.5 1 60\n" +
            "(per trade 0.5, pause after 1 NEAR daily loss, 60% stop loss)",
        );
        return;
      }
      if (user.payCurrency === config.defaultPayCurrency && perTrade > config.maxTradeNear) {
        await ctx.reply(`Per trade size cannot exceed the per trade cap of ${config.maxTradeNear} NEAR.`);
        return;
      }
      if (user.ai) {
        await ctx.reply("AI wallet already exists. Use /ai status.");
        return;
      }
      const wallet = createWallet();
      user.ai = {
        enabled: true,
        accountId: wallet.accountId,
        encSecret: encryptPrivateKey(wallet.secret),
        perTradeAmount: perTrade,
        dailyLossLimitNear: dailyLoss,
        stopLossPct: stopPct != null ? stopPct / 100 : undefined,
        positions: [],
        dailyPnl: { date: "1970-01-01", realizedNear: 0 },
      };
      store.saveUser(user);
      await ctx.reply(
        "AI wallet created. Only the funds you send here can ever be auto traded, your main wallet is never touched.\n\n" +
          `Fund it with NEAR:\n${wallet.accountId}\n\n` +
          `Per trade: ${perTrade} ${user.payCurrency}` +
          (dailyLoss ? `\nDaily loss limit: ${dailyLoss} NEAR` : "") +
          (stopPct ? `\nStop loss: ${stopPct}%` : "\nNo stop loss set"),
      );
      return;
    }

    if (sub === "status") {
      const ai = user.ai;
      if (!ai) {
        await ctx.reply("No AI wallet yet. Run /ai setup first.");
        return;
      }
      const active = aiActive(user);
      const bal = await readNearBalance(ai.accountId);
      const lines = [
        `AI: ${active ? "ON" : "OFF" + (ai.pausedUntil ? " (paused, daily limit hit)" : "")}`,
        `AI wallet NEAR: ${bal.toFixed(6)}`,
        `Per trade: ${ai.perTradeAmount} ${user.payCurrency}`,
        `Daily loss limit: ${ai.dailyLossLimitNear ?? "none"} NEAR`,
        `Stop loss: ${ai.stopLossPct != null ? `${(ai.stopLossPct * 100).toFixed(0)}%` : "none"}`,
        `Today's realized P&L: ${ai.dailyPnl.realizedNear >= 0 ? "+" : ""}${ai.dailyPnl.realizedNear.toFixed(6)} NEAR`,
      ];
      if (ai.positions.length > 0) {
        lines.push(
          "Open positions:",
          ...ai.positions.map(
            (p) => `  ${p.amount.toFixed(2)} ${p.symbol} at ${p.entryPriceNear.toFixed(8)} NEAR (in ${p.payCurrency})`,
          ),
        );
      }
      await ctx.reply(lines.join("\n"));
      return;
    }

    if (sub === "on" || sub === "off") {
      if (!user.ai) {
        await ctx.reply("No AI wallet yet. Run /ai setup first.");
        return;
      }
      user.ai.enabled = sub === "on";
      if (sub === "on") user.ai.pausedUntil = undefined;
      store.saveUser(user);
      await ctx.reply(`AI auto copying ${sub === "on" ? "enabled" : "disabled"}.`);
      return;
    }

    await ctx.reply(
      "AI commands:\n" +
        "/ai setup <per_trade_amount> [daily_loss_near] [stop_loss_pct], create the AI wallet\n" +
        "/ai status, funds, positions, today's P&L\n" +
        "/ai on|off, toggle auto copying",
    );
  });
}
