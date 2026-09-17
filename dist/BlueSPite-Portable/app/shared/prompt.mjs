// Prompt builder — folds a product record + the 6 direction picks into the
// text sent to Flow. Shared by the server and the web UI (the UI renders a
// live preview from the same function, so what you see is what gets
// submitted).
//
// Ported near-verbatim from the BlueSPite reference project
// (C:\Users\Blue\Documents\Test\Blue SP_ai\shared\prompt.mjs).

import {
  STYLE_OPTIONS, DIRECTION_FIELDS, styleLabel, isCustomValue, customValueText,
  modelSeconds, DEFAULT_TEXT_MODE,
} from "./catalog.mjs";

// Random per-generation atmosphere.
const TIME_VARIATIONS = [
  "บรรยากาศตอนเช้าสดใส", "แสงกลางวันสว่างไสว", "บรรยากาศตอนบ่ายสบายๆ", "แสงเย็นอบอุ่น",
  "บรรยากาศตอนค่ำโรแมนติก", "แสงธรรมชาตินุ่มนวล", "บรรยากาศสดใส", "แสง soft light",
  "บรรยากาศตอนเช้ามื้อ", "แสงทอง golden hour",
];
const MOOD_VARIATIONS = [
  "บรรยากาศสดใสร่าเริง", "อารมณ์ผ่อนคลาย", "บรรยากาศกระตือรือร้น", "อารมณ์อบอุ่นเป็นกันเอง",
  "บรรยากาศมีชีวิตชีวา", "อารมณ์สงบเยือกเย็น", "บรรยากาศมั่นใจ", "อารมณ์สนุกสนาน",
  "บรรยากาศเป็นมิตร", "อารมณ์น่าตื่นเต้น",
];
const CAMERA_VARIATIONS = [
  "มุมกล้องใกล้ชิด", "มุมกล้องกว้าง", "มุมกล้องสูง", "มุมกล้องเตี้ย",
  "มุมกล้องปกติระดับสายตา", "โฟกัสที่สินค้าชัดเจน", "พื้นหลังเบลอสวย", "องค์ประกอบสมดุล",
];

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Thai prompt labels for each direction field — these are the words that actually
// land in the prompt (the form labels in DIRECTION_FIELDS are UI captions).
const DIRECTION_PROMPT_LABELS = {
  videoStyle: "สไตล์คลิป",
  character: "ตัวละคร",
  background: "ฉากหลัง",
  speakingStyle: "โทนการพูด",
  voiceType: "ลักษณะเสียง",
  speechContentStyle: "สไตล์บทพูด",
};

// Styles that must not contain speech at all.
const SILENT_STYLES = new Set(["silent-product"]);

// Hard safety rails — non-negotiable, always appended regardless of picks.
export const SAFETY_RULES = [
  "ตัวละครต้องเป็นผู้ใหญ่ (อายุ 18 ปีขึ้นไป) เท่านั้น — ห้ามมีเด็ก ทารก หรือผู้เยาว์ในภาพและวิดีโอเด็ดขาด",
  "ห้ามอ้างสรรพคุณทางการแพทย์ หรือการันตีผลลัพธ์",
  "ห้ามสร้างราคา ส่วนลด หรือโปรโมชันที่ไม่มีจริง และห้ามพูดตัวเลขราคา",
  "ห้ามอ้างข้อมูลที่ยืนยันไม่ได้ (อันดับ 1, ขายดีที่สุด, ของแท้ 100%, ส่งฟรี)",
  "ห้ามใส่โลโก้ ข้อความ หรือลายน้ำของแพลตฟอร์มอื่นในภาพ",
];

