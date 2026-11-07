/**
 * Chain readiness, shared between the boot sequence, the RPC layer
 * and the trade paths.
 *
 * The flag starts optimistic (true) so library style use and scripts
 * behave exactly as before. The bot's boot probe sets it from a real
 * check, the background probe in index.ts keeps it fresh, and the RPC
 * layer corrects it from real traffic: a signed operation that lands
 * marks the chain reachable, one that exhausts every endpoint marks
 * it unreachable. While the flag is false, trade paths refuse plainly
 * (see assertChainReady in market.ts) instead of surfacing raw RPC
 * errors to users.
 */

let chainReady = true;

export function isChainReady(): boolean {
  return chainReady;
}

export function setChainReady(ready: boolean): void {
  chainReady = ready;
}
