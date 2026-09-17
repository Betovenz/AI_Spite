// Regression test for the History page's persistence (server/store.mjs's
// recordHistory()/history()): before this existed, the web UI's History page
// rendered straight off store.jobs(), so clicking the Queue page's "ล้างงานที่จบแล้ว"
// (clear finished jobs) button — server.mjs's DELETE /api/jobs -> store.clearJobs()
// — silently wiped History too, since there was nowhere else the data lived. This
// pins that clearJobs() no longer touches history(), and that an old db file
// (predating the split) gets its finished jobs backfilled into history on load.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

console.log("\nclearJobs() no longer empties history()");
{
  const scratch = mkdtempSync(join(tmpdir(), "bluespite-history-test-"));
  process.env.BLUESPITE_DATA_DIR = scratch;
  const store = await import(`../server/store.mjs?scratch=${scratch}`);

  const done = store.addJob({ status: "done", productId: "p1", title: "finished job", orderNumber: "AB-0001-123" });
  const running = store.addJob({ status: "running", productId: "p2", title: "still mid-flight" });
  store.recordHistory({ jobId: done.id, orderNumber: done.orderNumber, title: done.title, status: "done" });

  check("history has the recorded entry", store.history().length === 1, String(store.history().length));

  store.clearJobs(null);   // the Queue page's "ล้างงานที่จบแล้ว" button — clears every non-running job
  check("clearJobs removed the finished job from jobs()", store.jobs().every((j) => j.id !== done.id));
  check("history() still has the entry after clearJobs()", store.history().length === 1, String(store.history().length));
  check("clearJobs never drops a mid-flight job", store.jobs().some((j) => j.id === running.id));

  rmSync(scratch, { recursive: true, force: true });
}

console.log("\nan old db file (predating the history/jobs split) backfills history() from jobs() on load");
{
  const scratch = mkdtempSync(join(tmpdir(), "bluespite-history-backfill-test-"));
  mkdirSync(scratch, { recursive: true });
  // No `history` key at all — simulates a db.json written before recordHistory()
  // existed, same shape store.mjs's emptyDb() produced back then.
  const legacyDb = {
    version: 1,
    settings: {},
    products: [],
    searches: [],
    jobs: [
      { id: "j1", status: "done", orderNumber: "CD-0002-456", title: "old finished job", finishedAt: 111 },
      { id: "j2", status: "failed", orderNumber: "EF-0003-789", title: "old failed job", finishedAt: 222 },
      { id: "j3", status: "queued", title: "never had an order number" },
      { id: "j4", status: "running", orderNumber: "GH-0004-000", title: "was mid-flight when the file was last written" },
    ],
    log: [],
    orderSeq: 4,
  };
  writeFileSync(join(scratch, "bluespite.json"), JSON.stringify(legacyDb), "utf8");

  process.env.BLUESPITE_DATA_DIR = scratch;
  const store = await import(`../server/store.mjs?scratch=${scratch}-backfill`);

  const backfilled = store.history();
  check("backfilled the 2 finished jobs with order numbers", backfilled.length === 2, String(backfilled.length));
  check("skipped the job with no order number", !backfilled.some((h) => h.jobId === "j3"));
  check("skipped the still-running job", !backfilled.some((h) => h.jobId === "j4"));
  check("kept the done job's fields", backfilled.some((h) => h.jobId === "j1" && h.orderNumber === "CD-0002-456"));
  check("kept the failed job's fields", backfilled.some((h) => h.jobId === "j2" && h.orderNumber === "EF-0003-789"));

  rmSync(scratch, { recursive: true, force: true });
}

console.log("\nclearHistoryByStatus() deletes only the given status, never all at once");
{
  const scratch = mkdtempSync(join(tmpdir(), "bluespite-history-clear-test-"));
  process.env.BLUESPITE_DATA_DIR = scratch;
  const store = await import(`../server/store.mjs?scratch=${scratch}-clear`);

  store.recordHistory({ jobId: "d1", orderNumber: "AA-0001-111", status: "done" });
  store.recordHistory({ jobId: "d2", orderNumber: "AA-0002-222", status: "done" });
  store.recordHistory({ jobId: "f1", orderNumber: "BB-0001-333", status: "failed" });
  store.recordHistory({ jobId: "c1", orderNumber: "CC-0001-444", status: "cancelled" });

  const removed = store.clearHistoryByStatus("done");
  check("reports 2 removed", removed === 2, String(removed));
  check("done entries are gone", !store.history().some((h) => h.status === "done"));
  check("failed entry untouched", store.history().some((h) => h.jobId === "f1"));
  check("cancelled entry untouched", store.history().some((h) => h.jobId === "c1"));
  check("clearing an empty status reports 0", store.clearHistoryByStatus("done") === 0);

  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : "all checks passed"}\n`);
process.exit(failures ? 1 : 0);