function clean(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

// Resolve one direction pick to its Thai prompt text. Returns "" for a blank pick so
// the caller can drop the line entirely and leave the model unconstrained.
function directionText(field, value) {
  const v = clean(value);
  if (!v) return "";
  if (isCustomValue(v)) return customValueText(v);
  if (field === "videoStyle" && v === "default") return "";
  return styleLabel(field, v);
}

/** Build the one-time identity reference used when the operator explicitly
 * chooses a character. It intentionally contains no product: the next image
 * step combines this identity image with the real product reference. */
export function buildCharacterPrompt(input = {}) {
  const direction = input.direction || {};
  const characterText = directionText("character", direction.character) || "adult UGC presenter";
  return [
    `Create one photorealistic identity reference image of this character: ${characterText}.`,
    "The character must clearly be an adult age 20 or older. If the description uses words such as girl, boy, or teen, interpret the visual style only and still depict an adult age 20–25.",
    "Single person, natural face, realistic skin texture, clean neutral studio background, soft even lighting, waist-up framing, looking toward camera.",
    "Keep the face, hairstyle, apparent age, body proportions, and clothing clearly visible so the same identity can be reproduced in later storyboard scenes.",
    "Do not show any product, package, brand, logo, advertising text, caption, watermark, collage, or additional person.",
    ...SAFETY_RULES,
  ].join("\n");
}

const TRIPLEBOT_EXTENDED_NEGATIVE_PROMPT = [
  "English speech", "voice change", "wrong gender voice", "text overlay", "headline",
  "title text", "on-screen text", "any visible text", "text distortions", "morphing text",
  "subtitles", "captions", "watermarks", "logos", "graphical elements", "blurry text",
  "UI elements", "any written characters", "labels", "numbers on screen",
  "text from previous clip", "carried over text", "inherited text overlay", "transition",
  "fade in", "fade out", "dissolve", "crossfade", "wipe", "slide transition",
  "cut to black", "face change", "face morph", "product redesign", "product change",
  "rushed speech", "fast talking", "price tag", "discount text", "percentage number",
  "before after comparison", "medical symbol", "promotional graphic",
  "exaggerated transformation", "third hand", "extra hand", "extra arm", "extra limb",
  "extra fingers", "six fingers", "deformed hands", "mutated hands",
  "malformed fingers", "fused fingers", "distorted anatomy",
].join(", ");

const TRIPLEBOT_EXTENDED_AUDIO_NEGATIVE_PROMPT = [
  "voice change", "different voice", "music", "background music", "instrumental",
  "melody", "wrong gender voice", "robotic voice", "scripted reading", "rushed speech",
  "fast talking", "unnatural pace", "speech cut off", "incomplete dialogue",
  "truncated speech", "delayed speech start", "silence at beginning", "improvised speech",
  "ad-lib dialogue", "extra words beyond script",
].join(", ");

function tripleBotVoiceSettings(direction = {}) {
  const raw = clean(direction.voiceType);
  const voiceGender = raw.startsWith("male-")
    ? "male"
    : raw.startsWith("female-") ? "female" : "same as previous clip";
  const voiceType = directionText("voiceType", raw) || "same voice type as previous clip";
  return { voiceGender, voiceType };
}

function tripleBotProductSubject(product = {}) {
  const brand = clean(product.brand);
  const category = clean(product.category);
  const name = clean(product.name);
  const source = [brand, category].filter((value) => value && value !== "-").join(" ")
    || (name && name !== "-" ? name : "สินค้าชิ้นนี้");
  if (source.length <= 64) return source;
  const clipped = source.slice(0, 64);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace >= 24 ? clipped.slice(0, lastSpace) : clipped).trim();
}

function tripleBotDefaultDialogue(product, isFinal) {
  const subject = tripleBotProductSubject(product);
  return isFinal
    ? `${subject} เป็นอีกตัวเลือกที่น่าสนใจ ใครกำลังมองหาสินค้าแบบนี้อยู่ กดดูรายละเอียดและตัวเลือกเพิ่มเติมที่ตะกร้าได้เลยนะ`
    : `มาดูรายละเอียดของ ${subject} กันต่อเลย เดี๋ยวหมุนให้เห็นรูปทรงและดีไซน์รอบ ๆ ชัดขึ้น เลือกดูให้ตรงกับแบบที่คุณชอบได้เลยนะ`;
}

