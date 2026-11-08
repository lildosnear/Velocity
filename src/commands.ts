import { Bot, InlineKeyboard, InputFile } from "grammy";
import { config, findKnownToken, getPayCurrency } from "./config";
import { decryptPrivateKey, encryptPrivateKey } from "./crypto";
import { pendingAlertExpired, store, type PendingAlert, type TradedToken } from "./store";
import {
  accountExists,
  createWallet,
  readFtBalance,
  readFtBalanceRaw,
  readNearBalance,
  transferNear,
} from "./near";
import {
  credsOf,
  defaultParkedFundsDeps,
  executeBuy,
  executeSell,
  fromRaw,
  getFeeWallet,
  parkedBalances,
  payBalance,
  recoverCandidates,
  recoverParkedFunds,
  resolveToken,
  type ParkedFundsDeps,
  type RecoverOutcome,
} from "./market";
import { getTokenPriceNear, tokenDecimals } from "./prices";
import {
  defaultNamePromptDeps,
  fullNameId,
  handlePendingNameText,
  maxLabelLength,
  namePromptAskText,
  sanitizeLabel,
  type NameAttemptResult,
  type NamePromptDeps,
} from "./names";
import { aiActive } from "./copy";
import { releaseUserLock, tryAcquireUserLock, UserBusyError, withUserLock } from "./locks";
import { logError } from "./log";
import { alertBuyAmountNear, alertSellAmountRaw, getHoldings } from "./watcher";
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

/** The reply lines for a name that was just created, shared by /name and the name prompt reply. */
function nameCreatedLines(user: { legacyAccountId?: string }, result: NameAttemptResult): string[] {
  const lines = [
    `Your wallet name is now ${result.namedId}.`,
    "It is the same wallet with the same key, just a human name. Use it as your deposit address from now on.",
  ];
  if (result.sweptNear && result.sweptNear > 0) lines.push(`Moved ${fmt(result.sweptNear)} NEAR from your old address to the name.`);
  for (const line of result.leftovers ?? []) lines.push(line);
  if (user.legacyAccountId) lines.push(`Your old address ${user.legacyAccountId} still belongs to you. Anything sent there stays yours.`);
  return lines;
}

/** One token's worth of /recover reply lines: what landed, and what could not be moved. */
function recoverLines(outcome: RecoverOutcome, label?: string): string[] {
  const prefix = label ? `${label}: ` : "";
  const lines: string[] = [];
  for (const r of outcome.recovered) {
    lines.push(
      r.unwrapped
        ? `${prefix}Recovered ${fmt(r.amount, 8)} NEAR from the exchange (it was parked as wNEAR, now unwrapped), in your wallet.`
        : `${prefix}Recovered ${fmt(r.amount, 8)} ${r.token.symbol} from the exchange, now in your wallet.`,
    );
  }
  for (const f of outcome.failures) {
    lines.push(`${prefix}Could not recover ${f.token.symbol}: ${f.error.slice(0, 200)}`);
  }
  return lines;
}

