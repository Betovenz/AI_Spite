# BlueSPite

## Version 0.2.0

อัปเดต Flow pipeline จากเวอร์ชันที่ใช้งานใน AutoTik AI Studio:

- ทุกโมเดลสร้างภาพ Storyboard ก่อนส่งเป็น Reference-to-Video
- เลือกตัวละครสุ่มหรือใช้ตัวละครคนเดียวกันทุกฉากได้
- เพิ่มโหมดฉากต่อเนื่องด้วย Flow Extended (สูงสุด 3 ฉาก)
- ใส่ Prompt วิดีโอแยกรายฉากได้ โดยเว้นว่างเพื่อใช้ค่าเริ่มต้น
- เก็บ checkpoint ก่อน poll, retry ในห้องเดิม และเปิดห้องใหม่เมื่อจำเป็น เพื่อลดการส่งงานซ้ำที่เสียเครดิต
- หยุดคิวอัตโนมัติเมื่อโควตาหมด และแยกคำเตือนเครดิตของโมเดลฟรี

> งานและฐานข้อมูลเดิมยังใช้ได้ โมเดล I2V เก่าที่ค้างในคิวจะถูกแปลงเป็นรุ่น R2V ที่เทียบเท่าเมื่อรัน

หาสินค้า Shopee → วิเคราะห์ → สแกนรายละเอียด → สร้างวิดีโอด้วย Google Flow
โดยมี **Chrome extension ชื่อ BlueSPite เป็นตัวกลางเพียงทางเดียว** ที่คุยกับเว็บต้นทาง

```
เว็บ (127.0.0.1)  ⇄  bridge (node)  ⇄  BlueSPite extension  ⇄  shopee.co.th / labs.google
```

bridge ไม่ยิง request ไปหา Shopee หรือ Google เองเลยแม้แต่ครั้งเดียว — ทุกอย่างเป็น
*command* ที่ extension เอาไปรันในแท็บที่คุณล็อกอินอยู่จริง แล้วส่งผลกลับมา

---

## เริ่มใช้งาน

```bash
npm start
```

หรือดับเบิลคลิก `start-bluespite.bat` (เปิดเบราว์เซอร์ให้ด้วย)

จากนั้นโหลด extension:

1. เปิด `chrome://extensions` → เปิด **Developer mode**
2. **Load unpacked** → เลือกโฟลเดอร์ `extension/`
3. ไอคอน BlueSPite จะขึ้นจุดเขียวเมื่อเจอ bridge

bridge ฟังที่ `127.0.0.1:24242` (ถ้าพอร์ตชนจะเลื่อนขึ้นไปเรื่อยๆ ถึง 24262)
extension สแกนช่วงเดียวกันเพื่อหาเอง — **ไม่ต้องตั้งค่าพอร์ตที่ไหนเลย**
ต้องมี Node.js 20 ขึ้นไป และไม่มี dependency ภายนอกแม้แต่ตัวเดียว

---

## 4 หน้าจอ

### 1. หาสินค้า
ค้นคีย์เวิร์ด → extension เรียก `api/v4/search/search_items` ในแท็บ Shopee ของคุณ →
bridge ให้คะแนนแต่ละรายการจาก 4 สัญญาณ แล้วเรียงจากมากไปน้อย

| สัญญาณ | คิดยังไง |
|---|---|
| ยอดขาย | log-scale (10→100 สำคัญกว่า 10,000→10,100) |
| เรตติ้ง | ถ่วงด้วยจำนวนรีวิว (เชื่อเต็มที่เมื่อ ≥30 รีวิว) |
| ราคาถูก | เทียบกันเองในผลค้นหาชุดนี้ |
| ค่าคอมฯ | ต้องล็อกอิน Shopee Affiliate (ติ๊ก "ดึงค่าคอมฯ") — ถ้าดึงไม่ได้จะข้ามไป ไม่ทำให้การค้นหาล้ม |

ปรับน้ำหนักได้ด้วยสไลเดอร์ แล้วเลือกสินค้า → **ส่งลิงก์ที่เลือกไปสแกน**

> คะแนนเป็นการ *เทียบกันเองภายในผลค้นหาชุดนั้น* ไม่ใช่คะแนนคุณภาพสินค้าแบบสัมบูรณ์
> — UI จึงโชว์แท่งของแต่ละสัญญาณกำกับไว้ข้างคะแนนรวมเสมอ