/**
 * Build one Flow Extend Video prompt using TripleBot's continuation contract.
 * Scene indexes are zero-based: 1 is Extended #1 and 2 is Extended #2.
 * TripleBot always maps the final clip to its dedicated closing/CTA template.
 */
export function buildTripleBotExtendedPrompt(input = {}) {
  const sceneIndex = Math.max(1, Number(input.sceneIndex) || 1);
  const sceneCount = Math.max(sceneIndex + 1, Number(input.sceneCount) || sceneIndex + 1);
  const isFinal = sceneIndex === sceneCount - 1;
  const product = input.product || {};
  const productSubject = tripleBotProductSubject(product);
  const dialogue = String(input.dialogueScript || "").trim().slice(0, 5000)
    || tripleBotDefaultDialogue(product, isFinal);
  const sceneInstruction = String(input.sceneInstruction || "")
    .trim()
    .slice(0, 5000)
    .replace(/\{\{\s*สินค้า\s*\}\}/g, productSubject);
  const productFacts = productBlock(product);
  const { voiceGender, voiceType } = tripleBotVoiceSettings(input.direction || {});
  const action = isFinal
    ? "Final closing clip. The character delivers a strong call-to-action — pointing directly at the camera, giving a thumbs up, or making an inviting gesture (beckoning with hand). The energy should peak here with the most enthusiastic and persuasive delivery. End with a warm, confident smile and a final product showcase holding it up toward the camera."
    : "Character continues naturally, showing different product angles.";
  const visualContinuity = isFinal
    ? "Same character, same setting"
    : "Same character position and camera angle";
  const promptText = [
    "⚠️ ABSOLUTE RULES:",
    "1. ZERO TEXT ON SCREEN — no text, no titles, no headlines, no labels, no numbers, no letters, no captions, no watermarks. The screen must show ONLY the character and product. If the previous clip had text/headlines on screen, they must be COMPLETELY REMOVED in this clip. DO NOT carry over or continue any text from the previous clip.",
    "2. ZERO TRANSITIONS — no fade, no dissolve, no crossfade, no wipe, no cut to black. Continue seamlessly from the exact last frame without any transition effect.",
    "",
    "CRITICAL AUDIO RULE: DO NOT repeat or echo ANY words from the previous clip. The audio must start FRESH with the new dialogue below — no overlap, no repetition of the last sentence.",
    "",
    "AUDIO (MOST IMPORTANT):",
    "- The previous clip's audio has ALREADY ENDED",
    "- This clip's audio must be 100% NEW content",
    "- Start speaking the dialogue_script below from the FIRST WORD immediately",
    "- ZERO audio overlap with previous clip",
    "- DO NOT fade in or repeat previous audio",
    "",
    "VISUAL CONTINUITY:",
    "- Continue seamlessly from the exact last frame — no transition effects",
    `- ${visualContinuity}`,
    "- NO TEXT on screen",
    "",
    "SPEECH SETTINGS:",
    "- LANGUAGE: Thai (English brand names and product codes allowed, pronounce naturally)",
    `- VOICE GENDER: ${voiceGender}`,
    `- VOICE TYPE: ${voiceType}`,
    "- Same voice tone and speed as previous clip",
    "- SPEECH TIMING (CRITICAL — MUST OBEY):",
    "  * The ENTIRE dialogue_script MUST be spoken completely — every word, no skipping, no truncation",
    "  * Start speaking from the VERY FIRST FRAME — zero delay, zero silence at the start",
    "  * Finish ALL speech by 8 seconds — use the full clip duration, no wasted silence",
    "  * Pace: natural conversational Thai (~3 words per second) — relaxed, not rushed",
    "  * MUST spread speech evenly across the FULL 8 seconds — do NOT finish early and leave silence",
    "  * Add natural pauses and breathing between phrases to fill the full duration",
    "  * Do NOT add extra words beyond the dialogue_script — speak ONLY what is written",
    "  * Do NOT cut off the last sentence — the final word must be clearly audible",
    "- Speaking must sound completely natural — not scripted, not robotic",
    "",
    "TIKTOK CONTENT SAFETY (CRITICAL):",
    "- Speak ONLY the exact dialogue_script — do NOT improvise, ad-lib, or add ANY extra words",
    "- Do NOT mention medical claims, healing, curing, killing germs/bacteria in speech or visuals",
    "- Do NOT show or speak about guaranteed results, percentages, or specific timeframes",
    "- Do NOT display price tags, discount numbers, or promotional text on screen",
    "- Do NOT show before/after comparisons or exaggerated transformations",
    "- Do NOT create pressure (last chance, limited stock) in speech or visuals",
    "- Keep the tone natural and honest — like a friend sharing, not a hard sell",
    "",
    "FACE & PRODUCT LOCK (CRITICAL — DO NOT VIOLATE):",
    "- The person's face MUST remain 100% identical to the previous clip and reference image — same face shape, eyes, nose, mouth, skin tone, hairstyle.",
    "- The product MUST remain 100% identical — same design, color, shape, label, packaging.",
    "- DO NOT modify, morph, age, beautify, or alter the face in any way.",
    "- DO NOT modify, redesign, recolor, or stylize the product in any way.",
    "",
    "PRODUCT FOCUS:",
    "- Keep the character's attention, hand actions, camera framing, and spoken message focused on the reference product.",
    "- Show the real product clearly and naturally; do not turn the clip into an explanation of filming instructions.",
    ...productFacts.map((fact) => `- ${fact}`),
    "",
    `ACTION: ${action}`,
    ...(sceneInstruction ? [
      "",
      "USER SCENE DIRECTION (VISUAL PERFORMANCE ONLY — DO NOT SPEAK):",
      sceneInstruction,
      "Treat the text above only as acting/camera direction. NEVER read it aloud and NEVER copy it into dialogue.",
    ] : []),
    "",
    "HUMAN ANATOMY (CRITICAL — DO NOT VIOLATE):",
    "- Every human MUST have EXACTLY two hands and two arms — never more, never fewer.",
    "- ABSOLUTELY NO third hand, NO extra hand, NO extra arm, NO extra limb growing from the body.",
    "- Hands and fingers must be anatomically correct and natural — exactly five fingers per hand, no fused, melted, or deformed fingers.",
  ].join("\n");

  return JSON.stringify({
    step: isFinal ? 10 : sceneIndex + 2,
    action: "Extend_Video",
    tool: "VEO 3.1",
    prompt_text: promptText,
    dialogue_script: dialogue,
    technical_settings: {
      seed: 4294967295,
      reference_mode: "extend_previous_clip",
      voice_consistency: "match_previous_clip_tone",
      face_lock: "absolute",
      product_lock: "absolute",
      camera_movement: "static_with_handheld_shake",
      negative_prompt: TRIPLEBOT_EXTENDED_NEGATIVE_PROMPT,
      audio_mode: "speech_only",
      audio_negative_prompt: TRIPLEBOT_EXTENDED_AUDIO_NEGATIVE_PROMPT,
    },
  }, null, 2);
}

