// AutoTik AI Studio — flow-suite catalog — providers, models, and the 6
// "รายละเอียดคลิป" direction lists.
//
// ONE source of truth: this file is an ES module imported by BOTH the server
// (node, lib/flow-suite/server/*.js via dynamic import) and the web UI
// (<script type="module">, served at /lib/flow-suite/shared/catalog.mjs).
// Do not fork it into a browser copy.
//
// Ported near-verbatim from the BlueSPite reference project
// (C:\Users\Blue\Documents\Test\Blue SP_ai\shared\catalog.mjs) — model
// codenames, credits, and Thai copy are kept exact since they're the values
// actually sent to the Flow provider / shown to the operator.

// ---------------------------------------------------------------- image models
export const FLOW_IMAGE_MODELS = [
  { id: "NARWHAL", label: "Nano Banana 2" },
  { id: "GEM_PIX_2", label: "Nano Banana Pro" },
  { id: "IMAGEN_3_5", label: "Imagen 4" },
];

// ---------------------------------------------------------------- video models
// family: "r2v" takes referenceImages (the product photos) directly.
//         "i2v" needs a generated start frame first (startImageMediaId).
// credits: per clip, as observed on Flow Ultra x20. `free: true` = 0 credits.
// tiers:   which account tiers offer it. "x20" alone = Ultra x20 only.
export const FLOW_VIDEO_MODELS = [
  {
    id: "abra_r2v_4s", label: "Omni Flash 4s", group: "Omni Flash",
    family: "r2v", seconds: 4, credits: 7, tiers: ["x20", "x5", "below"],
  },
  {
    id: "abra_r2v_6s", label: "Omni Flash 6s", group: "Omni Flash",
    family: "r2v", seconds: 6, credits: 10, tiers: ["x20", "x5", "below"],
  },
  {
    id: "abra_r2v_8s", label: "Omni Flash 8s", group: "Omni Flash",
    family: "r2v", seconds: 8, credits: 12, tiers: ["x20", "x5", "below"],
  },
  {
    id: "abra_r2v_10s", label: "Omni Flash 10s", group: "Omni Flash",
    family: "r2v", seconds: 10, credits: 15, tiers: ["x20", "x5", "below"],
  },
  {
    id: "veo_3_1_r2v_lite_low_priority", label: "Veo 3.1 Lite ฟรี 8s", group: "Veo 3.1",
    family: "r2v", seconds: 8, credits: 0, free: true, tiers: ["x20"],
    note: "0 เครดิต — คิวช้ากว่า และมีเฉพาะบัญชี Ultra x20",
  },
  {
    id: "veo_3_1_r2v_lite", label: "Veo 3.1 Lite 8s", group: "Veo 3.1",
    family: "r2v", seconds: 8, credits: 5, tiers: ["x20", "x5", "below"],
    recommended: true,
  },
];

export const DEFAULT_VIDEO_MODEL = "veo_3_1_r2v_lite";
export const DEFAULT_IMAGE_MODEL = "NARWHAL";

// How many jobs the queue runner is allowed to run at once. Each lane owns one
// Flow room and runs its storyboard sequentially (image -> video -> image), so
// jobs may run in parallel without sharing media ids or room state.
export const MAX_CONCURRENCY = 150;
export const DEFAULT_CONCURRENCY = 1;
export const CONCURRENT_SAFE_MODELS = [
  "veo_3_1_r2v_lite_low_priority", "veo_3_1_r2v_lite",
  "abra_r2v_4s", "abra_r2v_6s", "abra_r2v_8s", "abra_r2v_10s",
];

// Both modes generate a storyboard image before the matching video. The only
// difference is whether the generated frame contains an AI-composed headline.
export const TEXT_MODES = [
  { id: "withText", label: "มีข้อความ (AI คิดหัวข้อโฆษณา)" },
  { id: "noText", label: "ไม่มีข้อความ (สร้าง Storyboard ไม่มีข้อความ)" },
];
export const DEFAULT_TEXT_MODE = "withText";

export function videoModel(id) {
  return FLOW_VIDEO_MODELS.find((m) => m.id === id) || null;
}

// Models offered for an account tier. Unknown/absent tier is treated
// optimistically as x20 so a slow account probe never hides the free option.
export function videoModelsForTier(tier = "x20") {
  const t = ["x20", "x5", "below"].includes(tier) ? tier : "x20";
  return FLOW_VIDEO_MODELS.filter((m) => m.tiers.includes(t));
}

