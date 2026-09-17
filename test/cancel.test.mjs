// Regression test for the "หยุด/ยกเลิก should stop right away" fix — AbortController
// wired through server/ext-link.mjs's command() and server/flow-client.mjs's fetch
// calls, so a cancel interrupts whatever's in flight instead of waiting for the next
// poll-loop checkpoint (up to a full POLL_INTERVAL_MS/CONCAT_POLL_INTERVAL_MS late).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

// ext-link.mjs imports store.mjs (for log()) — isolate DATA_DIR so noteHello()'s log
// write never touches the operator's real bluespite.json.
const scratch = mkdtempSync(join(tmpdir(), "bluespite-cancel-test-"));
process.env.BLUESPITE_DATA_DIR = scratch;

// ---------------------------------------------------------------- ext-link.mjs
console.log("\next-link command() -> aborts immediately instead of waiting out the timeout");
const ext = await import("../server/ext-link.mjs");
ext.noteHello({ installId: "test", version: "0.0.0" });   // mark "online" so command() doesn't reject for that reason

{
  const controller = new AbortController();
  const promise = ext.command("some.action", {}, 90_000, controller.signal);
  const start = Date.now();
  controller.abort();
  await assert.rejects(promise, /ยกเลิกโดยผู้ใช้/);
  const elapsed = Date.now() - start;
  check("rejects near-instantly, not after waiting on the 90s timeout", elapsed < 500, `${elapsed}ms`);
  check("no longer counted as in-flight after abort (pending map cleaned up)", ext.extStatus().inFlight === 0, JSON.stringify(ext.extStatus()));
}

console.log("\next-link command() -> already-aborted signal rejects without ever queuing the command");
{
  const controller = new AbortController();
  controller.abort();
  const before = ext.extStatus().queued;
  await assert.rejects(ext.command("another.action", {}, 90_000, controller.signal), /ยกเลิกโดยผู้ใช้/);
  check("never touched the outbox", ext.extStatus().queued === before);
}

console.log("\next-link command() -> a late settle() for an aborted command id is a harmless no-op");
{
  const controller = new AbortController();
  const promise = ext.command("late.settle", {}, 90_000, controller.signal);
  controller.abort();
  await assert.rejects(promise);
  // Can't reach the real id from outside, but settling a random unknown id must not
  // throw either way — this is the shape every late/duplicate settle() takes.
  const settled = ext.settle({ id: "not-a-real-pending-id", ok: true, result: {} });
  check("settle() on an unknown/already-cleaned id returns false, doesn't throw", settled === false);
}

// ---------------------------------------------------------------- flow-client.mjs
console.log("\nconcatenateVideos -> abort mid-poll rejects fast, not after CONCAT_POLL_INTERVAL_MS (5s)");
const flow = await import("../server/flow-client.mjs");
{
  const originalFetch = global.fetch;
  let pollCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes(":runVideoFxConcatenation")) {
      return { ok: true, status: 200, url: "", text: async () => JSON.stringify({ name: "op-1" }), json: async () => ({ name: "op-1" }) };
    }
    if (u.includes(":runVideoFxCheckConcatenationStatus")) {
      pollCalls += 1;
      // Always "pending" — the only way out of the poll loop here is the abort.
      return { ok: true, status: 200, url: "", text: async () => JSON.stringify({ status: "PENDING" }), json: async () => ({ status: "PENDING" }) };
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const controller = new AbortController();
    const promise = flow.concatenateVideos({
      accessToken: "AT123", cookieHeader: "cookie=abc", mediaIds: ["s1", "s2"], clipSeconds: 8,
      signal: controller.signal,
    });
    const start = Date.now();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(promise, /ยกเลิกโดยผู้ใช้/);
    const elapsed = Date.now() - start;
    check("rejects within ~1s of the abort, not after the 5s poll interval", elapsed < 1500, `${elapsed}ms, ${pollCalls} poll call(s)`);
  } finally {
    global.fetch = originalFetch;
  }
}

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : "all checks passed"}\n`);
process.exit(failures ? 1 : 0);