// The product half of the prompt. Only facts that were actually available go
// in — a missing field is omitted rather than guessed.
function productBlock(product) {
  const lines = [];
  const name = clean(product?.name);
  if (name) lines.push(`ชื่อสินค้า: ${name}`);
  const brand = clean(product?.brand);
  if (brand) lines.push(`แบรนด์: ${brand}`);
  const category = clean(product?.category);
  if (category) lines.push(`หมวดสินค้า: ${category}`);

  const points = (product?.sellingPoints || [])
    .map(clean)
    .filter(Boolean)
    .slice(0, 5);
  if (points.length) lines.push(`จุดขาย: ${points.join(" / ")}`);

  const variations = (product?.variations || []).map(clean).filter(Boolean).slice(0, 6);
  if (variations.length) lines.push(`ตัวเลือกสินค้า: ${variations.join(", ")}`);
  return lines;
}

/**
 * Build the prompt pair for one generate job.
 *
 * @param {object} input
 * @param {object} input.product   product record {name, brand, category, sellingPoints[], variations[], images[]}
 * @param {object} input.direction { videoStyle, character, background, speakingStyle, voiceType, speechContentStyle }
 * @param {string} input.videoModel model id — decides the clip length the speech must fit
 * @param {string} input.extraPrompt operator's free-text addition, appended last
 * @param {string} input.textMode "withText" (default, AI-composed header banner) or
 *   "noText" (still generate a storyboard frame, but forbid added on-screen text)
 * @returns {{ imagePrompt: string, videoPrompt: string, seconds: number, silent: boolean, textMode: string }}
 */
