import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_VIDEO_MODEL,
  FLOW_VIDEO_MODELS,
} from "../shared/catalog.mjs";
import {
  buildCharacterPrompt,
  buildPrompt,
  buildTripleBotExtendedPrompt,
} from "../shared/prompt.mjs";
import { ACTION as SERVER_ACTION } from "../shared/protocol.mjs";
import { ACTION as EXT_ACTION } from "../extension/src/lib/protocol.js";

assert.equal(DEFAULT_VIDEO_MODEL, "veo_3_1_r2v_lite");
assert.ok(FLOW_VIDEO_MODELS.length >= 6);
assert.ok(FLOW_VIDEO_MODELS.every((model) => model.family === "r2v"));

const product = { name: "กระเป๋าทดลอง", brand: "Blue", description: "น้ำหนักเบา" };
const noText = buildPrompt({ product, textMode: "noText", videoModel: DEFAULT_VIDEO_MODEL });
assert.match(noText.imagePrompt, /NO AD OVERLAY/);
assert.ok(noText.imagePrompt.length > 200, "noText must still generate a storyboard image prompt");

const character = buildCharacterPrompt({ direction: { character: "custom:ผู้หญิงผมยาว" } });
assert.match(character, /adult age 20 or older/i);
assert.match(character, /Do not show any product/i);

const extended = buildTripleBotExtendedPrompt({
  sceneIndex: 1,
  sceneCount: 2,
  product,
  sceneInstruction: "หมุนสินค้าเข้าหากล้อง",
});
assert.match(extended, /ZERO TRANSITIONS/);
assert.match(extended, /หมุนสินค้าเข้าหากล้อง/);
assert.match(extended, /call-to-action/i);

assert.equal(SERVER_ACTION.FLOW_EXTEND_SUBMIT, "flow.extendSubmit");
assert.equal(EXT_ACTION.FLOW_EXTEND_SUBMIT, SERVER_ACTION.FLOW_EXTEND_SUBMIT);
assert.equal(EXT_ACTION.FLOW_REFRESH_CAPTCHA, SERVER_ACTION.FLOW_REFRESH_CAPTCHA);

const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
assert.equal(manifest.version, "0.6.0");
assert.ok(manifest.host_permissions.includes("https://flow.google.com/*"));

const backgroundSource = readFileSync(new URL("../extension/src/background.js", import.meta.url), "utf8");
const runnerSource = readFileSync(new URL("../server/runner.mjs", import.meta.url), "utf8");
assert.match(backgroundSource, /const FLOW_TAB_WARMUP_MS = 15_000/);
assert.match(backgroundSource, /async function closeOtherFlowTabs/);
assert.match(backgroundSource, /let flowTabRefreshing = null/);
assert.match(backgroundSource, /Date\.now\(\) \+ 20_000/);
assert.match(backgroundSource, /await wait\(FLOW_TAB_WARMUP_MS\)/);
assert.match(runnerSource, /FLOW_MINT_CAPTCHA[\s\S]{0,100}150_000/);
assert.match(runnerSource, /FLOW_REFRESH_CAPTCHA[\s\S]{0,100}150_000/);

const scratch = mkdtempSync(join(tmpdir(), "bluespite-v020-test-"));
process.env.BLUESPITE_DATA_DIR = scratch;
try {
  const store = await import(`../server/store.mjs?version-test=${Date.now()}`);
  const saved = store.updateSettings({
    characterMode: "consistent",
    sceneMode: "continuous",
    sceneCount: 9,
    sceneVideoPrompts: ["หนึ่ง", "สอง", "สาม", "เกิน"],
  });
  assert.equal(saved.characterMode, "consistent");
  assert.equal(saved.sceneMode, "continuous");
  assert.equal(saved.sceneCount, 3);
  assert.deepEqual(saved.sceneVideoPrompts, ["หนึ่ง", "สอง", "สาม", "เกิน"]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("BlueSPite 0.2.0 update checks passed");