### 2. สแกนสินค้า
วางลิงก์ (หลายบรรทัดได้) → ดึง `api/v4/pdp/get_pc` เอา **รูปสินค้าทั้งหมด** ราคา
ยอดขาย เรตติ้ง ตัวเลือกสินค้า และสกัด "จุดขาย" ออกจาก description
รองรับลิงก์ย่อ `s.shopee.co.th` / `shope.ee` (extension เปิดแท็บเงียบๆ เพื่อขยายลิงก์ให้)

### 3. ตั้งค่า Prompt
ตั้งค่าครั้งเดียว ใช้กับทุกสินค้าที่กด "สร้างวิดีโอ" หรือ "ส่งสร้างวิดีโอทั้งหมด" จากหน้าสแกนสินค้า
(ไม่มีตัวเลือกสินค้าในหน้านี้แล้ว — เลือกสินค้าทำที่หน้าสแกนแทน) บันทึกอัตโนมัติทุกครั้งที่เปลี่ยนค่า
หรือกด **💾 บันทึกการตั้งค่า** เพื่อบันทึกทันที

- **รายละเอียดคลิป** 6 ช่อง ยกมาจาก ref2 ทั้งชุด (Video Style / Character / Background /
  Speaking Style / ลักษณะเสียง / สไตล์บทพูด) — ทุกช่องมี "✎ กำหนดเอง" พิมพ์เองได้
- **ตัวอย่าง Prompt** ทางขวา — สุ่มสินค้าที่สแกนไว้มาโชว์ prompt จริงที่จะถูกส่ง (ใช้ฟังก์ชัน
  เดียวกับที่ runner ใช้ผ่าน `shared/prompt.mjs` — เห็นอย่างไรส่งอย่างนั้น) เปลี่ยนค่าด้านซ้ายแล้ว
  พรีวิวอัปเดตทันทีโดยไม่ต้องสุ่มใหม่