export function registerCommands(
  bot: Bot,
  nameDeps: NamePromptDeps = defaultNamePromptDeps,
  parkedDeps: ParkedFundsDeps = defaultParkedFundsDeps,
) {
  // Wallet name prompt interception, registered before every command
  // so it sees text messages first. While a user's pendingNamePrompt
  // flag is set (by /start for a brand new user, or by /name with no
  // argument), their next plain text message IS the wallet name they
  // want. A command clears the prompt and runs normally; the reply
  // "skip" clears it too. See handlePendingNameText in names.ts.
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message?.text;
    if (!text || !ctx.from) return next();
    const user = store.getUser(ctx.from.id);
    if (!user?.pendingNamePrompt) return next();
    const reply = await handlePendingNameText(user, text, nameDeps);
    switch (reply.kind) {
      case "pass":
        return next();
      case "skipped":
        await ctx.reply(
          `No problem, your wallet stays as ${user.accountId} for now. Run /name any time you want to claim a name.`,
        );
        return;
      case "already-named":
        await ctx.reply(`Your wallet name is already ${reply.namedId}.`);
        return;
      case "disabled":
        await ctx.reply(
          "Named wallets just got disabled on this bot (no creator account configured), so nothing was created. Your wallet is unchanged.",
        );
        return;
      case "created":
        await ctx.reply(nameCreatedLines(user, reply.result).join("\n\n"));
        return;
      case "taken":
        await ctx.reply(
          `${reply.namedId} is already taken on chain. Reply with a different name, or send skip to keep your current address.`,
        );
        return;
      case "needs-cleaning":
        await ctx.reply(
          `NEAR names cannot use those characters as typed. Cleaned up, your name would be: ${reply.namedId}\nReply with ${reply.cleaned} if that is the one you want, or send a different name.`,
        );
        return;
      case "unusable":
        await ctx.reply(
          `That name cannot be used. NEAR names are lowercase letters and numbers separated by single dashes, between ${2} and ${maxLabelLength()} characters for the name part. Reply with another name, or send skip to keep your current address.`,
        );
        return;
      case "failed":
        await ctx.reply(
          `Creating that name failed: ${reply.reason}\nReply with another name to try again, or send skip to keep your current address.`,
        );
        return;
    }
  });

  bot.command("start", async (ctx) => {
    const [, payload] = (ctx.message?.text ?? "").split(/\s+/);
    const isNewUser = ctx.from ? !store.getUser(ctx.from.id) : false;
    const user = await getOrCreateUser(ctx, payload);
    // Named wallets: the user is ASKED for the name they want, never
    // given one derived from anything. A brand new user gets the ask
    // right here and the prompt is set, so their next plain reply is
    // treated as the name (any command, or "skip", cancels). A
    // returning user who is still nameless just gets a pointer at
    // /name; no prompt is set, so nothing intercepts their next
    // message by surprise.
    let nameNote = "";
    if (nameDeps.enabled() && !nameDeps.isNamed(user)) {
      if (isNewUser) {
        user.pendingNamePrompt = true;
        store.saveUser(user);
        nameNote =
          "\n\nYou can also give this wallet a human name instead of the long address above. " +
          `Reply with the wallet name you want (for example "myname" gives you ${fullNameId("myname")}), ` +
          "or send any command to skip for now. You can claim a name any time with /name.";
      } else {
        nameNote = "\n\nTip: run /name to give this wallet a human name instead of the long address above.";
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
        "/name, claim or show your wallet name\n" +
        "/tokens, list tradable tokens\n" +
        "/buy TOKEN AMOUNT [CURRENCY], buy (e.g. /buy wNEAR 0.5, or paste a token contract id)\n" +
        "/sell TOKEN AMOUNT [CURRENCY], sell tokens\n" +
        "/paycurrency, choose NEAR, USDC or USDT\n" +
        "/balance, your balances\n" +
        "/recover, pull funds parked inside the exchange back into your wallet\n" +
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

    if (nameDeps.isNamed(user)) {
      const lines = [`Your wallet name is ${user.accountId}. It is your deposit address and it is controlled by the same key as your wallet.`];
      if (user.legacyAccountId && user.legacyAccountId !== user.accountId) {
        lines.push(`Your original address ${user.legacyAccountId} still belongs to you too. Anything sent there stays yours.`);
      }
      await ctx.reply(lines.join("\n\n"));
      return;
    }

    if (!nameDeps.enabled()) {
      await ctx.reply(
        "Named wallets are not enabled on this bot yet. The operator has not configured a creator account, so every wallet stays as its long address for now. Nothing about your wallet changes: it works exactly as it is.",
      );
      return;
    }

    if (!arg) {
      // No name given: ask, and set the prompt so the user's next
      // plain reply is the name they want. /name <name> still claims
      // directly in one step.
      user.pendingNamePrompt = true;
      store.saveUser(user);
      const st = user.nameStatus;
      const note =
        st?.state === "failed"
          ? `\n\n(Your last name attempt failed: ${st.reason ?? "unknown error"}. You can try that name again or pick a different one.)`
          : st?.state === "unavailable" && st.candidate
            ? `\n\n(The last name you asked for, ${fullNameId(st.candidate)}, was already taken. Pick a different one.)`
            : "";
      await ctx.reply(namePromptAskText(user) + note);
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
    const result = await nameDeps.claim(user, cleaned);
    if (result.state === "created") {
      await ctx.reply(nameCreatedLines(user, result).join("\n\n"));
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
    // Parked funds: tokens sitting in the exchange internal account
    // after an interrupted trade are not in the wallet, so they are
    // not in the balances above. A light check over the tokens the
    // bot knows for this user (no discovery scan) surfaces them with
    // the way back. A failed check never breaks /balance.
    try {
      const candidates = await recoverCandidates(user);
      const { parked } = await parkedBalances(creds, candidates, parkedDeps);
      for (const p of parked) {
        lines.push(
          `You also have ${fmt(fromRaw(p.raw, p.token.decimals), 8)} ${p.token.symbol} parked inside the exchange. Send /recover to pull it into your wallet.`,
        );
      }
    } catch {
      // Parked funds stay discoverable through /recover itself.
    }
    await ctx.reply("Your balances:\n" + lines.join("\n"));
  });

  bot.command("recover", async (ctx) => {
    const user = await getOrCreateUser(ctx);
    const wait = await ctx.reply("Checking the exchange for parked funds...");
    try {
      const lines = await withUserLock(user.telegramId, async () => {
        const extras = await parkedDeps.extraCandidates().catch(() => []);
        const candidates = await recoverCandidates(user, extras);
        const out: string[] = [];
        const main = await recoverParkedFunds(credsOf(user), candidates, parkedDeps);
        out.push(...recoverLines(main));
        // The AI wallet trades through the same exchange flow, so it can
        // park funds the same way. Recover it too when it exists and
        // anything is found there (or failed), labelled so the user
        // knows which wallet the money landed in.
        if (user.ai) {
          const aiCreds = { accountId: user.ai.accountId, secret: decryptPrivateKey(user.ai.encSecret) };
          const aiOutcome = await recoverParkedFunds(aiCreds, candidates, parkedDeps).catch(() => undefined);
          if (aiOutcome && (aiOutcome.parked.length > 0 || aiOutcome.failures.length > 0)) {
            out.push(...recoverLines(aiOutcome, "AI wallet"));
          }
        }
        return out;
      });
      if (lines.length === 0) {
        await ctx.reply("Nothing is parked inside the exchange. Everything you own is already in your wallet.");
      } else {
        await ctx.reply(lines.join("\n"));
      }
    } catch (err: any) {
      if (err instanceof UserBusyError) {
        await ctx.reply(err.message);
        return;
      }
      logError("trade", `user=${user.telegramId} recover failed`, err);
      await ctx.reply(`Recover failed: ${err?.message ?? err}`);
    } finally {
      await ctx.api.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
    }
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
      const result = await withUserLock(user.telegramId, () =>
        executeBuy(user, tokenRef, Number(amountStr), currencyId),
      );
      await ctx.reply(
        `Bought ${fmt(result.tokenAmount, 2)} ${result.symbol} for ${fmt(result.payAmount, 4)} ${result.payCurrency} ` +
          `at ${fmt(result.priceNear, 6)} NEAR each.\nTx: ${result.txids.join(", ")}`,
      );
    } catch (err: any) {
      if (err instanceof UserBusyError) {
        await ctx.reply(err.message);
        return;
      }
      logError("trade", `user=${user.telegramId} buy ${tokenRef} ${amountStr} ${currencyId} failed`, err);
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
      const result = await withUserLock(user.telegramId, () =>
        executeSell(user, tokenRef, Number(amountStr), currencyId),
      );
      const shareKb = new InlineKeyboard().text("📤 Share PnL card", `pnl:${result.symbol}`);
      await ctx.reply(
        `Sold ${fmt(result.tokenAmount, 2)} ${result.symbol} for ${fmt(result.payAmount, 4)} ${result.payCurrency} ` +
          `at ${fmt(result.priceNear, 6)} NEAR each.\nTx: ${result.txids.join(", ")}`,
        { reply_markup: shareKb },
      );
    } catch (err: any) {
      if (err instanceof UserBusyError) {
        await ctx.reply(err.message);
        return;
      }
      logError("trade", `user=${user.telegramId} sell ${tokenRef} ${amountStr} ${currencyId} failed`, err);
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
      const txid = await withUserLock(user.telegramId, () =>
        transferNear(credsOf(user), accountId, BigInt(Math.round(amount * 1e24))),
      );
      await ctx.reply(`Withdrew ${fmt(amount)} NEAR to ${accountId}.\nTx: ${txid}`);
    } catch (err: any) {
      if (err instanceof UserBusyError) {
        await ctx.reply(err.message);
        return;
      }
      logError("trade", `user=${user.telegramId} withdraw ${amount} NEAR to ${accountId} failed`, err);
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
        const feeSecret = feeWallet.secret; // narrowed by the guard above; captured for the closure
        const txid = await withUserLock(me, () =>
          transferNear(
            { accountId: feeWallet.accountId, secret: feeSecret },
            user.accountId,
            BigInt(Math.round(earned * 1e24)),
          ),
        );
        user.referralEarnedNear = 0;
        store.saveUser(user);
        await ctx.reply(`Withdrew ${earned.toFixed(8)} NEAR referral bonus.\nTx: ${txid}`);
      } catch (err: any) {
        if (err instanceof UserBusyError) {
          await ctx.reply(err.message);
          return;
        }
        logError("trade", `user=${me} referral withdraw ${earned} NEAR failed`, err);
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

  // --- Trader alert buttons -------------------------------------------------
  // The pending alert record (see store.ts) is the source of truth for
  // a tap: callback data carries only its short id. A tap resolves in
  // one of three ways: expired (record gone, past the one hour TTL, or
  // written before alert legs existed), refused (the alert belongs to
  // another user), or acted on.

  /** Remove the keyboard from the message a callback was tapped on. */
  async function stripAlertKeyboard(ctx: any, alert?: PendingAlert) {
    const chatId = alert?.chatId ?? ctx.chat?.id;
    const messageId = alert?.messageId ?? ctx.callbackQuery?.message?.message_id;
    if (chatId && messageId) {
      await ctx.api
        .editMessageReplyMarkup(chatId, messageId, { reply_markup: new InlineKeyboard() })
        .catch(() => {});
    }
  }

  /** Replace the alert message text (editing the text drops its keyboard). */
  async function rewriteAlertMessage(ctx: any, alert: PendingAlert, newText: string) {
    const chatId = alert.chatId ?? ctx.chat?.id;
    const messageId = alert.messageId ?? ctx.callbackQuery?.message?.message_id;
    if (chatId && messageId) {
      await ctx.api.editMessageText(chatId, messageId, newText).catch(() => {});
    }
  }

  /**
   * Shared gate for both alert buttons. Returns the record when the
   * tap may proceed, or undefined after the tap has been answered and
   * any dead keyboard stripped.
   */
  async function gateAlertTap(ctx: any, alertId: string): Promise<PendingAlert | undefined> {
    const alert = store.getPendingAlert(alertId);
    if (!alert || pendingAlertExpired(alert) || !Array.isArray(alert.legs)) {
      await ctx.answerCallbackQuery({ text: "This alert has expired." }).catch(() => {});
      await stripAlertKeyboard(ctx, alert);
      if (alert) store.deletePendingAlert(alert.id);
      return undefined;
    }
    if (alert.telegramId !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: "This alert belongs to another user." }).catch(() => {});
      return undefined;
    }
    return alert;
  }

  bot.callbackQuery(/^alertign:(.+)$/, async (ctx) => {
    const alert = await gateAlertTap(ctx, ctx.match[1]);
    if (!alert) return;
    store.deletePendingAlert(alert.id);
    await ctx.answerCallbackQuery().catch(() => {});
    await rewriteAlertMessage(ctx, alert, `${alert.text}\nIgnored.`);
  });

  bot.callbackQuery(/^alertbuy:([^:]+):(\d+)$/, async (ctx) => {
    const alert = await gateAlertTap(ctx, ctx.match[1]);
    if (!alert) return;
    const leg = alert.legs?.[Number(ctx.match[2])];
    if (!leg || leg.side !== "buy") {
      await ctx.answerCallbackQuery({ text: "This alert has expired." }).catch(() => {});
      await stripAlertKeyboard(ctx, alert);
      store.deletePendingAlert(alert.id);
      return;
    }
    const token = { id: leg.id, symbol: leg.symbol };
    const user = store.getUser(ctx.from.id);
    if (!user) {
      await ctx.answerCallbackQuery({ text: "Open the bot with /start first." }).catch(() => {});
      return;
    }
    // One money operation at a time for this user: a second tap while
    // a trade is still running is refused, never duplicated.
    if (!tryAcquireUserLock(user.telegramId)) {
      await ctx.answerCallbackQuery({ text: new UserBusyError().message }).catch(() => {});
      return;
    }
    // Answer now so Telegram does not spin while the swap runs.
    await ctx.answerCallbackQuery({ text: `Buying ${token.symbol}...` }).catch(() => {});
    try {
      const result = await executeBuy(user, token.id, alertBuyAmountNear(user), "NEAR");
      store.deletePendingAlert(alert.id);
      await rewriteAlertMessage(
        ctx,
        alert,
        `${alert.text}\nYou bought ${fmt(result.tokenAmount, 2)} ${result.symbol} for ${fmt(result.payAmount, 4)} NEAR.`,
      );
    } catch (err: any) {
      logError("trade", `user=${user.telegramId} alert buy ${token.symbol} failed`, err);
      // Keyboard stays in place so the user can retry or ignore.
      await ctx.reply(`Alert buy failed: ${err?.message ?? err}`);
    } finally {
      releaseUserLock(user.telegramId);
    }
  });

  bot.callbackQuery(/^alertsell:([^:]+):(\d+)$/, async (ctx) => {
    const alert = await gateAlertTap(ctx, ctx.match[1]);
    if (!alert) return;
    const leg = alert.legs?.[Number(ctx.match[2])];
    if (!leg || leg.side !== "sell") {
      await ctx.answerCallbackQuery({ text: "This alert has expired." }).catch(() => {});
      await stripAlertKeyboard(ctx, alert);
      store.deletePendingAlert(alert.id);
      return;
    }
    const user = store.getUser(ctx.from.id);
    if (!user) {
      await ctx.answerCallbackQuery({ text: "Open the bot with /start first." }).catch(() => {});
      return;
    }
    // One money operation at a time for this user, held from the
    // balance read to the end of the sale: refused taps never trade.
    if (!tryAcquireUserLock(user.telegramId)) {
      await ctx.answerCallbackQuery({ text: new UserBusyError().message }).catch(() => {});
      return;
    }
    try {
      // The amount is the fraction the trader sold, applied to the
      // user's CURRENT balance, read live now rather than at alert
      // time. Work it out before answering the tap, so a user holding
      // none gets a plain no instead of a trade attempt.
      let amountRaw: bigint;
      let decimals: number;
      try {
        decimals = await tokenDecimals(leg.id);
        const balanceRaw = await readFtBalanceRaw(leg.id, user.accountId);
        amountRaw = alertSellAmountRaw(balanceRaw, leg.sellFraction);
      } catch (err: any) {
        await ctx.answerCallbackQuery().catch(() => {});
        await ctx.reply(`Alert sell failed: ${err?.message ?? err}`);
        return;
      }
      if (!(amountRaw > 0n)) {
        await ctx.answerCallbackQuery({ text: `You hold no ${leg.symbol}.` }).catch(() => {});
        await ctx.reply(
          `That alert was the trader selling ${leg.symbol}, but you hold none of it, so there is nothing to sell.`,
        );
        return;
      }
      // Answer now so Telegram does not spin while the swap runs.
      await ctx.answerCallbackQuery({ text: `Selling ${leg.symbol}...` }).catch(() => {});
      try {
        const tokenAmount = Number(amountRaw) / 10 ** decimals;
        const result = await executeSell(user, leg.id, tokenAmount, user.payCurrency);
        store.deletePendingAlert(alert.id);
        await rewriteAlertMessage(
          ctx,
          alert,
          `${alert.text}\nYou sold ${fmt(result.tokenAmount, 2)} ${result.symbol} for ${fmt(result.payAmount, 4)} ${result.payCurrency}.`,
        );
      } catch (err: any) {
        logError("trade", `user=${user.telegramId} alert sell ${leg.symbol} failed`, err);
        // Keyboard stays in place so the user can retry or ignore.
        await ctx.reply(`Alert sell failed: ${err?.message ?? err}`);
      }
    } finally {
      releaseUserLock(user.telegramId);
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "/start, create your trading wallet\n" +
        "/deposit, your deposit account\n" +
        "/name [NAME], your wallet name, or claim one; without NAME it asks you to reply with the name you want\n" +
        "/paycurrency [ID], show or change pay currency (NEAR/USDC/USDT)\n" +
        "/tokens, list known tokens and pool prices\n" +
        "/buy TOKEN AMOUNT [CURRENCY], buy, TOKEN is a symbol or a contract account id\n" +
        "/sell TOKEN AMOUNT [CURRENCY], sell, AMOUNT is the token amount\n" +
        "/balance, balances\n" +
        "/recover, pull funds parked inside the exchange back into your wallet\n" +
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
        `AI wallet: ${ai.accountId}`,
        `AI wallet NEAR: ${bal.toFixed(6)}`,
        "To top it up, send NEAR to the AI wallet address above from any wallet.",
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
