# Velocity

A Telegram trading bot for NEAR, built testnet first. Velocity is the
Forge product rebuilt for NEAR: the same commands, the same referral
economics, the same shareable PnL cards and the same copy trading with a
separate AI wallet. The one layer that changed is execution. Forge on
Arch had to be its own market maker because Arch testnet has no live
market. NEAR has Rhea Finance, so Velocity routes real swaps through the
Ref exchange contract and quotes real pool prices.

How it works: each Telegram user gets their own hot wallet on NEAR, an
implicit account whose id is the hex form of its public key. They fund it
with NEAR (the first deposit creates the account on chain). Every buy
and sell is routed across both Ref pool kinds, the simple pools on the
Ref exchange and the concentrated liquidity DCL pools, and the better
quote for your amount wins. Simple pool trades settle through the
exchange deposit, swap and withdraw flow; DCL trades settle in one
transfer call to the DCL exchange. A flat bot fee of 1 percent applies
on the NEAR value of each trade, whichever pool kind fills it.

## What is real vs testnet

- Real: wallet generation, AES 256 GCM key encryption, NEAR and fungible
  token transfers, Ref simple pool and DCL pool quotes and swaps,
  storage deposits, wNEAR wrapping, the Telegram UX, the trade ledger,
  referral accounting.
- Testnet facts, stated plainly:
  - The live Ref exchange on testnet is ref-finance.testnet. The address
    v2.ref-finance.testnet does not exist (verified live on 2026-11-06).
    Mainnet uses v2.ref-finance.near.
  - Ref testnet had 196 simple pools at build time, 17 of them with two
    sided wNEAR liquidity. Liquidity is thin and comes and goes. Prices
    are real pool quotes, but a route that exists today may be gone
    tomorrow, and the bot says so when there is no route.
  - DCL pools (the concentrated liquidity side of Rhea) live on
    dclv2.ref-labs.near on mainnet, and routing across them is built:
    pool scanning, quotes, best route selection against simple pools
    and swap execution, all covered by unit tests. Quotes were proven
    against mainnet views in read only mode on 2026-11-06 (0.1 wNEAR
    quoted 370071 raw units of the bridged USDC token, and 0.1 wNEAR
    quoted about 401 NEARLY tokens in the NEARLY pool). No DCL
    deployment exists on testnet today: the candidate testnet contract
    ids hold no contract code, so on testnet the DCL scan finds no
    pools and simple pool routes carry the trades. DCL execution was
    audited end to end against live mainnet transaction traces on
    2026-11-07 (see the MAINNET section), but it has not yet been
    settled by a landed Velocity transaction; that proof needs a
    funded mainnet trade.
  - Testnet USDC and USDT are the Ref fake stablecoins at
    usdc.fakes.testnet and usdt.fakes.testnet (symbols USDC.e and
    USDT.e, 6 decimals). There is no canonical testnet USDC. On
    mainnet the defaults are the bridged USDC token and
    usdt.tether-token.near, chosen from live liquidity evidence (see
    the MAINNET section). Both ids are configurable in .env.
  - Everything runs on play money until you switch NEAR_NETWORK to
    mainnet in .env, which also swaps the default contract ids, scan
    bounds and per trade cap. Mainnet is ready as of 2026-11-07; the
    MAINNET section below is the runbook for switching over.

## Setup (Windows, PowerShell)

