// Regression test for server/media-store.mjs — order-number generation, per-order
// folders, and the local download/connect-log helpers. Uses isolated env overrides
// (BLUESPITE_DATA_DIR / BLUESPITE_MEDIA_DIR) so it never touches the operator's real
// data.json or Documents folder.

import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

const scratch = mkdtempSync(join(tmpdir(), "bluespite-media-test-"));
process.env.BLUESPITE_DATA_DIR = join(scratch, "data");
process.env.BLUESPITE_MEDIA_DIR = join(scratch, "media");

const media = await import("../server/media-store.mjs");

// ---------------------------------------------------------------- order numbers
console.log("\ngenOrderNumber -> XX-XXXX-XXX shape, English letters + digits only");
const first = media.genOrderNumber();
check("matches /^[A-Z]{2}-\\d{4}-\\d{3}$/", /^[A-Z]{2}-\d{4}-\d{3}$/.test(first), first);

console.log("\ngenOrderNumber -> sequence increments (sorts by creation order)");
const second = media.genOrderNumber();
const firstSeq = Number(first.split("-")[1]);
const secondSeq = Number(second.split("-")[1]);
check("second call's sequence is exactly one higher", secondSeq === firstSeq + 1, `${firstSeq} -> ${secondSeq}`);

console.log("\ngenOrderNumber -> 500 calls, no duplicate order numbers");
const seen = new Set([first, second]);
for (let i = 0; i < 500; i += 1) seen.add(media.genOrderNumber());
check("all 502 order numbers were unique", seen.size === 502, `got ${seen.size}`);

// ---------------------------------------------------------------- folders
console.log("\norderPaths -> creates and returns the 4 category folders under MEDIA_DIR");
const paths = media.orderPaths("KD-0007-482");
check("imagesDir under media/images", paths.imagesDir === join(process.env.BLUESPITE_MEDIA_DIR, "images"));
check("videoDir under media/video", paths.videoDir === join(process.env.BLUESPITE_MEDIA_DIR, "video"));
check("videoFinalDir under media/video-final", paths.videoFinalDir === join(process.env.BLUESPITE_MEDIA_DIR, "video-final"));
check("connectDir under media/connect", paths.connectDir === join(process.env.BLUESPITE_MEDIA_DIR, "connect"));
check("all 4 folders actually exist on disk", Object.values(paths).every(existsSync));

// ---------------------------------------------------------------- downloadToFile
console.log("\ndownloadToFile -> data: URI is decoded straight to disk, no fetch");
const dataDest = join(paths.imagesDir, "data-uri-test.mp4");
await media.downloadToFile("data:video/mp4;base64,ZmFrZS1tcDQtYnl0ZXM=", dataDest);
check("file exists with the decoded bytes", existsSync(dataDest) && readFileSync(dataDest, "utf8") === "fake-mp4-bytes");

console.log("\ndownloadToFile -> http(s) URL is fetched and written to disk");
const originalFetch = global.fetch;
global.fetch = async (url) => {
  if (url === "https://flow-content.google/signed/clip.mp4") {
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("remote-bytes").buffer };
  }
  throw new Error(`unexpected fetch ${url}`);
};
try {
  const urlDest = join(paths.videoFinalDir, "url-test.mp4");
  await media.downloadToFile("https://flow-content.google/signed/clip.mp4", urlDest);
  check("file exists with the fetched bytes", existsSync(urlDest) && readFileSync(urlDest, "utf8") === "remote-bytes");
} finally {
  global.fetch = originalFetch;
}

// ---------------------------------------------------------------- connect log
console.log("\nwriteConnectLog -> writes connect/<orderNumber>.json with the given payload");
const dest = media.writeConnectLog("KD-0007-482", { productName: "หมอนตุ๊กตาหมี", sceneCount: 2, status: "done" });
check("written to connect/KD-0007-482.json", dest === join(paths.connectDir, "KD-0007-482.json"));
const logged = JSON.parse(readFileSync(dest, "utf8"));
check("orderNumber + payload fields all present", logged.orderNumber === "KD-0007-482" && logged.productName === "หมอนตุ๊กตาหมี" && logged.sceneCount === 2, JSON.stringify(logged));

// ---------------------------------------------------------------- media URLs
console.log("\nmediaUrlFor -> absolute path under MEDIA_DIR becomes a /media/... URL");
const finalPath = join(paths.videoFinalDir, "KD-0007-482-final.mp4");
check(
  "video-final path -> /media/video-final/<file>",
  media.mediaUrlFor(finalPath) === "/media/video-final/KD-0007-482-final.mp4",
  media.mediaUrlFor(finalPath),
);

console.log("\nmediaUrlFor -> a path outside MEDIA_DIR returns empty (nothing to serve)");
check("outside path -> ''", media.mediaUrlFor("C:/somewhere/else/file.mp4") === "");

console.log("\nmediaUrlFor -> filename with characters that need URI-encoding stays a valid URL");
const spacedPath = join(paths.imagesDir, "order name with spaces.jpg");
check(
  "spaces are percent-encoded",
  media.mediaUrlFor(spacedPath) === "/media/images/order%20name%20with%20spaces.jpg",
  media.mediaUrlFor(spacedPath),
);

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : "all checks passed"}\n`);
process.exit(failures ? 1 : 0);