- **🧪 ทดสอบสร้างรูป** — ยิงไปสร้างภาพจริงกับ Flow (เสียเครดิตจริงตามโมเดลภาพที่เลือก) แล้วโชว์รูป
  ให้ดูตรงนั้นเลย ก่อนจะสั่งสร้างวิดีโอทั้งงานจริง ใช้ endpoint เดียวกับขั้นภาพของ I2V
  (`server/runner.mjs`'s `testGenerateImage()`) แค่ไม่มีขั้นวิดีโอ/poll ต่อ
- **จำนวนฉาก** — แต่ละฉากเจนภาพ+วิดีโอแยกกันเอง (สุ่มบรรยากาศ/มุมกล้องใหม่ทุกฉาก) แล้วต่อรวมเป็น
  วิดีโอเดียวตอนจบงาน ดู "ฉากหลายฉาก" ด้านล่าง

### 4. คิว & ผลงาน
รัน / หยุด / ลองใหม่ — งานในแต่ละ lane เว้นช่วง 8 วินาทีระหว่างงาน (ปรับด้วย `BLUESPITE_JOB_GAP_MS`,
ค่าตั้งใจของ BlueSPite เอง ไม่ได้อิงจาก ref1) `PUBLIC_ERROR_UNUSUAL_ACTIVITY` เป็น error จริงที่ Flow
คืนได้ (ยืนยันจาก `flow-engine.mjs`) แต่ละงานมี **เลขออเดอร์** (เช่น `KD-0007-482`) ติดไว้บนการ์ด —
เลขเดียวกันนี้ใช้ตั้งชื่อไฟล์ทุกไฟล์ที่เจนออกมา และโชว์ซ้ำที่หน้าสแกนสินค้าด้วย (ใต้สินค้าที่เคยส่งเข้าคิว)

**หยุด/ยกเลิก หยุดทันที ไม่ใช่ "หยุดหลังงานปัจจุบันจบ"** — แต่ละงานที่กำลังรันมี `AbortController`
ของตัวเอง (ตรงกับ pattern `controller.abort()` ของ ref1's `stopProjectRunners()`) ผูกเข้ากับทุก
fetch ที่ยิงไป Flow (`server/flow-client.mjs`) และทุกคำสั่งที่ส่งไป extension
(`server/ext-link.mjs`'s `command()`) กด **ยกเลิก** งานหนึ่งงาน หรือ **หยุด** ทั้งคิว จะ abort งานที่
กำลังรันอยู่ทันที ไม่ต้องรอถึงรอบ poll ถัดไป (เดิมอาจช้าได้ถึง 6 วิ/รอบ) หรือรอ generate/upload
ที่ค้างอยู่ให้จบก่อน — การรอ (sleep) ทุกจุดในคิวก็ abort ได้ทันทีเหมือนกัน (`server/runner.mjs`)

**จำนวนคิวพร้อมกัน** (หน้าตั้งค่า Prompt) — รันได้สูงสุด **150 งานพร้อมกัน** แทนที่จะรันทีละงาน
เช็คโค้ดจริงของ ref1 แล้ว (`bridge/project-runner.mjs`'s `startProjectRunners()`) — สำหรับ Google
Flow มันเคลมคิวได้ทีละ 150 รายการ (`lib/data/queue.ts`, `LIMIT 150` — เป็นที่มาของเพดาน 150 ที่นี่
ด้วย) แล้วยิงทุกตัวพร้อมกันทันที (`for (const context of contexts) void run(context)`)
**ไม่มีการเหลื่อมเวลาเลย** (ตรงข้ามกับ provider Grok ของมันที่ล็อกไว้ทีละ 1 ที่ระดับ DB) เซฟตี้เน็ตจริง
ของ ref1 สำหรับ Flow ไม่ใช่การเหลื่อมเวลา แต่คือ error-classification retry ใน
`bridge/flow-engine.mjs` — พอร์ตมาตรง ๆ เป็น `withFlowErrorModel()`: เจอ
captcha/permission/unusual-activity/403 → ขอ captcha ใหม่แล้วลองอีกครั้ง, เจอ 429/rate-limit →
รอ 1 วิแล้วลองอีกครั้ง, นอกนั้นพังทันทีเหมือนเดิม (ไม่มี blind-retry วนไม่จบ) BlueSPite เลยยิงทุก
lane พร้อมกันทันทีเหมือน ref1 เช่นกัน (`LANE_STARTUP_STAGGER_MS` ค่าเริ่มต้น 0 — ปรับได้ผ่าน env
ถ้าอยากได้ ramp-up แทน) การรีเฟรช session/401 ไม่ได้พอร์ตมา — access token ไม่ได้หมดอายุกลางงาน
แบบ captcha token/rate-limit

**แต่ละงาน (ไม่ใช่แต่ละ lane) มีโปรเจกต์ Flow เป็นของตัวเอง** — ตรงกับ ref1 ที่ 1 โปรเจกต์ = 1
วิดีโอเสมอ (กู้คืนได้ผ่าน `scene.recovery.flowProjectId`) ไม่ได้ใช้ซ้ำข้ามงานแม้จะอยู่ lane เดียวกัน —
lane หนึ่งรับ 5 งานติดกันก็สร้างโปรเจกต์ใหม่ 5 โปรเจกต์ ไม่ใช่ใช้โปรเจกต์เดียวซ้ำ
(`server/runner.mjs`'s `ensureFlowSession()`)

เมื่อตั้งคิวพร้อมกัน >1 **เลือกโมเดลวิดีโอได้เฉพาะ Omni Flash กับ Veo 3.1 Lite ฟรี**
(`shared/catalog.mjs`'s `CONCURRENT_SAFE_MODELS`) — I2V ต้องมีขั้น `generateImage()` เพิ่มก่อนขั้น
วิดีโอเสมอ ทำให้ทราฟฟิกไปหา Flow ต่อ 1 คิวพร้อมกันสูงเป็น 2 เท่า ข้อจำกัดนี้เป็นการตัดสินใจของ
BlueSPite เอง ไม่ใช่สิ่งที่มาจาก ref1

### Log dock (มุมขวาล่าง ทุกหน้า)
กดแถบ **Log** เพื่อเปิด/ปิด (จำสถานะไว้ใน localStorage) ข้างในแยก **ทั่วไป / Dev**
เป็นแท็บสองโหมด — สไตล์เดียวกับ log popup ของ ref1 (`logMode: "general" | "dev"` ใน
`tiktok-web-client.tsx`):

| โหมด | โชว์อะไร |
|---|---|
| **ทั่วไป** (ค่าเริ่มต้น) | เฉพาะบรรทัดความคืบหน้า/คำเตือน/ข้อผิดพลาด — "ค้นหา Shopee…", "สแกนแล้ว…", "เสร็จ…", "ล้มเหลว: …" อ่านง่าย ไม่มีสัญญาณรบกวน |
| **Dev** | ทั่วไป + **หนึ่งบรรทัดต่อหนึ่ง fetch** (`level:"debug"`) — URL เต็ม, เวลาที่ใช้, สำเร็จ (`✓`) หรือพัง (`✗` + HTTP status) — ตอบคำถาม "ดึง API มาไหม" |

บรรทัด `debug` มาจากทั้ง content script (`__trace` ใน `shopee.js`) และ bridge เอง
(`flow-client.mjs` → `reportFlowTrace()` ใน `runner.mjs`) แล้วส่งกลับมาพร้อมผลลัพธ์
สลับโหมดได้ตลอด ไม่กระทบข้อมูลที่เก็บไว้จริง (แค่ตัวกรองการแสดงผล)

แต่ละบรรทัดเป็น **การ์ด** (ไอคอน + หัวข้อ + เวลาแบบสัมพัทธ์ "50 วินาทีที่แล้ว" — สไตล์เดียวกับ
Logs popup ของ ref1 ในแอปจริง) ในโหมด Dev บางบรรทัด (job เริ่ม/เสร็จ/ล้มเหลว, ค้นหา, สแกน,
เข้าคิว) จะมีกล่อง **Event + JSON metadata** ขยายออกมาด้านล่าง — ตรงกับ `{stage, metadata}`
ของ ref1 เป๊ะ (`store.log(msg, level, meta)` ใน `store.mjs` รับ `meta` ไม่บังคับ)
มีช่องกรองข้อความ + ปุ่มคัดลอกไว้แปะเวลาถามต่อ

---

## โมเดล

codename ทุกตัวยืนยันมาจาก ref1/ref2 (ค่าที่ส่งไป provider ต้องตรงเป๊ะ ห้ามเดา):

| โมเดล | codename | ยาว | เครดิต |
|---|---|---|---|
| **Omni Flash 4s/6s/8s/10s** | `abra_r2v_{4,6,8,10}s` | 4–10s | 7 / 10 / 12 / 15 |
| **Veo 3.1 Lite ฟรี** | `veo_3_1_r2v_lite_low_priority` | 8s | **0** (Ultra x20 เท่านั้น) |
| Veo 3.1 Lite | `veo_3_1_r2v_lite` | 8s | 5 |
| Veo 3.1 I2V Lite ฟรี | `veo_3_1_i2v_lite_low_priority` | 8s | **0** (Ultra x20 เท่านั้น) |
| Veo 3.1 I2V Lite / Fast | `veo_3_1_i2v_lite` / `..._s_fast_portrait_ultra` | 8s | 5 / 10 |

**ค่าเริ่มต้นคือ Veo 3.1 I2V Lite (ตระกูล I2V)** — ตรงกับ flow หลักของ ref2 เป๊ะ ("Clip 8s"
โหมดหลักของ Triple Bot คือ "สร้างภาพก่อน แล้วต่อเป็นวิดีโอทันที") คือ**สร้างภาพจากรูปสินค้าก่อน
1 ขั้น แล้วค่อยเอาภาพนั้นไปสร้างวิดีโอ** (`generateImage()` → `startVideoFromImage()`)
ข้อดีคือคุมหน้าตาภาพได้ก่อนเข้าวิดีโอ (ปรับสไตล์/ฉากหลัง/แสงผ่าน prompt ภาพได้เต็มที่)

ตระกูล **R2V** (Omni Flash + Veo Lite R2V) ยังเลือกได้ — รับรูปสินค้าเป็น `referenceImages`
ตรงๆ ข้ามขั้นสร้างภาพไปเลย เร็วกว่า/เครดิตต่อคลิปอาจถูกกว่า แต่คุมสไตล์ภาพได้น้อยกว่า

โมเดล 0 เครดิตจะโชว์เฉพาะเมื่อ tier เป็น Ultra x20 (extension อ่าน tier จากหน้า Flow
แล้วรายงานกลับมา; ถ้าอ่านไม่ได้จะถือว่าเป็น x20 ไว้ก่อน ไม่ซ่อนตัวเลือกฟรีทิ้ง)

---

## ฉากหลายฉาก + ไฟล์ในเครื่อง

พอร์ตมาจากแนวคิด "จำนวนฉาก" ของ ref1 — 1 งาน มีได้กี่ฉากก็ได้ (ไม่จำกัดในช่อง UI; ref1 เองจำกัด
ไว้ที่ 10 แต่ BlueSPite ไม่ใส่เพดาน) แต่ละฉากเจนภาพเฟรมแรก + วิดีโอของตัวเองแยกกันสมบูรณ์
(สุ่มบรรยากาศ/มุมกล้องใหม่ทุกครั้งที่เรียก `buildPrompt()`) รันทีละฉากตามลำดับเหมือนที่รันทีละงาน
(เหตุผลเดียวกัน — เลี่ยงโดน Flow มองเป็นบอท)

**การต่อฉาก (merge) ไม่ได้ใช้ ffmpeg เลย** — ตรวจโค้ดจริงของทั้ง ref1 (ต่อด้วย ffmpeg แบบ WASM
ที่ยืมมาจากโปรเจกต์อื่น) และ ref2 (`labs_generate.pyc`) แล้วพบว่า ref2 ใช้ **Flow เองเป็นคนต่อ
วิดีโอให้** ผ่าน `POST …:runVideoFxConcatenation` (ส่ง `mediaGenerationId` ของทุกฉากตามลำดับ)
แล้ว poll `…:runVideoFxCheckConcatenationStatus` จนได้วิดีโอรวม — Bearer token อย่างเดียว
ไม่ต้อง reCAPTCHA ไม่ต้องเพิ่ม dependency ใดๆ เลย (`server/flow-client.mjs`'s
`concatenateVideos()`) **ถ้ามีแค่ 1 ฉาก จะข้ามขั้นต่อวิดีโอไปเลย** — ฉากเดียวนั้นก็คือวิดีโอสุดท้าย

### เลขออเดอร์

รูปแบบ `XX-XXXX-XXX` (ตัวอักษรอังกฤษ 2 ตัวสุ่ม + เลขรัน 4 หลัก + เลขสุ่ม 3 หลัก เช่น
`KD-0007-482`) เจนตอนกดสร้างวิดีโอ (`server/media-store.mjs`'s `genOrderNumber()`) เลขรัน
กลางเก็บถาวรใน `bluespite.json` (`store.nextOrderSeq()`) ไฟล์ทุกไฟล์ของงานนั้นตั้งชื่อด้วยเลขนี้

### โฟลเดอร์

ค่าเริ่มต้นอยู่ที่ `Documents/BlueSPite/Generated Media/` (ปรับด้วย `BLUESPITE_MEDIA_DIR`
เหมือน `BLUESPITE_DATA_DIR`) แยกตามประเภทไฟล์ — **ไม่ปนกันเหมือน ref1** (ref1 เก็บคลิปฉากกับ
วิดีโอสุดท้ายไว้โฟลเดอร์เดียวกัน แยกแค่ชื่อไฟล์):

```
Generated Media/
  images/        KD-0007-482-scene-1.jpg, -scene-2.jpg, …   (เฟรมแรกของทุกฉาก)
  video/         KD-0007-482-scene-1.mp4, -scene-2.mp4, …   (คลิปแต่ละฉาก — มีเฉพาะเมื่อ ≥2 ฉาก)
  video-final/   KD-0007-482-final.mp4                      (วิดีโอรวม หรือฉากเดียวถ้ามีฉากเดียว)
  connect/       KD-0007-482.json                           (ดูด้านล่าง)
```

`connect/<เลขออเดอร์>.json` คือ log สั้นๆ ต่อออเดอร์ ("Connect" — เลขนี้คือสินค้าอะไร ลิงก์ไหน
วิดีโอสุดท้ายอยู่ไฟล์ไหน) แนวคิดยกมาจาก ref2's `job_archive.pyc` (โฟลเดอร์ต่อ job พร้อม
`log.txt`/`job.json`) — BlueSPite ทำเป็นไฟล์ JSON เดียวพอ: `{orderNumber, productId,
productName, productUrl, videoModel, sceneCount, textMode, scenes:[{index,image,video}],
finalVideo, status, createdAt, finishedAt}`

---

## โครงสร้าง

```
shared/          ← import ทั้งจาก node และจากเบราว์เซอร์ (แหล่งความจริงเดียว)
  protocol.mjs     message types + port discovery
  catalog.mjs      โมเดล + 6 direction lists
  prompt.mjs       ตัวประกอบ prompt
server/
  server.mjs       HTTP + SSE + static
  ext-link.mjs     long-poll command broker
  shopee.mjs       parse ลิงก์ + normalise + ให้คะแนน
  runner.mjs       drain คิวทีละงาน วนฉาก + ต่อวิดีโอ + เซฟลงเครื่อง
  flow-client.mjs  Google Flow direct API (image/video/concat)
  media-store.mjs  เลขออเดอร์ + โฟลเดอร์ + ดาวน์โหลดไฟล์ + Connect log
  store.mjs        JSON store (atomic write)
  fake-extension.mjs  ตัวปลอมไว้เทสต์โดยไม่ต้องเปิด Chrome
web/             index.html · app.js · styles.css
extension/       manifest + background SW + content scripts
data/            bluespite.json (สร้างเอง)
```

`shared/protocol.mjs` มีสำเนาที่ `extension/src/lib/protocol.js` เพราะ extension
import ข้ามโฟลเดอร์ตัวเองไม่ได้ — **แก้ไฟล์ไหนต้องแก้อีกไฟล์ด้วย** (กติกาเดียวกับ ref1/ref2)

---

## เทสต์โดยไม่ต้องเปิด Chrome

```bash
node server/fake-extension.mjs
```

ตัวปลอมพูดโปรโตคอล `/ext/*` เหมือนของจริงทุกอย่าง แล้วตอบด้วยข้อมูลจำลอง
ใช้ไล่ search → scan → queue → run ได้ครบ flow (ยืนยันแล้วว่าผ่านทั้งเส้น)
แต่ **ไม่ได้พิสูจน์อะไรเกี่ยวกับ DOM จริงของ Shopee/Flow**

```bash
npm test
```

รัน `shopee.js` ใน sandbox ที่จำลอง browser — เช็ค 4 เคสของชั้นขนส่ง:
helper มี / helper หาย (แท็บเก่า) / Shopee ตอบ HTML แทน JSON / HTTP 403

---

## Google Flow — direct API (ไม่ใช่ DOM automation)

รอบแรกที่ทำ `flow.js` ใช้วิธีจำลองการคลิกในหน้า Flow ซึ่ง**ไม่เคย verify กับหน้าจริง**
เลย — พอทดสอบจริงพังตามคาด (หาช่อง prompt ไม่เจอ) จึงเปลี่ยนมาใช้วิธีเดียวกับที่ ref1/ref2
ทำจริง: **เรียก API ภายในของ Flow ตรงๆ** (endpoint เดียวกับที่หน้าเว็บ Flow เองเรียกตอนกด
"Create") แทนการคลิก UI

ยืนยัน endpoint/header/body ทุกจุดด้วยการ **โหลด `labs_generate.pyc` ที่คอมไพล์ไว้แล้วของ
ref2 ด้วย Python 3.11 โดยตรง** (`.pyc` รันได้เลยไม่ต้อง decompile) แล้ว disassemble ฟังก์ชัน
ที่เกี่ยวข้อง — ไม่ใช่การเดา:

| ขั้นตอน | เรียกอะไร |
|---|---|
| ขอ access token | `GET https://labs.google/fx/api/auth/session` (cookie auto จากแท็บจริง) |
| สร้างโปรเจกต์ (ครั้งเดียวต่อแท็บ) | `POST https://labs.google/fx/api/trpc/project.createProject` |
| อัปโหลดรูปสินค้า | `POST {SANDBOX}/flow/uploadImage` (ไม่ต้องมี reCAPTCHA) |
| สร้างวิดีโอ (R2V) | `POST {SANDBOX}/video:batchAsyncGenerateVideoReferenceImages` |
| เช็คสถานะ | `POST {SANDBOX}/video:batchCheckAsyncVideoGenerationStatus` |
| ขอลิงก์วิดีโอ | `GET https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=…` |

(`{SANDBOX}` = `https://aisandbox-pa.googleapis.com/v1` — คือ "sandbox" ที่ ref1/ref2 เรียก)

### รอบสอง: ย้าย HTTP call ทั้งหมดไปที่ bridge (ตาม ref1 จริงๆ)

รอบแรก endpoint พวกนี้ถูกยิงจาก **ในเบราว์เซอร์** (MAIN-world content script ในแท็บ Flow)
โดยคิดว่า cross-origin ไปหา `aisandbox-pa.googleapis.com` จะผ่านเพราะหน้า Flow เองก็ต้องเรียก
endpoint เดียวกัน — **พังจริงตอนทดสอบ** ด้วย `TypeError: Failed to fetch` แบบไม่บอกรายละเอียด
สาเหตุคือ header `Authorization` ที่ต้องใส่ทำให้ request ไม่ใช่ CORS-simple อีกต่อไปไม่ว่า
Content-Type จะเป็นอะไร ต้องมี preflight เสมอ — และถ้า preflight โดนปฏิเสธ `fetch()` ในเบราว์เซอร์
จะไม่บอกเหตุผลอะไรให้ JS หน้าเว็บรู้เลย (เจตนาของ spec เอง)

ตรงนี้คือจุดที่ ref1 ทำถูกมาตั้งแต่แรก: **ไม่เคยยิง HTTP ไปหา Flow จากในเบราว์เซอร์เลย**
extension มีหน้าที่แค่ 2 อย่าง — **"เก็บค่า" (harvest) แล้วส่งกลับ**:

1. **คุกกี้ session** — `next-auth.session-token` เป็น HttpOnly คือแม้แต่ page JS ก็อ่านไม่ได้
   ต้องใช้ `chrome.cookies.getAll()` (สิทธิ์ extension เท่านั้น) — ทำใน `background.js` ตรงๆ
   ไม่ต้องผ่าน content script เลย
2. **reCAPTCHA token** — ต้องมี `grecaptcha.enterprise` ของหน้าจริงเท่านั้นถึง execute ได้

ที่เหลือทั้งหมด (session/project/upload/generate/poll/resolve) ย้ายไปที่
**`server/flow-client.mjs` รันด้วย Node fetch — ไม่มีแนวคิด CORS อยู่เลยในนั้น** endpoint/
header/body เดิมทุกจุด แค่เปลี่ยนที่รัน:

```
web (127.0.0.1)  ⇄  bridge (node, ไม่มี CORS)  ⇄  BlueSPite extension  ⇄  Shopee
                        │
                        ├─ flow-client.mjs → labs.google / aisandbox-pa.googleapis.com (Flow โดยตรง)
                        │
                        extension ให้แค่ cookie + reCAPTCHA token (2 อย่างที่ต้องใช้แท็บจริง)
```

**ทดสอบแล้ว:** `npm test` มี `test/flow-client.test.mjs` (Node import ตรงๆ ไม่ต้องจำลอง
browser อีกแล้ว) เช็คว่าทุก request ยิงถูก URL ถูก body ตรงตามที่ disassemble มา และรันจริงผ่าน
isolated bridge จนถึงจุดที่ต้องใช้ cookie จริง (ได้ HTTP 200 กลับจาก `labs.google` จริงๆ พิสูจน์
ว่าไม่ติด CORS/network แล้ว แค่ยังไม่มี session จริงในการทดสอบ) — ดูหัวข้อ "ข้อจำกัด" ด้านล่าง

### R2V vs I2V — ตอนนี้ตรงกับ ref2 ครบทั้งคู่แล้ว

| ขั้นตอน | R2V (Omni Flash / Veo R2V — ค่าเริ่มต้น) | I2V (Veo I2V) |
|---|---|---|
| reference | รูปสินค้า → `uploadReferenceImage()` → mediaId | เหมือนกัน (ใช้เป็น reference ของขั้นสร้างภาพ) |
| ขั้นภาพ | **ข้าม** — วิดีโอรับรูปสินค้าตรงๆ | `generateImage()` → `POST flowMedia:batchGenerateImages` (ยืนยันจาก `generate_image` ของ ref2) |
| ขั้นวิดีโอ | `submitR2V()` → `POST video:batchAsyncGenerateVideoReferenceImages` | `startVideoFromImage()` → `POST video:batchAsyncGenerateVideoStartImage` (ยืนยันจาก `start_video`) |
| reCAPTCHA | 1 ครั้ง (`VIDEO_GENERATION`) | 2 ครั้ง แยก action (`IMAGE_GENERATION` ตอนสร้างภาพ, `VIDEO_GENERATION` ตอนสร้างวิดีโอ — คนละ action จริงตาม ref2) |
| poll/resolve | ใช้ endpoint เดียวกันทั้งคู่ — `batchCheckAsyncVideoGenerationStatus` + `media.getMediaUrlRedirect` (ยืนยันจาก `poll_video` ของ ref1 ที่ใช้ฟังก์ชันเดียวกันทั้งสองพาธ) |

**จุดที่ยังไม่ verify กับของจริง:** `generateImage()` คาดว่า Flow คืน `fifeUrl` แบบ synchronous
ในเคสทั่วไป (ยืนยันจาก `_media_from` ของ ref2) — แต่ ref1 มีคอมเมนต์ไว้ว่า "Flow บางครั้ง
acknowledge แบบ async" (คืนแค่ `{media, workflows}` ไม่มี URL ทันที) ซึ่ง endpoint สำหรับ poll
สถานะภาพ (ต่างจาก poll วิดีโอ) **ไม่มีหลักฐานยืนยัน** เคสนี้จึงโยน error ชัดเจนแทนการเดา
ถ้าเจอ ("Flow ไม่คืน URL ภาพทันที...") ส่ง log มาดูได้ จะหา endpoint จริงต่อให้

---

## เมื่อแก้โค้ด extension ต้อง reload อะไรบ้าง

| แก้ที่ไหน | ต้องทำอะไร |
|---|---|
| `server/` `shared/` | Ctrl+C แล้ว `npm start` ใหม่ |
| `web/` | refresh หน้าเว็บ |
| `extension/src/background.js` `lib/` | reload extension ใน `chrome://extensions` |
| `extension/src/content/` | reload extension **และ reload แท็บ Shopee/Flow ด้วย** |

ข้อสุดท้ายสำคัญ: content script ที่ฉีดเข้าแท็บไปแล้วจะอยู่ต่อจนกว่าจะ reload *แท็บ*
guard ทุกตัวเลยเป็น **version-stamped** (`__BSP_SHOPEE_DRIVER >= 2`) ไม่ใช่ boolean —
ไม่งั้นตัวใหม่ที่ฉีดเข้าไปจะ `return` ทิ้งแล้วปล่อยให้ตัวเก่าตอบต่อ ซึ่งดีบักยากมาก

**เช็คว่า reload ติดหรือยัง:** ดู version ที่ popup / มุมซ้ายล่างของเว็บ (ตอนนี้ควรเป็น **v0.5.0**)

---

## ข้อจำกัดที่ต้องรู้ก่อนใช้จริง

1. **`flow-client.mjs` (bridge-side) ยิงใส่ session/project endpoint จริงแล้ว ผ่าน**
   ยืนยันด้วย isolated bridge: ได้ HTTP 200 จริงจาก `labs.google/fx/api/auth/session`
   (ไม่ติด CORS/network) — พิสูจน์ว่าสถาปัตยกรรมใหม่ (bridge ยิงเอง ไม่ใช่เบราว์เซอร์) ใช้ได้จริง
   ที่ยังไม่เคย verify คือ**ครบ chain จนได้วิดีโอ** เพราะตอนทดสอบ (รอบก่อนย้ายมา bridge-side)
   Flow เคยตอบ `MEDIA_GENERATION_STATUS_FAILED` ซึ่ง**เป็นการตัดสินใจของ Flow เอง ไม่ใช่บั๊ก
   ของ request** (request ถูกต้องพอที่ Flow จะรับไปประมวลผลแล้ว แค่ผลลัพธ์คือปฏิเสธ) —
   ต้องลองใหม่กับสถาปัตยกรรม bridge-side นี้ถึงจะรู้ว่าผ่านจนจบไหม

   ถ้า Flow ปฏิเสธด้วย `raiMediaFilteredReasons=<code>` — เป็น content-safety filter
   (Responsible AI) ของ Flow เอง ไม่ใช่ error จากระบบเรา (`flow-client.mjs`'s `failureReason()`
   ดึงเหตุผลนี้ออกมาตรงๆ แทนที่จะโชว์ raw JSON ตัดครึ่ง) ลองปรับ: เอา "ตัวละคร"/"โทนการพูด" ออก
   หรือเปลี่ยนสไตล์เป็น `silent-product` ก่อนลองสินค้าอื่น

   โค้ดออกแบบให้ **fail ดังๆ พร้อม error message จาก Flow จริง** ทุกจุด (ไม่ silently
   retry ด้วยอะไรที่เดาเอา)

2. **header ของ Shopee API** ใน `shopee-api.js` ตั้งไว้เท่าที่จำเป็น
   ถ้า Shopee ตอบ non-JSON (ขอ login/captcha) จะรายงานตรงๆ ว่าเป็นแบบนั้น

   **ต้องมีแท็บ `shopee.co.th` (www) เปิดอยู่** — แท็บ `affiliate.shopee.co.th`
   อย่างเดียวไม่พอ เพราะ `/api/v4/...` ต้องยิงจาก origin www ถ้ามีแต่แท็บ affiliate
   สถานะจะขึ้นว่า "มีแต่แท็บ affiliate" และ extension จะเปิดแท็บ www ให้เอง

   ถ้าแท็บ Shopee **เปิดค้างไว้ก่อนโหลด extension** content script จะยังไม่ถูกฉีดเข้าไป
   ตัว `askTab()` จะฉีดซ้ำให้ทั้ง ISOLATED และ MAIN world (ต้องฉีดทั้งคู่ — ถ้าฉีดแต่
   ISOLATED จะไปพังทีหลังเป็น "MAIN-world helper ไม่ตอบ" ซึ่งอ่านไม่ออกว่าสาเหตุจริงคืออะไร)

3. **endpoint ค่าคอมฯ** (`api/v3/offer/product/list`) ใช้ได้เฉพาะบัญชี Affiliate

4. **ไอคอน extension** เป็น placeholder ที่ generate ด้วย
   `node extension/icons/make-icons.mjs` — เปลี่ยนเป็นของจริงได้ตามสะดวก

---

## สิ่งที่ *ไม่* ได้ทำในรอบนี้

- โพสต์ขึ้น TikTok / ผูกสินค้า TikTok Shop (มีใน ref2 แต่ไม่ได้อยู่ในสิ่งที่สั่ง)
- provider อื่นนอกจาก Google Flow (Grok / KIE ใน ref2)
- multi-account + proxy pool ของ Flow (ref1/ref2 มี — ตอนนี้ใช้บัญชีที่ล็อกอินอยู่ในแท็บ)
