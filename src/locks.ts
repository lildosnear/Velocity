/**
 * One operation at a time per user.
 *
 * Buys, sells, alert button executions, withdraws, recoveries and AI
 * copy executions for the same user all sign from the same wallet and
 * read-then-act on the same balances. Two of them running at once (a
 * double tap, a button tap while a command is still working, an auto
 * copy landing mid manual trade) race nonces and double spend. This
 * lock serializes them per user: a second invocation while one is
 * running is refused plainly and never starts a duplicate trade.
 * Different users never block each other, and the watcher tick itself
 * never takes a lock, so one slow trade cannot stall watching.
 *
 * Locks always release, including on exceptions: withUserLock
 * releases in a finally block.
 */

export class UserBusyError extends Error {
  constructor() {
    super("Still working on your last request, give it a moment.");
    this.name = "UserBusyError";
  }
}

const inFlight = new Set<number>();

export function tryAcquireUserLock(telegramId: number): boolean {
  if (inFlight.has(telegramId)) return false;
  inFlight.add(telegramId);
  return true;
}

export function releaseUserLock(telegramId: number): void {
  inFlight.delete(telegramId);
}

/** Whether a money operation is currently running for this user (tests and diagnostics). */
export function userLockHeld(telegramId: number): boolean {
  return inFlight.has(telegramId);
}

/**
 * Run fn under the user's lock. Throws UserBusyError immediately when
 * another operation for the same user is already running; the lock is
 * released whatever fn does.
 */
export async function withUserLock<T>(telegramId: number, fn: () => Promise<T>): Promise<T> {
  if (!tryAcquireUserLock(telegramId)) throw new UserBusyError();
  try {
    return await fn();
  } finally {
    releaseUserLock(telegramId);
  }
}
