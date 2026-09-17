// Regression test for shared/prompt.mjs's silent-style field dropping. Operator
// report: typed a custom "ลักษณะเสียง" (voiceType) value under the "ถือสินค้า
// (ไม่พูด)" (silent-product) video style, saved it, but it never showed up in the
// generated Prompt วิดีโอ. Root cause: buildPrompt() dropped voiceType outright for
// ANY silent style, on the assumption it only ever describes a speaking
// character's voice — true for the preset list (male/female/age/tone,
// catalog.mjs), but operators also use the same free-text box for audio-track
// direction unrelated to dialogue ("background music, no copyrighted tracks, no
// human voice at all") — exactly the instruction a silent clip needs most.
// speakingStyle/speechContentStyle stay dropped unconditionally — genuinely
// meaningless without any dialogue, no legitimate silent-mode use case.

import assert from "node:assert/strict";
import { buildPrompt } from "../shared/prompt.mjs";

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
}

const product = { name: "สินค้าทดสอบ", brand: "", category: "", sellingPoints: [], variations: [] };

console.log("\nbuildPrompt -> silent style (ถือสินค้า/ไม่พูด) + custom voiceType");
{
  const direction = {
    videoStyle: "silent-product",
    voiceType: "custom:เสียงดนตรี no copyright ห้ามมีเสียงมนุษย์",
    speechContentStyle: "custom:ไม่มีบท",
    speakingStyle: "custom:Energetic",
  };
  const out = buildPrompt({ product, direction, videoModel: "veo_3_1_r2v_lite_low_priority", textMode: "noText" });
  check("silent:true", out.silent === true);
  check(
    "custom voiceType text reaches the video prompt",
    out.videoPrompt.includes("ลักษณะเสียง: เสียงดนตรี no copyright ห้ามมีเสียงมนุษย์"),
  );
  check(
    "speechContentStyle line is still dropped (no label line for it)",
    !out.videoPrompt.includes("สไตล์บทพูด:"),
  );
  check(
    "speakingStyle line is still dropped (no label line for it)",
    !out.videoPrompt.includes("Speaking Style:"),
  );
}

console.log("\nbuildPrompt -> silent style + PRESET voiceType (not custom) still drops it");
{
  const direction = { videoStyle: "silent-product", voiceType: "male-young" };
  const out = buildPrompt({ product, direction, videoModel: "veo_3_1_r2v_lite_low_priority", textMode: "noText" });
  check(
    "a preset voice pick (implies a speaking character) is dropped, unlike a custom one",
    !out.videoPrompt.includes("ลักษณะเสียง:"),
  );
}

console.log("\nbuildPrompt -> non-silent style keeps voiceType regardless of custom/preset");
{
  const direction = { videoStyle: "custom:สไตล์อื่น", voiceType: "custom:เสียงดนตรี no copyright" };
  const out = buildPrompt({ product, direction, videoModel: "veo_3_1_r2v_lite_low_priority", textMode: "noText" });
  check("not silent", out.silent === false);
  check("voiceType line present as usual", out.videoPrompt.includes("ลักษณะเสียง: เสียงดนตรี no copyright"));
}

console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : "all checks passed"}\n`);
process.exit(failures ? 1 : 0);