export function modelSeconds(id) {
  return videoModel(id)?.seconds ?? 8;
}

// ------------------------------------------------ aspect ratios (Flow API labels)
export const ASPECTS_VIDEO = [
  { id: "portrait", label: "9:16 (แนวตั้ง)" },
  { id: "landscape", label: "16:9" },
];
export const ASPECTS_IMAGE = [
  { id: "portrait", label: "9:16" },
  { id: "landscape", label: "16:9" },
  { id: "square", label: "1:1" },
];

// --------------------------------------------- รายละเอียดคลิป (creative direction)
export const STYLE_OPTIONS = {
  videoStyle: [
    ["default", "AI เลือกให้"],
    ["silent-product", "ถือสินค้า (ไม่พูด)"],
    ["factory-line", "โรงงานผลิต"],
    ["department-store", "ห้างสรรพสินค้า"],
    ["department-store-holding", "ถือสินค้าในห้างสรรพสินค้า"],
    ["warehouse", "โกดัง"],
    ["warehouse-holding", "ถือสินค้าในโกดัง"],
    ["dance", "เต้น"],
    ["beach", "ทะเล"],
    ["summer", "Summer"],
    ["songkran", "สงกรานต์"],
    ["sampheng", "ตลาดสำเพ็ง"],
    ["fancy", "ของลอย"],
    ["authentic", "ใช้งานจริง"],
    ["promotional", "โปรโมท"],
    ["bobblehead", "หัวโต"],
    ["review", "ถือสินค้า"],
    ["live-commerce", "ไลฟ์สด"],
    ["cgi-giant", "CGI สินค้ายักษ์"],
    ["cartoon-3d", "การ์ตูน 3D"],
    ["asmr", "ASMR"],
    ["luxury", "Luxury"],
    ["vlog", "Vlog"],
    ["reaction", "Reaction"],
    ["model", "นายแบบ"],
    ["influencer", "อินฟลูฯ"],
    ["macro", "เนื้อสัมผัส"],
    ["unboxing", "แกะกล่อง"],
    ["mirror-selfie", "หน้ากระจก"],
    ["fashion", "แฟชั่น"],
    ["beauty", "บิวตี้"],
    ["shoes", "รองเท้า"],
    ["furniture", "ของใหญ่"],
    ["tools", "เครื่องมือ"],
  ],
  character: [
    ["young-woman", "สาวสวยยิ้มแย้ม"],
    ["young-man", "หนุ่มหล่อมั่นใจ"],
    ["middle-woman", "ผู้หญิงวัยกลางคน"],
    ["middle-man", "ผู้ชายวัยกลางคน"],
    ["cheerful-girl", "เด็กสาวร่าเริง"],
    ["energetic-guy", "เด็กหนุ่มกระตือรือร้น"],
    ["professional-woman", "นักธุรกิจหญิง"],
    ["professional-man", "นักธุรกิจชาย"],
    ["friendly-mom", "แม่บ้านอบอุ่น"],
    ["cool-dad", "พ่อบ้านเท่ๆ"],
    ["trendy-teen-girl", "วัยรุ่นหญิงทันสมัย"],
    ["trendy-teen-boy", "วัยรุ่นชายทันสมัย"],
    ["elder-woman", "ผู้หญิงสูงวัย"],
    ["elder-man", "ผู้ชายสูงวัย"],
    ["influencer", "อินฟลูเอนเซอร์"],
  ],
  background: [
    ["living-room", "ห้องนั่งเล่นสบายๆ แสงธรรมชาติ"],
    ["garden", "สวนหลังบ้าน บรรยากาศร่มรื่น"],
    ["cafe", "ร้านกาแฟน่านั่ง"],
    ["bedroom", "ห้องนอนอบอุ่น"],
    ["balcony", "ระเบียงบ้าน วิวสวย"],
    ["kitchen", "ครัวสะอาด สว่าง"],
    ["office", "ออฟฟิศทันสมัย"],
    ["beach", "ริมชายหาด ฟ้าสวย"],
    ["park", "สวนสาธารณะ ท้องฟ้าใส"],
    ["shopping-mall", "ห้างสรรพสินค้า"],
    ["rooftop", "ดาดฟ้าวิวเมือง"],
    ["studio", "สตูดิโอถ่ายรูป"],
    ["restaurant", "ร้านอาหารหรูหรา"],
    ["gym", "ฟิตเนสสมัยใหม่"],
    ["library", "ห้องสมุดเงียบสงบ"],
    ["home-office-minimal", "โฮมออฟฟิศสไตล์มินิมอล"],
    ["modern-living", "ห้องรับแขกโมเดิร์น"],
    ["japanese-workspace", "ห้องทำงานสไตล์ญี่ปุ่น"],
    ["reading-corner", "มุมอ่านหนังสือริมหน้าต่าง"],
    ["vintage-cafe", "คาเฟ่วินเทจบรรยากาศดี"],
    ["loft-kitchen", "ห้องครัวโมเดิร์นสไตล์ลอฟท์"],
    ["minimal-bedroom", "ห้องนอนมินิมอลสีขาว"],
    ["poolside-resort", "ริมสระน้ำบรรยากาศรีสอร์ท"],
    ["white-sand-beach", "หาดทรายขาวน้ำทะเลใส"],
    ["mountain-view", "ภูเขาวิวสวย"],
    ["forest", "ป่าไม้บรรยากาศร่มรื่น"],
    ["flower-garden", "สวนดอกไม้สีสันสดใส"],
    ["showroom", "โชว์รูมสินค้าทันสมัย"],
    ["luxury-hotel", "โรงแรมหรูบรรยากาศดี"],
    ["spa", "สปาผ่อนคลาย"],
  ],
  speakingStyle: [
    ["Enthusiastic", "ตื่นเต้น"],
    ["Professional", "มืออาชีพ"],
    ["Friendly", "เป็นมิตร"],
    ["Energetic", "มีพลัง"],
    ["Calm", "สงบ"],
    ["Persuasive", "โน้มน้าว"],
    ["Humorous", "ตลกขบขัน"],
    ["Informative", "ให้ข้อมูล"],
    ["Dramatic", "ดราม่า"],
    ["Casual", "สบายๆ"],
    ["Rapper", "แร็พเปอร์"],
  ],
  voiceType: [
    ["male-teen", "ชายวัยรุ่น"],
    ["male-young", "ชายหนุ่ม"],
    ["male-adult", "ชายวัยกลางคน"],
    ["male-elder", "ชายสูงอายุ"],
    ["male-deep", "ชายเสียงทุ้ม"],
    ["male-high", "ชายเสียงสูง"],
    ["male-energetic", "ชายกระตือรือร้น"],
    ["male-calm", "ชายเสียงนุ่มสุขุม"],
    ["male-presenter", "พิธีกรชาย"],
    ["male-narrator", "นักพากย์ชาย"],
    ["female-teen", "หญิงวัยรุ่น"],
    ["female-young", "หญิงสาว"],
    ["female-adult", "หญิงวัยกลางคน"],
    ["female-elder", "หญิงสูงอายุ"],
    ["female-sweet", "หญิงเสียงหวาน"],
    ["female-clear", "หญิงเสียงใส"],
    ["female-energetic", "หญิงกระตือรือร้น"],
    ["female-soft", "หญิงเสียงนุ่มนวล"],
    ["female-presenter", "พิธีกรหญิง"],
    ["female-narrator", "นักพากย์หญิง"],
  ],
  speechContentStyle: [
    ["promo-explain", "สายบอกโปร"],
    ["decision-push", "เน้นการตัดสินใจ"],
    ["product-story", "เล่าสินค้า"],
    ["detailed", "พูดรายละเอียด"],
    ["isan", "พูดอีสาน"],
  ],
};

// Ordered [key, form label] — drives the dropdowns in the Generate form, in order.
export const DIRECTION_FIELDS = [
  ["videoStyle", "Video Style"],
  ["character", "Character"],
  ["background", "Background"],
  ["speakingStyle", "Speaking Style"],
  ["voiceType", "ลักษณะเสียง"],
  ["speechContentStyle", "สไตล์บทพูด"],
];

// A blank pick means "unconstrained — let the model decide".
export const DIR_BLANK = ["", "AI เลือกให้"];
// Free-text override: the operator picks "กำหนดเอง" and the value is stored as
// `custom:<text>`.
export const CUSTOM_PREFIX = "custom:";
export const MAX_CUSTOM_DIRECTION_LEN = 300;

export function isCustomValue(v) {
  return typeof v === "string" && v.startsWith(CUSTOM_PREFIX);
}
export function customValueText(v) {
  return isCustomValue(v) ? v.slice(CUSTOM_PREFIX.length).trim() : "";
}
export function styleLabel(field, id) {
  if (isCustomValue(id)) return customValueText(id);
  const hit = (STYLE_OPTIONS[field] || []).find(([key]) => key === id);
  return hit ? hit[1] : id;
}
