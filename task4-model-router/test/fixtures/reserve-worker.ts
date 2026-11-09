// Worker thread used by rate-limiter.test.ts: opens its OWN connection to the shared db file
// (like a separate gateway process would) and races other workers to reserve tokens.
import { parentPort, workerData } from "node:worker_threads";
import { openDatabase } from "../../src/db.js";
import { SlidingWindowRateLimiter } from "../../src/rate-limiter.js";

const { dbPath, workerId, attempts, tokens, limit, start } = workerData as {
  dbPath: string; workerId: number; attempts: number; tokens: number; limit: number; start: Int32Array;
};
const db = openDatabase(dbPath);
const limiter = new SlidingWindowRateLimiter(db, { clock: () => 1_700_000_000_000, evictEvery: 0 });
parentPort?.postMessage("ready");
Atomics.wait(start, 0, 0); // start all workers at the same instant
let allowed = 0;
for (let i = 0; i < attempts; i++) {
  if (limiter.tryReserve("shared-tenant", limit, tokens, `w${workerId}-${i}`).allowed) allowed++;
}
db.close();
parentPort?.postMessage(allowed);
