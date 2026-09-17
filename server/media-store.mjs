// Local media output — order numbers, per-order folders, and the "Connect" log that
// ties an order number back to its product/link/final file. Kept separate from
// store.mjs (that's the app's own JSON db) because this module writes real media
// files to a user-visible folder, not the app's internal state.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { homedir } from "node:os";
import * as store from "./store.mjs";

// Overridable so a throwaway test bridge never writes into the operator's real
// Documents folder — same pattern as store.mjs's DATA_DIR.
export const MEDIA_DIR = process.env.BLUESPITE_MEDIA_DIR
  || join(homedir(), "Documents", "BlueSPite", "Generated Media");

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function randomLetters(n) {
  let out = "";
  for (let i = 0; i < n; i += 1) out += LETTERS[Math.floor(Math.random() * LETTERS.length)];
  return out;
}

function randomDigits(n) {
  let out = "";
  for (let i = 0; i < n; i += 1) out += Math.floor(Math.random() * 10);
  return out;
}

/**
 * `XX-XXXX-XXX` — 2 random English letters, a persisted 4-digit sequence (so files
 * sort in creation order), 3 random digits (collision safety — two orders created in
 * the same tick still get distinct numbers). English letters/digits only, no Thai, so
 * the number is always a safe filename/folder name on any filesystem.
 */
export function genOrderNumber() {
  const seq = store.nextOrderSeq();
  return `${randomLetters(2)}-${String(seq).padStart(4, "0")}-${randomDigits(3)}`;
}

/** Per-order folder paths, created on demand. Category-first (matches ref1's shipped
 *  layout), files inside named by order number — not one subfolder per order. */
export function orderPaths(orderNumber) {
  const paths = {
    imagesDir: join(MEDIA_DIR, "images"),
    videoDir: join(MEDIA_DIR, "video"),
    videoFinalDir: join(MEDIA_DIR, "video-final"),
    connectDir: join(MEDIA_DIR, "connect"),
  };
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  return paths;
}

/** Download a remote URL (or decode a `data:` URI) straight to a local file. No
 *  manual redirect/SSRF handling needed — unlike a public-facing app, every URL here
 *  was just handed back to us by Google's own Flow API, not supplied by an outside
 *  user, and Node's fetch already follows redirects by default. */
export async function downloadToFile(url, destPath, signal) {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    const meta = url.slice(5, comma);
    const bytes = meta.includes("base64")
      ? Buffer.from(url.slice(comma + 1), "base64")
      : Buffer.from(decodeURIComponent(url.slice(comma + 1)), "utf8");
    writeFileSync(destPath, bytes);
    return destPath;
  }
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`ดาวน์โหลดไฟล์ไม่สำเร็จ (HTTP ${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
  return destPath;
}

/** Turn an absolute path under MEDIA_DIR into the `/media/...` URL server.mjs serves
 *  it at — lets the video-preview popup play the LOCAL downloaded file (what the
 *  operator actually asked for) instead of the remote Flow URL, which can expire or
 *  need a Google-authed tab to open. Empty string if the path isn't under MEDIA_DIR
 *  at all (shouldn't happen — every caller here builds paths from orderPaths()). */
export function mediaUrlFor(absolutePath) {
  const rel = relative(MEDIA_DIR, absolutePath);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return "";
  return `/media/${rel.split(sep).map(encodeURIComponent).join("/")}`;
}

/** The per-order "Connect" log — what an order number actually is: product, link,
 *  scenes, and which file is the final video. One JSON file per order. */
export function writeConnectLog(orderNumber, payload) {
  const { connectDir } = orderPaths(orderNumber);
  const dest = join(connectDir, `${orderNumber}.json`);
  writeFileSync(dest, JSON.stringify({ orderNumber, ...payload }, null, 2), "utf8");
  return dest;
}
