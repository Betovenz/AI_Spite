// Regression test for store.mjs's reconcileOrphanedJobs() — a job left "running" on
// disk from a bridge process that no longer exists can never be cancelled through
// the normal flow (no live AbortController survives a restart to receive the
// signal), so it must be swept to "failed" at the NEXT bridge startup instead of
// staying stuck forever.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

const scratch = mkdtempSync(join(tmpdir(), "bluespite-reconcile-test-"));
process.env.BLUESPITE_DATA_DIR = scratch;
const store = await import("../server/store.mjs");

console.log("\nreconcileOrphanedJobs -> a stuck 'running' job is swept to 'failed'");
const orphan = store.addJob({ status: "running", productId: "p1", title: "orphaned job", startedAt: Date.now() - 10 * 60 * 60 * 1000 });
const queued = store.addJob({ status: "queued", productId: "p2", title: "still queued" });
const done = store.addJob({ status: "done", productId: "p3", title: "already finished" });

const count = store.reconcileOrphanedJobs();
check("reports exactly 1 job reconciled", count === 1, String(count));

const afterOrphan = store.job(orphan.id);
check("the orphaned job is now failed", afterOrphan.status === "failed", afterOrphan.status);
check("carries an explanatory error", /บริดจ์|รีสตาร์ท/.test(afterOrphan.error), afterOrphan.error);
check("finishedAt got set", typeof afterOrphan.finishedAt === "number");

check("a queued job is untouched", store.job(queued.id).status === "queued");
check("an already-done job is untouched", store.job(done.id).status === "done");

console.log("\nreconcileOrphanedJobs -> no-op (and reports 0) when nothing is stuck");
const secondPass = store.reconcileOrphanedJobs();
check("returns 0 the second time — nothing left to reconcile", secondPass === 0, String(secondPass));

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : "all checks passed"}\n`);
process.exit(failures ? 1 : 0);