1. Install Node.js 20 or newer. Nothing else to install.
2. Talk to @BotFather on Telegram, create a bot, copy the token.
3. Run `npm install`.
4. Copy `.env.example` to `.env` and fill in:
   - `TELEGRAM_BOT_TOKEN` from BotFather.
   - `BOT_USERNAME`, your bot username without the @, for referral links.
   - `MASTER_KEY`, generate it with:
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `NEAR_RPC_URL` comes prefilled with a comma separated list of RPC
     endpoints; leave it as is. When an endpoint rate limits (HTTP 429,
     or the legacy endpoint's -429 deprecation error) or drops a call,
     the bot retries the same call against the next endpoint in the
     list, for reads and signed transactions alike, instead of failing
     the command. Defaults: testnet FastNear, dRPC, then the legacy
     NEAR endpoint; mainnet uses the matching mainnet set. Pool scans
     are also cached for a minute, so quoting does not rescan the
     exchange on every trade.
5. Create the fee wallet: `npm run make-fee-wallet`. It prints
   `FEE_ACCOUNT_ID` and `FEE_ACCOUNT_SECRET_ENC` ready to paste into
   `.env`, then fund that account with a little NEAR (it pays referral
   bonuses out, so it needs a balance). A named account such as
   velocitybot.testnet works too and is the recommended shape on
   testnet: create it in a testnet wallet first, then encrypt its key
   with `npm run smoke -- --encrypt-key "ed25519:..."` and paste the
   two lines in by hand. The script explains both shapes.
   If you skip this step the bot still trades: fees are skipped cleanly
   with a log line and no referral credit accrues, because no fee was
   captured. One behaviour, no surprises.
6. Optional, for named wallets: `npm run make-creator-wallet`. It
   prints `CREATOR_ACCOUNT_ID` and `CREATOR_SECRET_ENC` ready to paste
   into `.env`. Fund the creator with some NEAR: it signs the registrar
   call that creates each user's named wallet and pays the starter
   deposit (NAME_CREATION_DEPOSIT_NEAR, default 0.01 NEAR, which lands
   in the user's new account as its balance). Skip this step and named
   wallets stay off, every user keeps the implicit hex wallet.
7. `npm run smoke` to verify the RPC connection, the wNEAR metadata,
   the Ref simple pool scan and the DCL pool scan (on testnet it also
   prints a read only mainnet DCL quote, since no testnet DCL
   deployment exists), then `npm run dev`.

Getting testnet NEAR for user wallets: each user wallet is an implicit
account and activates with its first deposit. The NEAR testnet helper
service (https://helper.testnet.near.org/account) creates a funded
named testnet account in one call with a public key you generate, and
that is how the live proof wallet in this repo was funded on
2026-11-06: the helper account sent 0.5 testnet NEAR to the proof
wallet (transaction J9shwEEeCwUnzw85YysB28yUXhVbnhVGZnT9ngdNeDNr).
The faucet at https://faucet.fastnear.com funds named testnet accounts
through its web flow. For implicit ids, fund them from any testnet
wallet you already hold (https://wallet.testnet.near.org) with a plain
send.

## Commands

`/start` `/deposit` `/name [NAME]` `/paycurrency [ID]` `/tokens`
`/buy TOKEN AMOUNT [CURRENCY]` `/sell TOKEN AMOUNT [CURRENCY]`
`/balance` `/recover` `/pnl [TOKEN]` `/ref` `/ref withdraw`
`/withdraw ACCOUNT [AMOUNT]` `/trades` `/help`
`/watch` `/unwatch` `/watchlist` `/holdings`
`/ai setup` `/ai status` `/ai on` `/ai off`

TOKEN is a symbol from /tokens or any fungible token contract account
id pasted directly, as long as the token routes to your pay currency
across Ref simple pools or DCL pools. For
/buy, AMOUNT is how much of the pay currency to spend. For /sell,
AMOUNT is how many tokens to sell.

### Parked funds (`/recover`)

Simple pool trades settle in steps: your tokens are deposited into
the Ref exchange, swapped inside it, and the output is withdrawn to
your wallet. If a trade is interrupted between the swap and the
withdraw, the output stays in your internal exchange balance:
parked. Parked funds are still yours, held by the exchange under
your account, but they are not in your wallet, so a wallet balance
can read zero for a token you actually own. Post swap checks now
poll for about twenty seconds before calling a trade failed, which
makes parking rare, and any "swap landed but nothing arrived"
failure message points here.

`/recover` reads your internal exchange balances for every token
the bot can know about (pay currencies, wNEAR, your traded tokens
and trade history, and the watcher discovery set) and withdraws
each nonzero one back into your wallet, one plain line per token.
Parked wNEAR is unwrapped to NEAR as it lands, since it almost
always came from a sell. The AI wallet is checked too. `/balance`
also runs a light version of the check and adds a line whenever
something is parked. Recovery is safe to run any time and as often
as you like: zero balances are skipped, one token failing never
stops the rest, and with nothing parked it simply says so.

### Shareable PnL cards (`/pnl`)

After every /sell the bot offers a Share PnL card button. /pnl [TOKEN]
builds one for an open position (no argument means your largest
position). The card is a 1200 by 630 branded image: token, giant PnL
percent, entry and current market cap when a listing source has them,
and your referral deep link.

The card's whole vibe shifts with the win rate:

| PnL | Label | Color |
|-----|-------|-------|
| +500% and up | LEGENDARY | gold |
| +100% to +500% | DIAMOND HANDS | orange |
| +25% to +100% | SOLID | green |
| 0% to +25% | GREEN | light green |
| below 0% | REKT | red |

PnL uses average cost basis from your buy history, valued in NEAR. Set
BOT_USERNAME in .env to print your t.me referral link on the card.

Mascot: the speed comet is the chosen Velocity mascot, picked by
Desmond on 2026-11-07, and it is also the bot profile photo. The card
composites it as a circle in the top left slot, the same way Forge
composited its mascot. The artwork lives at assets/mascots/comet.png,
and renderPnlCard in src/share/pnl.ts masks it to the inscribed
circle of the art so no tile edges show.

### Referral program (`/ref`)

Your share card carries your referral link, and both sides win.

- Friend: 25 percent off the bot fee on their first 10 manual trades,
  then back to the full fee.
- You: a 25 percent lifetime bonus, a cut of the bot fee captured on
  every manual trade they ever make, for as long as they keep trading,
  credited in NEAR.
- /ref shows your link, friends joined, their volume and your earnings.
  /ref withdraw pays earnings out from the fee wallet to your wallet.
- AI copy trades do not count toward the 10 and earn nothing. Manual
  trades only. One referrer per user (first link wins), no self
  referrals.

The fee math is unit tested: the discount hard stops at trade 10 while
the referrer credit continues for life, exactly as Forge specified.

### Pay with NEAR, USDC or USDT

/paycurrency shows your current pay currency. /paycurrency USDC
switches. Every buy and sell accepts an optional currency override
(/buy TOKEN 10 USDC). NEAR is the default. Sells from AI positions pay
out in the currency the position was opened in. On NEAR one account
holds every token, so there are no separate token accounts to fund:
everything goes to the one account id from /deposit. The bot handles
storage deposits, wNEAR wrapping and unwrapping inside the trade flow.

### Copy trading

- /watch <account id> [notify|auto] watches a trader's wallet (max 5).
  notify (default) alerts you the moment their token balances move.
  auto also has the AI copy the trade instantly: buys copy at your per
  trade size, sells mirror the trader's fraction (they sell 40 percent
  of their bags, the AI sells 40 percent of yours, never the whole
  position unless they did).
- /unwatch <account id>, /watchlist, /holdings [account id].

How detection works: every WATCH_POLL_SECS seconds the bot reads
fungible token balances for only your watched accounts, across the
watch token set, and diffs them. The watch set is the union of the
token registry (configured tokens plus anything any user has traded
through the bot) and every token that appears in a simple pool or a
DCL pool paired with wNEAR or with a registry token, ranked so the
most liquid pairs are tracked first and capped by WATCH_DISCOVERY_MAX.
The discovered set is cached for WATCH_DISCOVERY_TTL_SECS so polling
stays light, and token metadata is fetched lazily the first time a
discovered token is seen. Holdings reflect the same widened set. One
limit, stated plainly: a plain transfer looks the same as a trade, so
a watched trader receiving tokens by transfer still triggers a diff.
Alerts are aggregated: all of an account's diffs in one poll arrive as
a single message, sells stated before buys, and when any other token
moved in the same poll the wNEAR leg is left out of the text, since it
is the payment plumbing of the trade rather than a trade of its own.
Every alert carries buttons: one Buy button per token the trader
bought and one Sell button per token they sold (up to three action
rows in total, in the order the legs appear in the alert), plus an
Ignore button that dismisses the alert. Buy spends NEAR from your
main wallet at your AI per trade size when you have one set,
otherwise ALERT_BUY_NEAR (0.1 NEAR), and MAX_TRADE_NEAR always caps
it. Sell mirrors the trader proportionally: the button sells the
same fraction of your own holding of that token that the trader
sold of theirs, worked out against your live balance when you tap
it (if the fraction cannot be known, it sells your full holding).
Buttons live for one hour and work only for the user the alert was
sent to.

### AI auto trading

- /ai setup <per_trade_amount> [daily_loss_near] [stop_loss_pct]
  creates a separate AI wallet. Only the funds you send there can ever
  be auto traded; your main hot wallet is never touched. Example:
  /ai setup 0.5 1 60 means 0.5 of your pay currency per copy trade,
  pause after 1 NEAR of daily loss, 60 percent stop loss per position.
- /ai status shows the AI balance, open positions and today's realized
  P&L.
- /ai on and /ai off toggle it.

Rules the engine enforces: per trade size, the per trade cap
MAX_TRADE_NEAR as a rail, daily loss limit (pauses until midnight UTC),
optional stop loss checked against live pool prices, instant close when
a watched trader sells. Every AI action notifies you.

### Named wallets (`/name`)

Every user starts with an implicit wallet, a 64 character hex account
id. It is free and instant, and it stays the engine underneath forever.
When a creator account is configured (setup step 6), the bot also
creates a named account for the user, NAME.testnet here and NAME.near
on mainnet, through the network registrar, with the SAME public key as
the hex wallet. One secret controls both; the named account simply
becomes the primary account the bot shows and uses, and the hex wallet
stays on the user's record as their legacy address. The AI wallet is
never named.

How a name arrives: the user is asked for the name they want, and
they type it themselves. The bot never derives a name from the
Telegram username or anything else, and a name is always a top level
NAME.testnet or NAME.near account created through the registrar,
never a subaccount of the creator or project account.

- At /start, the welcome message asks a brand new user to reply with
  the wallet name they want, and a pending prompt is set on their
  record: their next plain text reply is treated as the name and
  claimed. Sending any command, or the reply "skip", clears the
  prompt instead. The prompt has no expiry; it simply waits for the
  next message. Returning users are not prompted at /start (no
  surprise interception), just pointed at /name.
- /name with no argument asks the same question and sets the same
  prompt. /name <name> claims that name directly in one step.
- A reply that is already taken is answered plainly and the prompt
  stays open for another try. A reply typed with characters NEAR
  cannot use is not silently changed: the bot shows the cleaned up
  version (King_1504 would become king-1504.testnet) and claims
  nothing until the user sends that name, so the name you get is
  always the name you saw.
- The outcome of every attempt is recorded on the user record
  (created, unavailable, failed with the reason).

When a name is created for a user whose hex wallet already holds
funds, the bot sweeps the legacy wallet: every recorded token balance
moves to the named account (paying each token's storage deposit for
the new account out of the legacy balance), then the NEAR moves,
keeping 0.003 NEAR behind for the old account's own gas. The token
moves use deliberately small gas attachments: the node makes the
sender prepay the full attached gas at the current gas price (unused
gas is refunded), and at the testnet gas price measured on 2026-11-07
a standard 100 TGas call needed roughly 0.1 NEAR of momentary
headroom, more than a modest wallet holds. The sweep is
best effort and honest: anything that could not move is listed in the
reply, with the amount and the old address, and the old address stays
on the record. Nothing is ever stranded silently.

Registrar facts, verified live on testnet on 2026-11-07 (see the live
proof below): any funded account may call create_account on the
registrar (testnet here, near on mainnet), there is no whitelist. The
mainnet side of that claim was verified from evidence on 2026-11-07:
the near account runs the standard near-linkdrop contract, its
create_account method exists on chain, and the deployed source at the
exact revision recorded in the contract metadata carries no caller
whitelist and no minimum deposit assert; it creates the account,
adds the given key and forwards the attached deposit in full, with a
refund to the caller if creation fails. Mainnet protocol config
confirms only the registrar side can create top level names
(min_allowed_top_level_account_length is 65, longer than any legal
account id), which the registrar contract satisfies because every
.near name is its own subaccount. So the registrar flow above works
on mainnet unchanged, with the .near suffix and the same 0.01 NEAR
default deposit; the protocol minimum is only the new account's
storage cost, well under that default. The
deposit attached to the call becomes the new account's starting
balance in full; the testnet registrar charges nothing at creation
and even a zero deposit lands, so NAME_CREATION_DEPOSIT_NEAR is a
starter balance for the user, not a burned fee. The default is 0.01
NEAR because of a second live finding: a plain transfer out of a
fresh account holding only 0.002 was rejected by the node with
NotEnoughBalance, the operation costed at 0.00810744245625 NEAR (the
node's worst case gas prepayment for the sender, mostly refunded
after execution). At 0.01 the named account sends immediately, which
the proof below demonstrates. Short labels are fine, a 3 character
label was created live; a taken name fails on chain with
AccountAlreadyExists and the bot reports it as taken.

## Fees

BOT_FEE_BPS defaults to 100, a flat 1 percent on the NEAR value of each
successful swap, matching the field on NEAR. On a buy the fee is
deducted from the amount paid in; on a sell it is deducted from the
amount paid out. It moves on chain to the fee wallet in the same flow,
so every fee is auditable in the transaction list of the trade. Failed
swaps are never charged.

## Live proof

`npm run live-swap` runs the end to end proof on testnet: it creates a
proof wallet, quotes a live route (set PROOF_TOKEN_ID to a token
contract id, for example banana.ft-fin.testnet), and once the proof
wallet is funded it buys and sells back, printing every transaction
hash.

The funded round trip landed on 2026-11-06. The proof wallet
(8cc1762621292d79d0ce41a476021e4bb7c7227a02e681e57f1377dbc243a39b)
was funded through the NEAR testnet helper service route described in
the setup section. Buy of 0.1 NEAR of BANANA through simple pool 11:
wrap FfSJkgen3GZMh4YTM9Uy2LxgMdZFpEGo7wkdV959wkdJ, deposit
HVA1AJmK56V3ZhxcoKx7oSgdwTtp3nGh5Zh6nbm8xBpY, swap
4A88rcqBa8u7gsMBoFHjKVCy6t8XXNBuavgRrfuTDnWr, withdraw
J7Scxa4XkMQviK36aKpTKV8Jvwu2kC5nRetatLh15Vzh. It received 2979.398074
BANANA, exactly the quoted amount. Sell back: deposit
5qPLR9Ecx6CCeY6gVrBtW6V5jbeQ6Di4x8dxV9unE5Tt, swap
3foT1ak49ZGTaLUonNRgUsrEXfCSWPsKjNAnsscRSt87, withdraw
Fgy7LsD7aTX2qDCBpXLCaAT5imFQ1CBLneBLNPwKyM3o, unwrap
2obEdY2N4FTr68MGiq75vakfFjPy4ZDeCiRhsferxw4U.

Two findings from getting this proof to land, both verified live:
the testnet exchange rejects instant swap transfer messages
(ERR_MSG_WRONG_FORMAT across six message variants, every attempt
refunded), which is why simple pool trades settle through the
deposit, swap and withdraw flow; and the exchange requires each
account to hold a small NEAR storage balance inside it (the bot tops
it up to 0.01 NEAR once, see ensureExchangeAccount in src/market.ts).

Named wallets have their own proof: `npm run named-proof`. The
latest run on 2026-11-07, with the swap proof wallet as the
configured creator, passed both parts on testnet. Part A, a fresh
user claiming a name they typed: create_account on the testnet
registrar created velocity-proof-87179.testnet with the wallet's own
public key (transaction
GHiqzjUpV2ydiDvFLFChqbWTojhwfBVFC4Zm3U2YUZwh). The account's access
key reads back as that exact public key with FullAccess permission,
the store record shows the name as primary with the hex wallet kept
as legacy, and a transfer of 0.0005 NEAR signed by the named account
landed (3bb7M9ds5XXa1zLp6UaG8vWnknnVTvnLGG3AavcaQUQV). Part B, the
sweep: a hex wallet funded with 0.05 NEAR
(Gfu6GmaKq9o5nBcqzPqRsXy7XDzBtYnjcYaeuMtZnvAX) and 0.01 wNEAR
(9Km17wo3YZsWm9XzVEQyFAbmowWozhLoAxhNpsaZe2qM) got the name
sweep-proof-87179.testnet (creation
9CNxsMnZoos74wyKiY1nVGrknr5hjRHGjgtLw9bBBtm8); the sweep moved the
full 0.01 wNEAR (DkRjhbL1CsYfgQRxwGNRmXh4mn5SDyifvEiDMkVucyZ2) and
0.0286 NEAR (AMi87x2k9fLQezBKwfaKWqbhhSbGUmMQm64fySHarknn) to the
name, and reported 0.018455 NEAR still on the old address openly,
with the address, as the best effort sweep is designed to do (the
NEAR leg reads the balance once, and that read can land while the
token sweep's calls are still settling).

## MAINNET

Velocity is mainnet ready as of 2026-11-07. With NEAR_NETWORK=mainnet
and the mainnet env block, every feature runs against the real
contracts below. Everything in this section was verified live by RPC
in read only mode; no mainnet funds were spent. The proofs that still
need a funded trade are listed plainly at the end.

### The verified mainnet contract set

Each entry verified live on 2026-11-07 (account exists with contract
code, metadata read, pool presence checked):

- Ref exchange: v2.ref-finance.near. get_number_of_pools read 9014
  simple pools. Config scans all of them on mainnet (bound 10000);
  the testnet bound of 500 would miss most mainnet pairs.
- DCL exchange: dclv2.ref-labs.near. About 6,300 pools at check time
  (the bot scanned 6497 entries inside its 6500 bound, the count
  includes pools with no liquidity). Config scans 6500 on mainnet.
- wNEAR: wrap.near (metadata symbol wNEAR, 24 decimals).
- USDC default: a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near
  (metadata name "Bridged USDC", symbol USDC.e, 6 decimals). The
  account usdc.near exists but holds no contract code and answers no
  ft_metadata, so it is not a token and is never used. The bridged
  token carries the depth: simple pool 3 against wrap.near held about
  10,991 wNEAR and 40,105 USDC.e, and its DCL pool at fee tier 2000
  quoted 363968 raw for 0.1 wNEAR, better than the simple pool's
  363788, so the route finder picks DCL for that pair.
- USDT default: usdt.tether-token.near (metadata name "Tether USD",
  symbol USDt, 6 decimals), the canonical Tether issued token.
  Simple pool 6063 against wrap.near held about 46,885 wNEAR and
  169,047 USDt, and it has liquid DCL pools at fee tiers 100 and
  2000. The bridged USDT.e token also exists with a deep simple pool
  (pool 4) but no liquid DCL pools, so the canonical token wins on
  route coverage. Through the bot's own route finder, 0.1 wNEAR
  quoted 365630 raw USDt via a simple pool on 2026-11-07.
- Registrar for named wallets: the near account, running the standard
  near-linkdrop contract (see the named wallets section for the
  evidence). velocitybot.near was still free to register at check
  time and is the recommended project account.

### DCL execution audit (2026-11-07)

The DCL swap path could never execute on testnet (no deployment
exists there), so for mainnet it was audited end to end against the
live contract and real transaction traces:

- Pool id format token_x|token_y|fee and the Swap message shape were
  re-confirmed from receipts executing on dclv2.ref-labs.near in live
  blocks; they match what the bot builds.
- Storage: the bot used to deposit storage on the DCL exchange
  before a first DCL swap. That is now removed. A live trace
  (transaction EcQntbawww1C3sxzme3PPPkibTzn3V2p4CboXJMjCFry) shows a
  swapper whose storage_balance_of on the DCL exchange is null
  completing a swap and receiving the output directly. Registration
  (bounds minimum 0.5 NEAR) is only needed for the exchange's other
  features, which aggregators use. Leaving the deposit in would have
  taken 0.5 NEAR out of a user wallet for no reason.
- Refunds: in the same trace, the swapper sent 300000000 raw and the
  pool used 217151273; the unused 82848727 came straight back through
  the token contract's resolve transfer, and the full output landed
  in the swapper's wallet in the same transaction. Slippage
  protection is the min_output_amount inside the swap message: if
  the pool cannot pay it, the swap fails inside the transfer call
  and the whole input is refunded the same way. The bot also checks
  that tokens actually arrived after every swap and says so plainly
  when they did not.
- Quotes: the bot's own route finder on mainnet config picked the
  DCL route for wNEAR to USDC (363968 raw, beating the simple pool)
  and the simple route for wNEAR to USDT (365630 raw, beating DCL)
  in the live mainnet smoke run. Route selection follows the money,
  not a preference.

### Safety rails on mainnet

- TRADING_ENABLED (default true). Set it false and buys, sells,
  trader alert buttons and AI copy executions all refuse plainly
  with a trading paused message, while balances, watch lists and
  info commands keep working. The bot logs the paused state at boot.
- MAX_TRADE_NEAR defaults to 5 on mainnet (10 on testnet). Every
  manual trade, alert button buy and AI copy trade is capped by it
  or by the stricter checks around it, exactly as on testnet.
- SLIPPAGE_BPS stays 100 (1 percent) on both networks.
- The AI daily loss limit has no network condition in its code: a
  copy wallet that loses its configured daily limit pauses until
  midnight UTC on mainnet exactly as on testnet.
- PnL cards follow the network: the pill reads NEAR on mainnet and
  NEAR TESTNET on testnet, and the caption matches. Samples were
  re-rendered on both settings on 2026-11-07 and checked by eye.

### Runbook: switching Velocity to mainnet

1. Register velocitybot.near from your mainnet wallet (about 0.1
   NEAR). This is the project account: fee wallet identity and named
   wallet creator in one. Save its seed phrase somewhere safe, never
   in this repo or in chat.
2. Create a SEPARATE mainnet Telegram bot in BotFather and use its
   token. Testnet users and data must never mix with real money, and
   a second bot is what keeps them apart.
3. Fill the mainnet env block from .env.example into a fresh .env:
   NEAR_NETWORK=mainnet, the mainnet RPC list, REF_EXCHANGE_ID,
   DCL_EXCHANGE_ID, WNEAR_ID, the two stablecoin ids (or delete those
   two lines and take the verified defaults), MAX_TRADE_NEAR=5, and
   DATA_DIR pointing at a new folder (./data-mainnet). Generate a
   fresh MASTER_KEY for mainnet and keep the testnet one for testnet.
4. Fee wallet: set FEE_ACCOUNT_ID=velocitybot.near and encrypt its
   key with `npm run smoke -- --encrypt-key "ed25519:..."`, pasting
   the output into FEE_ACCOUNT_SECRET_ENC. (An implicit fee wallet
   from `npm run make-fee-wallet` also works.) Fund it small: it only
   pays referral bonuses out.
5. Creator wallet: set CREATOR_ACCOUNT_ID=velocitybot.near and put
   its encrypted key in CREATOR_SECRET_ENC the same way, so the
   project account signs the registrar calls that create each user's
   own top level .near name (a user's name is never a subaccount of
   the project account; the project account only signs and pays).
   Fund it for the names you expect: each creation attaches 0.01
   NEAR that lands in the user's new account.
6. Run `npm run smoke`. On mainnet config it must print the mainnet
   RPC list, a live block height, 9014 simple pools, thousands of
   DCL pools, and two mainnet quotes (wNEAR to USDC and wNEAR to
   USDT) before you go any further.
7. Start the bot (`npm run dev`), /start it yourself, and fund your
   own bot wallet with a small amount.
8. Make a first tiny trade yourself: buy 0.1 NEAR of a liquid token
   (USDC or USDT exercise both route kinds between them), then sell
   it back. Check both transaction lists. Only then open the bot up,
   and consider raising MAX_TRADE_NEAR deliberately rather than by
   default.

Custody does not change on mainnet: per user hot wallets with keys
encrypted under MASTER_KEY, the Forge pattern, stated in the security
notes below. The session key policy vault remains an optional
hardening the owner has not chosen; it is not a setting in this bot.

### What only a funded mainnet trade can prove

Read only verification stops at the transaction boundary. Still
unproven until the first real trades land:

- A landed DCL swap by this bot (quote, message and refund behaviour
  are trace verified; execution by Velocity itself is not).
- A mainnet named wallet creation and sweep (the registrar contract
  evidence is strong and the flow is byte for byte the testnet one,
  but no .near name has been created by this bot yet).
- Fee capture and a referral payout moving on mainnet.
- The per user experience of the wider mainnet pool scan: the first
  quote after boot pays one full scan (about ten seconds in the
  smoke run), then the one minute cache carries the rest.

## Security notes

- Custody is per user funded hot wallets, the pattern Forge runs on:
  wallet keys are held encrypted with a master key from the
  environment. If the server is fully compromised, the master key is
  on the same box. That is exactly why the bot runs testnet first, and
  why each wallet should only ever hold what its owner chose to fund
  it with.
- Never commit .env. Never log a secret key. Keys only exist decrypted
  in memory at signing time.
- Per trade cap MAX_TRADE_NEAR is a rail, not a guarantee.
- NEAR mainnet is live with real money, unlike the Arch testnet Forge
  grew up on. Move to mainnet only after a verified testnet run and
  keep caps small. A session key policy vault (per trade caps, daily
  budgets, allowlisted contracts, expiry, on chain revocation) is a
  different custody design from the hot wallet pattern above; it only
  adds safety for a server run bot if the full access key leaves the
  server, which is a custody decision for the owner, not a setting.

## Tests

`npm test` runs the unit suite, 85 tests: referral fee math (discount
stops at trade 10, referrer credit continues for life, AI trades
excluded), PnL tier selection and average cost basis, raw amount
conversion, slippage math, the instant swap message format, DCL pool
id and swap message building, DCL route finding (best fee tier, two
hop chaining through wNEAR, zero liquidity pools skipped), best
route selection across simple and DCL pools, RPC endpoint parsing and
failover, the named wallet rules (typed name cleaning edge cases,
created ids always top level, NEAR amount parsing, creator
configuration defaults), the name prompt lifecycle at handler level
(prompt set at /start and by /name only when configured, a plain
reply claims, a command or "skip" clears it, a taken or unclean name
keeps it open and claims nothing), and the
mainnet readiness rules (per network contract selection, scan bounds
and per trade cap defaults, the TRADING_ENABLED switch refusing buys
and sells while paused, and the PnL network pill and caption wording
on both networks). `npm run typecheck` must
be clean. `npm run render-cards` writes one sample card per tier into
card-samples.


