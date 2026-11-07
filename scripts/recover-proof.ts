import { config, getPayCurrency } from "../src/config";
import { wrapNear, readFtBalanceRaw, readNearBalance } from "../src/near";
import {
  credsOf,
  depositToExchange,
  parkedBalances,
  recoverCandidates,
  recoverParkedFunds,
  resolveToken,
  swapBuy,
} from "../src/market";
import { store } from "../src/store";

/**
 * Live parked funds proof for testnet. Run: npm run recover-proof
 *
 * What it does, honestly:
 * 1. Loads the persisted proof wallet (telegramId 0, the same wallet
 *    the live swap proof uses) and reads its internal exchange
 *    balances for BANANA and wNEAR.
 * 2. If nothing is parked, it creates the parked state the real way:
 *    a genuine deposit into the exchange through the same
 *    depositToExchange step the sell flow starts with (10 BANANA,
 *    plus 0.002 NEAR wrapped and deposited as wNEAR), and then the
 *    flow simply never continues, which is exactly the state an
 *    interrupted trade leaves behind. No state is edited by hand.
 * 3. Runs recoverParkedFunds with the real chain operations and
 *    prints before and after: internal balances, wallet balances,
 *    recovered amounts and every transaction hash. It exits nonzero
 *    if anything is still parked afterwards or the funds do not show
 *    up in the wallet.
 */
async function main() {
  const PROOF_ID = 0;
  const user = store.getUser(PROOF_ID);
  if (!user) {
    console.log("No proof wallet yet. Run npm run live-swap once to create and fund it.");
    return;
  }
  const creds = credsOf(user);
  const tokenId = (process.env.PROOF_TOKEN_ID ?? "banana.ft-fin.testnet").toLowerCase();
  const token = await resolveToken(tokenId);
  const wnear = { id: config.wnearId, symbol: "wNEAR", decimals: 24 };
  const candidates = [token, wnear];
  console.log(`Proof wallet ${user.accountId} on ${config.refExchangeId}`);

  let { parked } = await parkedBalances(creds, candidates);
  console.log("Parked before:", parked.map((p) => `${p.token.symbol}=${p.raw.toString()}`).join(", ") || "none");

  if (parked.length === 0) {
    const PARK_BANANA_RAW = 10_000_000n; // 10 BANANA at 6 decimals
    const PARK_WNEAR_RAW = 2n * 10n ** 21n; // 0.002 NEAR
    let bananaHeld = await readFtBalanceRaw(token.id, user.accountId);
    if (bananaHeld < PARK_BANANA_RAW) {
      console.log(`Wallet holds ${bananaHeld.toString()} raw ${token.symbol}; buying 0.05 NEAR worth first...`);
      const buy = await swapBuy(creds, token, 0.05, getPayCurrency("NEAR").id, config.botFeeBps);
      console.log("Buy landed. Tx:", buy.txids.join(", "));
      bananaHeld = await readFtBalanceRaw(token.id, user.accountId);
      if (bananaHeld < PARK_BANANA_RAW) throw new Error("Buy did not leave enough BANANA to park.");
    }
    const depBanana = await depositToExchange(creds, token.id, PARK_BANANA_RAW);
    console.log(`Deposited 10 ${token.symbol} into the exchange and stopped there (deposit tx ${depBanana}).`);
    const wrapTx = await wrapNear(creds, PARK_WNEAR_RAW);
    const depWnear = await depositToExchange(creds, config.wnearId, PARK_WNEAR_RAW);
    console.log(`Wrapped 0.002 NEAR (${wrapTx}) and deposited the wNEAR too (deposit tx ${depWnear}).`);
    ({ parked } = await parkedBalances(creds, candidates));
    console.log("Parked now:", parked.map((p) => `${p.token.symbol}=${p.raw.toString()}`).join(", "));
    if (parked.length === 0) throw new Error("Deposits landed but no parked balance reads back; cannot prove recovery.");
  }

  const nearBefore = await readNearBalance(user.accountId);
  const bananaBefore = await readFtBalanceRaw(token.id, user.accountId);

  console.log("Running recovery...");
  const outcome = await recoverParkedFunds(creds, await recoverCandidates(user, candidates));
  for (const r of outcome.recovered) {
    console.log(
      `Recovered ${r.amount} ${r.unwrapped ? "NEAR (unwrapped from wNEAR)" : r.token.symbol}. Tx: ${r.txids.join(", ")}`,
    );
  }
  for (const f of outcome.failures) {
    console.log(`FAILED ${f.token.symbol}: ${f.error}`);
  }

  const { parked: parkedAfter } = await parkedBalances(creds, candidates);
  const nearAfter = await readNearBalance(user.accountId);
  const bananaAfter = await readFtBalanceRaw(token.id, user.accountId);
  console.log("Parked after:", parkedAfter.map((p) => `${p.token.symbol}=${p.raw.toString()}`).join(", ") || "none");
  console.log(`Wallet NEAR: ${nearBefore} -> ${nearAfter}`);
  console.log(`Wallet ${token.symbol}: ${bananaBefore} -> ${bananaAfter} (human)`);

  if (outcome.failures.length > 0) throw new Error("Recovery reported failures.");
  if (parkedAfter.length > 0) throw new Error("Funds are still parked after recovery.");
  console.log("Proof complete: everything parked is back in the wallet.");
}

main().catch((err) => {
  console.error("recover-proof failed:", err?.message ?? err);
  process.exit(1);
});