export function buildPrompt(input = {}) {
  const product = input.product || {};
  const direction = input.direction || {};
  const seconds = modelSeconds(input.videoModel);
  const style = clean(direction.videoStyle);
  const silent = SILENT_STYLES.has(style);
  const textMode = input.textMode === "noText" ? "noText" : DEFAULT_TEXT_MODE;

  const picks = [];
  for (const [field] of DIRECTION_FIELDS) {
    if (silent) {
      if (field === "speakingStyle" || field === "speechContentStyle") continue;
      if (field === "voiceType" && !isCustomValue(clean(direction.voiceType))) continue;
    }
    const text = directionText(field, direction[field]);
    if (text) picks.push(`${DIRECTION_PROMPT_LABELS[field]}: ${text}`);
  }

  const facts = productBlock(product);
  const extra = clean(input.extraPrompt);

  // ---- image prompt: every scene gets a storyboard frame ----
  const characterText = directionText("character", direction.character) || "The person";
  const backgroundText = directionText("background", direction.background)
    || `${pickRandom(TIME_VARIATIONS)}, ${pickRandom(MOOD_VARIATIONS)}`;

  const imageParts = [
    `Realistic photo, UGC style, natural lighting. ${characterText} is featured in a completely `
      + "randomized, high-quality lifestyle environment suitable for the reference product's usage. "
      + "The background context should be dynamic and varied, not fixed to any specific room type "
      + "like a kitchen, and determined solely by the nature of the product itself. The background "
      + "is blurred to keep focus on the subject. The character is positioned slightly lower in the "
      + "frame to leave empty space at the top for the text header. The character is holding or "
      + "presenting the reference product in an engaging, enthusiastic manner suitable to the "
      + "product's size and weight.",
    "",
    "PRODUCT FIDELITY — STRICT: Reproduce the reference product EXACTLY as shown in the reference "
      + "image. Keep the packaging shape, colours, logo, brand name and EVERY piece of text/label on "
      + "the product 100% identical to the reference. Do NOT recolor the product or shift its colour "
      + "temperature — never add a gold, amber, or warm tint; the product's own colour must match the "
      + "reference exactly. Do NOT redraw, restyle, translate, rephrase, blur or invent any text on the "
      + "product — all characters (including Thai text) must stay sharp, legible and pixel-faithful to "
      + "the original. Do not alter the product label layout or branding in any way.",
    "",
    "High quality, 4k, sharp focus on the product.",
    "",
    `Background style hint: ${backgroundText} — ${pickRandom(CAMERA_VARIATIONS)}.`,
  ];
  if (textMode === "withText") {
    imageParts.push(
      "",
      "Add a professional graphic design text overlay positioned strictly at the top center of the frame (Header/Banner style).",
      "Compose a short, punchy Thai advertising headline (large, bold, max ~8 words) from supplied facts only. Write real ad copy, not a plain repeat of the product name.",
      "Below it, add one smaller supporting subtitle. Do not invent features, claims, prices, or discounts.",
      "The typography and color palette must match the product packaging. Keep it at the very top, clear of the character's face.",
      "⚠️ CRITICAL: Render only the finished Thai headline and subtitle. Do not include prefix labels, codes, brackets, template markers, captions, watermarks, or unrelated logos.",
    );
  } else {
    imageParts.push(
      "",
      "NO AD OVERLAY: Do not add any headline, subtitle, caption, price tag, promotional badge, watermark, or extra logo anywhere in the image. Text already printed on the physical reference product must remain unchanged and legible.",
    );
  }
  if (facts.length) imageParts.push("", `Product details: ${facts.join(" / ")}`);
  if (extra) imageParts.push("", `Additional instruction from operator: ${extra}`);

  // NOT filter(Boolean) — imageParts intentionally includes "" entries as
  // blank-line paragraph separators; filtering them out would collapse every
  // section onto one dense block.
  const imagePrompt = imageParts.join("\n");

  // ---- video prompt: how that frame moves, plus the speech spec ----
  const videoParts = [
    `คลิปวิดีโอแนวตั้ง 9:16 ความยาว ${seconds} วินาที สำหรับโปรโมทสินค้าบน TikTok/Shopee`,
    "กล้องเคลื่อนนุ่มนวลต่อเนื่องไม่กระตุก โฟกัสที่สินค้าเป็นหลัก ไม่ตัดสลับฉากหลายครั้ง",
    "สินค้าต้องคงรูปเดิมตลอดคลิป — ห้ามให้สินค้าบิดเบี้ยว ละลาย หรือเปลี่ยนรูปทรง",
    textMode === "withText"
      ? "ถ้าในภาพมีข้อความปรากฏอยู่ (เช่น หัวข้อโปรโมชั่นหรือป้ายราคา) ข้อความนั้นต้องอยู่นิ่ง ชัดเจน อ่านออก "
        + "และคงอยู่ตลอดทั้งคลิปจนจบวิดีโอ ห้ามข้อความเลือนหาย บิดเบี้ยว หรือหายไปกลางคลิปเด็ดขาด"
      : "ห้ามเพิ่ม caption หัวข้อโฆษณา ป้ายราคา คำ ตัวเลข หรือลายน้ำใดๆ บนจอ "
        + "ยกเว้นข้อความและโลโก้ที่พิมพ์อยู่บนบรรจุภัณฑ์สินค้าต้นฉบับ ซึ่งต้องคงเดิมและอ่านได้",
    ...facts,
    ...picks,
  ];

  if (silent) {
    videoParts.push("ไม่มีบทพูดและไม่มีเสียงคนพูดในคลิป — เล่าเรื่องด้วยภาพและการเคลื่อนไหวเท่านั้น");
  } else {
    const lo = Math.round(seconds * 2.5);
    const hi = Math.round(seconds * 3.5);
    videoParts.push(
      `บทพูดภาษาไทย ${lo}-${hi} คำ พูดจบพอดีใน ${seconds} วินาที`,
      "ต้องเอ่ยชื่อสินค้าอย่างน้อย 1 ครั้ง",
      "พูดเหมือนคนจริงที่ใช้สินค้าแล้วอยากบอกต่อ ไม่ใช่พรีเซนเตอร์อ่านสคริปต์ — ใช้ภาษาพูดจริงของคนไทย",
      "เน้นความรู้สึก 1 อย่างที่ใช้แล้วรู้สึกได้ ไม่ต้องไล่ลิสต์คุณสมบัติ",
      "ปิดท้ายให้คนดูอยากซื้อ พูดมั่นใจมีพลัง ห้ามจบเบาๆ แบบ \"ลองดูนะ\"",
      "ห้ามพูดตัวเลขราคาหรือส่วนลด",
    );
  }
  if (extra) videoParts.push(`เพิ่มเติมจากผู้ใช้: ${extra}`);
  videoParts.push(`ข้อห้าม: ${SAFETY_RULES.join(" | ")}`);

  return {
    imagePrompt,
    videoPrompt: videoParts.filter(Boolean).join("\n"),
    seconds,
    silent,
    textMode,
  };
}

// Direction dropdown data for the UI, with the blank + custom entries folded in.
export function directionOptions(field) {
  return [["", "AI เลือกให้"], ...(STYLE_OPTIONS[field] || []), ["__custom__", "✎ กำหนดเอง…"]];
}
