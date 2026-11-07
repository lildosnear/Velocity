import { config, getPayCurrency } from "../src/config";
import { encryptPrivateKey } from "../src/crypto";
import { createWallet, readFtBalanceRaw, readNearBalance } from "../src/near";
import { findRoute } from "../src/ref";
import { swapBuy, swapSell } from "../src/market";
import { store, type UserRecord } from "../src/store";

/**
 * Live swap proof for testnet. Run: npm run live-swap
 *
 * What it does, honestly:
 * 1. Creates a fresh implicit wallet locally and prints its account id.
 * 2. Scans the Ref testnet exchange for a route between wNEAR and the
 *    token in PROOF_TOKEN_ID (default: the first configured known token
 *    that is not wNEAR, or set PROOF_TOKEN_ID in .env).
 * 3. If the wallet has no testnet NEAR yet, it stops and tells you to fund
 *    the printed account id from the faucet, then run again. It never
 *    invents a swap that did not land.
 * 4. When funded, it buys PROOF_AMOUNT_NEAR (default 0.1) worth of the
 *    token and sells it back, printing every transaction hash.
 *
 * Ref testnet liquidity is thin and comes and goes. If no route exists,
 * this script says so plainly and exits 0 without trading.
 */
async function main() {
  const tokenId = (process.env.PROOF_TOKEN_ID ?? config.knownTokens.find((t) => t.id !== config.wnearId)?.id ?? "").toLowerCase();
  if (!tokenId) {
    console.log("No PROOF_TOKEN_ID set and no non wNEAR token in KNOWN_TOKENS. Set PROOF_TOKEN_ID in .env to a testnet token contract id.");
    return;
  }
  const amount = Number(process.env.PROOF_AMOUNT_NEAR ?? "0.1");

  // Reuse a persisted proof wallet so faucet funding survives across runs.
  const PROOF_ID = 0; // telegramId 0 is reserved for this operator script
  let user = store.getUser(PROOF_ID);
  if (!user) {
    const wallet = createWallet();
    user = {
      telegramId: PROOF_ID,
      username: "live-proof",
      accountId: wallet.accountId,
      encSecret: encryptPrivateKey(wallet.secret),
      tokens: {},
      payCurrency: config.defaultPayCurrency,
      createdAt: new Date().toISOString(),
    } as UserRecord;
    store.saveUser(user);
    console.log("Created proof wallet:", user.accountId);
  }

  const balance = await readNearBalance(user.accountId);
  console.log(`Proof wallet ${user.accountId} balance: ${balance} NEAR`);

  let routeExists = true;
  try {
    const route = await findRoute(config.wnearId, tokenId, 10n ** 23n);
    console.log(`Route for 0.1 NEAR: ${route.description}, quoted out ${route.amountOutRaw.toString()} raw`);
  } catch (err: any) {
    routeExists = false;
    console.log("No live route right now:", err?.message ?? err);
  }

  if (!routeExists) {
    console.log("Nothing to prove until a liquid testnet pair is configured. Exiting without trading.");
    return;
  }
  if (balance < amount + 0.1) {
    console.log(`Fund the proof wallet with at least ${amount + 0.1} testnet NEAR, then run again.`);
    console.log("Funding options: the testnet helper service at https://helper.testnet.near.org/account creates a funded named testnet account you can send from (that is how the first live proof was funded), https://faucet.fastnear.com, or a testnet wallet at https://wallet.testnet.near.org");
    return;
  }

  const { credsOf, resolveToken } = await import("../src/market");
  const token = await resolveToken(tokenId);
  const creds = credsOf(user);
  const feeBps = config.botFeeBps;
  console.log(`Buying ${amount} NEAR of ${token.symbol} (${token.id})...`);
  const buy = await swapBuy(creds, token, amount, getPayCurrency("NEAR").id, feeBps);
  console.log("Buy landed. Tx:", buy.txids.join(", "));
  console.log(`Received ${buy.tokenAmount} ${token.symbol}. On chain balance raw:`, (await readFtBalanceRaw(token.id, user.accountId)).toString());

  console.log(`Selling ${buy.tokenAmount} ${token.symbol} back...`);
  const sell = await swapSell(creds, token, buy.tokenAmount, "NEAR", feeBps);
  console.log("Sell landed. Tx:", sell.txids.join(", "));
  console.log(`Received ${sell.payAmount} NEAR net. Proof complete.`);
}

main().catch((err) => {
  console.error("live-swap failed:", err?.message ?? err);
  process.exit(1);
});
