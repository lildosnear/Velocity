import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  releaseUserLock,
  tryAcquireUserLock,
  UserBusyError,
  userLockHeld,
  withUserLock,
} from "../src/locks";

/**
 * Per user operation locks: one money operation at a time per user,
 * duplicates refused (never queued into a second trade), other users
 * unaffected, and the lock always releases.
 */

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("a concurrent duplicate for the same user is refused and the operation runs once", async () => {
  const gate = deferred();
  let runs = 0;
  const first = withUserLock(8801, async () => {
    runs += 1;
    await gate.promise;
    return "done";
  });
  // The lock is taken synchronously enough that a second invocation
  // in the same tick already sees it.
  await Promise.resolve();
  await assert.rejects(
    withUserLock(8801, async () => {
      runs += 1;
    }),
    (err: any) => err instanceof UserBusyError && /Still working on your last request/.test(err.message),
  );
  gate.resolve();
  assert.equal(await first, "done");
  assert.equal(runs, 1, "the operation body executed exactly once");
  assert.equal(userLockHeld(8801), false, "the lock released after completion");
});

test("a different user is never blocked by someone else's operation", async () => {
  const gate = deferred();
  const first = withUserLock(8802, async () => {
    await gate.promise;
    return "first";
  });
  await Promise.resolve();
  const second = await withUserLock(8803, async () => "second");
  assert.equal(second, "second");
  gate.resolve();
  assert.equal(await first, "first");
});

test("the lock releases when the operation throws", async () => {
  await assert.rejects(
    withUserLock(8804, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(userLockHeld(8804), false);
  const after = await withUserLock(8804, async () => "recovered");
  assert.equal(after, "recovered");
});

test("the acquire and release primitives pair up", () => {
  assert.equal(tryAcquireUserLock(8805), true);
  assert.equal(tryAcquireUserLock(8805), false);
  assert.equal(userLockHeld(8805), true);
  releaseUserLock(8805);
  assert.equal(userLockHeld(8805), false);
  assert.equal(tryAcquireUserLock(8805), true);
  releaseUserLock(8805);
});
