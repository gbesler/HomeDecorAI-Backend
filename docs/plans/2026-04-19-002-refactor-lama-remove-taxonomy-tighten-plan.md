---
title: "refactor: Remove Objects LaMa swap + Clean & Organize taxonomy tightening"
type: refactor
status: superseded
superseded_by: docs/plans/2026-04-19-003-refactor-sam3-lama-unified-pipeline-plan.md
date: 2026-04-19
origin: docs/brainstorms/2026-04-19-001-clutter-removal-best-practices-requirements.md
---

> ⚠️ **Superseded** by [2026-04-19-003-refactor-sam3-lama-unified-pipeline-plan.md](./2026-04-19-003-refactor-sam3-lama-unified-pipeline-plan.md).
> Bu ara plan SAM 2 + FLUX Fill'den kısmi geçiş öneriyordu; plan 003 tek seferde SAM 3 + LaMa unified pipeline'ına geçer.

# refactor: Remove Objects LaMa swap + Clean & Organize taxonomy tightening

## Overview

İki küçük ama kritik düzeltme. Brainstorm'da ortaya çıkan iki sorunu çözüyor:

1. **Remove Objects'i FLUX Fill'den LaMa'ya taşı.** FLUX Fill object-removal use case'inin yanlış modeli — "spurious elements" ekliyor, daha pahalı, daha yavaş. Cleanup.pictures / Magic Eraser / Apple Clean Up dahil endüstri standardı LaMa. Schema'sı farklı (prompt yok), dolayısıyla provider adapter küçük genişletme gerektiriyor.
2. **Clean & Organize taxonomy'sini agresif kısalt, `.` separator'a geçir, staging'de görsel doğrulama yap.** Mevcut 18-kelimelik virgül-ayrılı liste Grounded-SAM best practice'lerini iki noktadan ihlal ediyor (separator + uzunluk). Kısa, yüksek-kesinlik listeye geçilecek.

Scope küçük: yeni feature yok, yeni UX yok, iOS değişikliği yok. Sadece model swap + taxonomy düzenleme + staging validasyon çerçevesi.

## Problem Frame

Mevcut kod (`2026-04-19-001-feat-segmentation-inpainting-pipeline-plan.md` ile ship edildi) iki aracı canlıya hazır hale getirdi ama brainstorm (origin doc) endüstri pratiğine göre iki somut boşluk bıraktı:

- **G1 (Remove Objects model):** Endüstri LaMa kullanırken biz FLUX Fill kullanıyoruz. FLUX Fill bu use case'te obje hayaleti ve hallucination eğiliminde (Aligned Stable Inpainting paper, 2026). Kullanıcı "bunu sil" derken "yerine clean surface olsun" bekliyor — LaMa tam bu işi yapıyor, FLUX Fill "belirli bir şeyle değiştir" için optimize.
- **G2 + G3 + G4 (taxonomy):** 18 kelime virgülle ayrılmış statik liste; GroundingDINO dokümantasyonu `.` separator + kısa prompt öneriyor; liste staging'de test edilmedi.

## Requirements Trace

- **R1.** Remove Objects pipeline'ı FLUX Fill yerine LaMa çağırır (origin H1).
- **R2.** `cleanOrganize` taxonomy'si ≤7 kelime, `.` separator, mobilya/decor ile çakışmayan yüksek-kesinlikli terimlerden oluşur (origin H2).
- **R3.** Taxonomy staging'de en az 20 gerçek foto üzerinde görsel QA edilir; mobilya yanlış-maskeleme oranı < %5, clutter yakalama > %70 hedefi (origin Success Criteria).
- **R4.** LaMa model slug'ı env-overridable kalır (`REPLICATE_REMOVAL_MODEL`); capability matrix'te `role: "remove"` ile kayıtlı; mevcut `role` startup-throw doğrulamasına dahil.
- **R5.** Remove Objects backend contract bozulmaz: iOS aynı `{imageUrl, maskUrl, prompt?}` payload'ını gönderir; sadece upstream model değişir. `prompt` alanı LaMa path'inde yoksayılır (schema kabul etmiyor).
- **R6.** Clean & Organize pipeline'ı **değişmez** — FLUX Fill'de kalır (generative "clean surface" fill kabul edilir). Yalnızca SAM text prompt'u iyileşir.
- **R7.** Legacy 18-kelimelik taxonomy git history'de kalır; rollback 1-commit revert ile mümkün.

## Scope Boundaries

- **NOT:** NL yönerge alanı (Clean & Organize'a "remove cups and bottles" gibi). Seviye 2 kapsamında.
- **NOT:** ADE20K panoptic segmenter ekleme. Seviye 2.
- **NOT:** Depth/structural priors, edge refinement. Seviye 3.
- **NOT:** iOS değişikliği. Remove Objects wizard, brush canvas, upload path aynen kalır.
- **NOT:** FLUX Fill'i `cleanOrganize`'dan kaldırma. Origin doc H2'de eksplisit "Flux Fill segment bölgesi üzerinde kalır" diyor.
- **NOT:** Virtual Staging / empty-the-room akışlarına dokunma.

## Context & Research

### Relevant Code and Patterns

- `src/lib/ai-providers/capabilities.ts` — `PROVIDER_CAPABILITIES` matrix; yeni LaMa entry buraya. `ModelRole` union'ına `"remove"` eklenecek.
- `src/lib/ai-providers/replicate.ts` — `callInpaintingReplicate` FLUX Fill için. Yeni `callRemovalReplicate` LaMa için (prompt yok, `mask` zorunlu). Shape extraction helper'ları reused.
- `src/lib/ai-providers/router.ts` — `callInpainting` var. Yeni `callRemoval` router helper'ı aynı breaker semantiği ile.
- `src/lib/ai-providers/index.ts` — export yüzey alanı.
- `src/lib/ai-providers/types.ts` — `InpaintingInput/Output` patterni. Yeni `RemovalInput/Output` (prompt opsiyonel ama çoğunlukla unused).
- `src/lib/env.ts` — `REPLICATE_INPAINT_MODEL` var. Yeni `REPLICATE_REMOVAL_MODEL` default slug ile (staging'de doğrulanacak). Startup role check checks'ine `"remove"` satırı.
- `src/lib/generation/segment-inpaint.ts` — `runInpaint` helper'ı. Yeni `runRemoval` helper'ı (aynı şekil, farklı router fn).
- `src/services/generation-processor.ts` — `mode === "inpaint-only"` branch'i `runInpaint` yerine `runRemoval` çağıracak. `mode` adı yanlış yönlendirici olmaya başladı — yeni bir mode `"remove-only"` ekleme fırsatı (inpaint-only mevcut değilse deprecated).
- `src/lib/tool-types.ts` — `removeObjects` entry'si `mode: "inpaint-only"` → `mode: "remove-only"`.
- `src/lib/prompts/dictionaries/clutter-taxonomy.ts` — tüm liste ve builder burada. Tek-dosya değişikliği.
- `src/lib/prompts/tools/clean-organize.ts` — builder consumer.
- `docs/runbooks/segment-inpaint-pipeline.md` — validation adımları ve model slug notları burada.

### Institutional Learnings

- `clean-organize.ts` header'ı: "Flux models do not honor negation" — LaMa için de irrelevant (prompt kabul etmiyor); mevcut positive-avoidance mantığı taxonomy ile karışmamalı.
- Tool-types registry'deki `mode` alanı processor dispatch'i için tek kaynak; yeni mode eklemek 2 dosya değişikliği (tool-types + processor switch).
- Daha önce yapılan code review'da (ce:review) `extractMaskUrl` positional heuristic'i warn-log ile işaretlendi. LaMa için `extractImageUrl` zaten FLUX Fill ile aynı shape döndüğü için reuse edilebilir (tek string veya string array'in ilk elemanı).

### External References

- [advimman/lama (WACV 2022)](https://github.com/advimman/lama) — LaMa referans impl.
- [lama-cleaner OSS](https://github.com/a-milenkin/lama-cleaner) — Cleanup.pictures'ın altındaki wrap; input schema örneği.
- Replicate LaMa fork'ları (staging'de benchmark'lanacak): `cjwbw/lama`, `allenhooo/lama`, `pg56714/Inpaint-Anything`. Tipik input: `{image, mask}`; output: mask uygulanmış image URL.
- [GroundingDINO README](https://github.com/IDEA-Research/GroundingDINO) — `.` separator convention.

## Key Technical Decisions

- **Yeni `mode: "remove-only"` eklenir**, mevcut `"inpaint-only"` retire edilmez (registry'de kimse kullanmıyorsa dead weight ama type-union'da bırakılabilir). `removeObjects` tool entry'si `remove-only`'e geçer. **Neden:** isim fonksiyonel — "remove" kullanıcının niyeti, "inpaint" implementation detayı. Yeni mode ekleyip eskiyi bırakmak legacy geçiş pattern'i ile uyumlu.
- **LaMa'ya özel yeni router fn `callRemoval`.** Mevcut `callInpainting`'i recycle etmiyoruz çünkü: (a) LaMa prompt kabul etmiyor, (b) LaMa failure mode'u farklı (timeout profili, hallucination yok), (c) ileride ayrı circuit breaker gerekebilir.
- **Capability'de yeni role `"remove"`.** `"inpaint"` ile aynı değil — startup validation farklı env değişkenini kontrol ediyor; shape extraction aynı ama semantics farklı.
- **Clutter taxonomy: ≤7 kelime, `.` separator.** Kısaltma agresif: spesifik-nesne, mobilya/decor ambiguity'si olmayan kelimeler. İlk kısa liste (staging'de tune edilecek):
  - `full`: `dirty dishes . empty bottles . food wrappers . crumpled paper . plastic bag . laundry pile`
  - `light`: `dirty dishes . empty bottles . food wrappers`
- **Taxonomy format fonksiyon düzeyinde soyutlanır.** `buildClutterTextPrompt` hâlâ tek yerden üretir. Separator değişimi burada, caller'lar etkilenmez.
- **Rollback = env swap.** `REPLICATE_REMOVAL_MODEL` env değişirse yeni slug çalışır. Acil rollback için eski `REPLICATE_INPAINT_MODEL` değeri FLUX Fill'i geri getirmez (yeni mode üzerinden kodla bağlı); rollback = commit revert. Kabul ediyoruz — Remove Objects staging'de 1 hafta izlenecek.

## Open Questions

### Resolved During Planning

- **S: Hangi LaMa fork'u default olsun?**
  Ç: Staging'e 3 adayı birden deploy edip 20 test fotoda karşılaştıracağız. Plan default'u olarak `cjwbw/lama` (en eski, en çok star). Seçim, Unit 4'teki validasyon sonrası `REPLICATE_REMOVAL_MODEL` default'ı bu plan'ın son commit'inde güncellenecek.

- **S: LaMa `image` input'a HEAD request yapıp content-type doğrulamak gerekli mi?**
  Ç: Hayır — `imageUrl` zaten iOS upload flow'undan geliyor ve controller `validateClientUploadHost` ile doğrulanmış. Ek HEAD check latency eklerdi, getirisi yok.

- **S: `mode: "inpaint-only"` silinsin mi?**
  Ç: Hayır. Dead kod taşıma planı değil; type union'da kalır, `removeObjects` `remove-only`'e geçer. İleride başka bir tool `inpaint-only` isterse destek hâlâ var.

### Deferred to Implementation

- LaMa input schema'sının gerçek alanları (`image` mi `image_url` mi, `mask` mi `mask_url` mi) — tercih edilen fork belirlendikten sonra `callRemovalReplicate`'te netleşir.
- LaMa output shape'i (tek string URL veya dict) — `extractImageUrl` helper'ı mevcut; probe doğruluğu staging'de sabitlenir.
- Taxonomy final kelime listesi — Unit 4 validasyonu sonrası güncellenir.

## Implementation Units

- [ ] **Unit 1: Capabilities + env'e LaMa kaydı**

**Goal:** LaMa modelini capability matrix'ine ve env'e ekle; startup role verification'a `"remove"` role'ünü tanıt.

**Requirements:** R4

**Dependencies:** yok

**Files:**
- Modify: `src/lib/ai-providers/capabilities.ts` — `ModelRole` union'a `"remove"` ekle; `cjwbw/lama` entry (provider: replicate, role: remove, supportsNegativePrompt: false, supportsGuidanceScale: false, supportsReferenceImage: false, maxPromptTokens: 0 — model prompt almıyor).
- Modify: `src/lib/env.ts` — `REPLICATE_REMOVAL_MODEL` default `"cjwbw/lama"`, `owner/name` regex'i aynı. Startup role verification bloğuna `"remove"` satırı ekle.
- Modify: `src/lib/ai-providers/types.ts` — yeni `RemovalInput` ve `RemovalOutput` tipleri (`imageUrl`, `maskUrl` → `imageUrl + provider + durationMs`).

**Approach:**
- `maxPromptTokens: 0` capability üzerinden "bu model prompt kabul etmiyor" deklare edilir; `supportsNegativePrompt/GuidanceScale: false`.
- Startup validation: `REPLICATE_REMOVAL_MODEL` slug'ının capability entry'si yoksa warn; varsa `role === "remove"` kontrolü; değilse `process.exit(1)`.
- `RemovalInput/Output` şekli `InpaintingInput/Output` ile paralel; `prompt?: string` opsiyonel (gelse bile adapter yok sayacak, interface netliği için tutulmuyor — hiç eklememe tercihli).

**Test scenarios:**
- Happy path: `cjwbw/lama` slug'ı capability'den role="remove" dönüyor → startup geçer.
- Error path: slug capability'de yok → warn log, boot devam ediyor.
- Error path: slug yanlış role'de (ör. `black-forest-labs/flux-fill-pro`'yu `REPLICATE_REMOVAL_MODEL`'e vermek) → process.exit(1).

**Verification:** `pnpm test src/lib/ai-providers` ve `pnpm test src/lib/env` yeşil. Dev boot'unda yanlış env ile hızlı fail.

---

- [ ] **Unit 2: `callRemovalReplicate` + router `callRemoval`**

**Goal:** LaMa'ya özel provider adapter + router helper. Prompt yok, mask zorunlu, shape extraction reused.

**Requirements:** R1, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/ai-providers/replicate.ts` — `callRemovalReplicate(model, input: RemovalInput)`; input shape'i LaMa fork'unun schema'sına göre (`image`, `mask` veya `image_url`, `mask_url`). `extractImageUrl` helper reused. Role mismatch log'u mevcut pattern.
- Modify: `src/lib/ai-providers/router.ts` — `callRemoval(input)` fn; `env.REPLICATE_REMOVAL_MODEL` okur, `withRetry maxRetries: 1`, `designCircuitBreaker.record(true|false)` mevcut pattern. Fallback yok (LaMa için alternatif provider wire'lı değil — aynı cleanOrganize/segment path'indeki gibi).
- Modify: `src/lib/ai-providers/index.ts` — `callRemoval`, `RemovalInput`, `RemovalOutput` export.

**Approach:**
- Input schema: LaMa fork'u belirlendikten sonra exact alan isimleri sabitlenecek (deferred). İlk iterasyon `{image: imageUrl, mask: maskUrl}` assume edilerek yazılır, staging'de 400'de schema düzeltilir.
- Timeout: mevcut `TIMEOUT_MS = 60_000` kullanılır. LaMa tipik latency 1-3s; 60s headroom çok.
- Output: tek string URL beklenir (LaMa tipik return); `extractImageUrl` array fallback'i da kapsar.

**Test scenarios:**
- Happy path: mocked Replicate response `"https://replicate.delivery/...png"` → `RemovalOutput.imageUrl` eşleşir.
- Happy path: array response `["https://..."]` → first element kullanılır.
- Error path: Replicate 5xx → breaker `record(false)`, withRetry 1 kez retry, sonra rethrow.
- Edge case: boş/null output → `Replicate removal returned no image` throw.

**Verification:** `pnpm test src/lib/ai-providers/replicate` yeşil. `pnpm test src/lib/ai-providers/router` yeni `callRemoval` fn'i kapsayan test ile yeşil.

---

- [ ] **Unit 3: `remove-only` mode + `runRemoval` helper + processor dispatch**

**Goal:** `removeObjects` tool'u yeni mode'a geçir; processor branch'ini yeni helper üzerinden çalıştır.

**Requirements:** R1, R5

**Dependencies:** Unit 2

**Files:**
- Modify: `src/lib/tool-types.ts` — `ToolTypeConfig.mode` union'ına `"remove-only"` ekle. `removeObjects` entry'si `mode: "inpaint-only"` → `mode: "remove-only"`. `models.replicate`/`falai` placeholder'ları yorumla birlikte kalır (edit rollback affordance), ama artık consume edilmiyor.
- Modify: `src/lib/generation/segment-inpaint.ts` — yeni `runRemoval(input: {imageUrl, maskUrl})` helper'ı; `callRemoval` çağırır; `RunInpaintOutput` şekli döndürür (provider + durationMs + outputImageUrl).
- Modify: `src/services/generation-processor.ts` — `mode === "remove-only"` yeni branch. `params.maskUrl` okur (validation değişmez, `clientUploadFields` guard ediyor), `runRemoval` çağırır. `promptResult.prompt` yoksayılır. `"inpaint-only"` branch'i dokunulmaz (dead ama cover edilebilir; gelecekte başka tool için).

**Approach:**
- Processor branch'i mevcut `inpaint-only`'nin kısaltılmış kopyası: prompt/guidanceScale forwarding yok, sadece maskUrl + imageUrl.
- `recordAiResult` mevcut sıra (`tempOutputUrl`, `provider`, `prompt`, `actionMode`, `guidanceBand`, `promptVersion`, `durationMs`) aynen yazılır; `prompt` alanı builder'dan gelen default metin ("clean surface continuation...") olarak persist edilir. LaMa onu kullanmıyor ama metric/audit için firestore'da kalır.
- `runRemoval` signature'ı `runInpaint` ile paralel: `{outputImageUrl, provider, durationMs}`. Processor kodu iki branch'te neredeyse simetrik kalır.

**Test scenarios:**
- Happy path: `removeObjects` submit → `remove-only` branch tetiklenir → mocked `runRemoval` `outputImageUrl` döndürür → `recordAiResult` yazılır → storage stage'e ilerler.
- Integration: `generation-processor` idempotency testi — aynı generationId retry → AI stage tek çalışır (`aiCompletedAt` guard).
- Edge case: `params.maskUrl` string değil → VALIDATION_FAILED (mevcut guard).
- Error path: `callRemoval` throws → AI_PROVIDER_FAILED (mevcut catch branch).

**Verification:** Staging'de bir test fotoğrafı + brush mask ile uçtan uca çalışır; output görsel olarak "silinmiş objenin hayaleti yok".

---

- [ ] **Unit 4: Clutter taxonomy tighten + `.` separator + runbook validation section**

**Goal:** Taxonomy'yi kısalt, separator düzelt, staging validation prosedürünü runbook'a ekle.

**Requirements:** R2, R3, R6

**Dependencies:** yok (Unit 1-3 ile paralel uygulanabilir)

**Files:**
- Modify: `src/lib/prompts/dictionaries/clutter-taxonomy.ts` — `CLUTTER_TAXONOMY` listelerini kısalt (ilk aday: full 6 kelime, light 3 kelime — yukarıdaki Key Technical Decisions'ta listelendi). `buildClutterTextPrompt` `.join(" . ")` ile nokta separator. Trailing space/period yönetimi: `"foo . bar . baz"` (her iki tarafta boşluk, sonda nokta yok — GroundingDINO README örneklerine uygun).
- Modify: `docs/runbooks/segment-inpaint-pipeline.md` — yeni "Taxonomy validation" bölümü. 20-30 staging foto koleksiyonu, her seviye için gözle QA checklist (mobilya false-positive, clutter recall, boş mask oranı). Aday kelimeler için A/B koşma adımları.

**Approach:**
- Kelime seçimi rasyoneli taxonomy dosyasında yorum satırları olarak kalır — hangi terim neden dahil/hariç.
- Runbook'a eklenecek checklist deliverable:
  ```
  Staging validation (per level):
  1. Collect 20-30 "dağınık oda" photos (living, bedroom, kitchen mix)
  2. For each photo, run the tool via staging endpoint
  3. Record: did the mask include furniture? Did it miss visible clutter? Was the mask empty?
  4. Target: furniture false-positive < 5%, clutter recall > 70%, empty-mask < 10%
  5. If failing, adjust clutter-taxonomy.ts and re-run subset
  ```
- Separator değişimi Grounded-SAM 2 modelinin tokenizer davranışı için; test edilirken sadece output mask kalitesi değerlendirilir, log'da `textPrompt` zaten emit ediliyor.

**Test scenarios:**
- Happy path (unit): `buildClutterTextPrompt("full")` → 6 kelime, `" . "` ile birleşmiş, baş/son boşluk yok.
- Happy path (unit): `buildClutterTextPrompt("light")` → 3 kelime aynı format.
- Edge case: gelecekte liste boşaltılırsa → boş string döndürür (caller tarafı handle etmeli; bu işin scope'u değil ama yorum notu eklenir).
- Manual / staging: Yukarıdaki runbook checklist uygulanır; çıktılar Slack'e yazılır.

**Verification:** Unit test taxonomy output'unu assert eder. Staging validation runbook'u tamamlanmış, sonuçlar runbook'un ilgili bölümünde tarihlenmiş commit ile kayıt altında (ör. `Taxonomy validated 2026-04-2X by Y on 24 photos — ratio: full 73% recall / 3% FP; light 51% recall / 1% FP`).

## System-Wide Impact

- **Interaction graph:** Yeni halka `generation-processor` → `runRemoval` → `callRemoval` → `callRemovalReplicate`. Mevcut `callInpainting` path'i `cleanOrganize` için değişmez.
- **Error propagation:** LaMa'dan gelen hatalar mevcut provider error taxonomisini kullanır (`AI_PROVIDER_FAILED` / `AI_TIMEOUT`). Yeni error class gerekmiyor.
- **State lifecycle:** `removeObjects` için `segmentationMaskUrl` Firestore alanı yazılmaz (segment-inpaint değil). Mevcut davranış değişmez.
- **API surface parity:** iOS contract aynı: `{imageUrl, maskUrl, prompt?}`. `prompt` alanı LaMa tarafında consume edilmiyor ama API şeması backward-compat tutuluyor.
- **Integration coverage:** `generation-processor` retry testi `remove-only` mode için de çalışmalı. Mevcut `inpaint-only` test fixture'ı adapte edilir.
- **Unchanged invariants:** `cleanOrganize` pipeline'ı (SAM + FLUX Fill), Virtual Staging, Reference Style, paint-walls, floor-restyle — hepsi değişmez. Rate limits, auth, Cognito upload flow, FCM, Cloud Tasks → aynı.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Seçilen LaMa fork'unun input schema'sı tahminden farklı | İlk staging request'i 400 ile başarısız olursa schema düzeltmesi 5-dakikalık iş. Unit 2 "deferred to implementation" olarak işaretlendi. |
| LaMa output görsel kalite istenen seviyede değil | Üç fork'u staging benchmark'la; `REPLICATE_REMOVAL_MODEL` env'i ile swap. Kabul edilemezse FLUX Fill'e revert tek-commit. |
| Staging validation adımı runbook'tan atlanır ve kısa taxonomy prod'da beklenenden kötü çalışır | Runbook'un "Taxonomy validated on DATE" satırı doldurulmadan prod deploy onaylanmaz (süreç sözleşmesi). |
| Mevcut `inpaint-only` kodu dead weight olur | Dead kod taşıma riski low; gelecekte başka tool için hazır. Silmek istersek ayrı cleanup PR. |
| iOS `prompt` alanını hâlâ gönderiyor | Backend yoksayar (schema kabul ediyor, LaMa path'te unused). Zero-cost backward-compat. |

## Documentation / Operational Notes

- `docs/runbooks/segment-inpaint-pipeline.md` içinde iki mevcut bölüm güncelleniyor: (a) model listesine LaMa eklenecek, (b) yeni "Taxonomy validation" prosedürü yazılacak.
- Slack'te `inpaint.completed` event'ine ek olarak `removal.completed` (yeni) log emit edilir — iki araç ayrı metric watch'lanabilsin.
- Deploy sırası: (1) Unit 1 + 2 (capability + provider adapter) deploy → sadece kod eklenir, kullanılmaz. (2) Unit 3 (mode switch) deploy → removeObjects LaMa'ya geçer, gözlem. (3) Unit 4 taxonomy + runbook → staging validation → prod deploy.

## Verification (uçtan uca)

1. **Remove Objects staging:** Fotoda bir yastık fırça ile boyanır → backend LaMa'yı çağırır → yastık silinmiş, koltuk pixel-perfect kalmış, "obje hayaleti" yok. Latency < 10s.
2. **Remove Objects idempotency:** Aynı job 2 kez submit edilirse (Cloud Tasks retry) LaMa 1 kez çağrılmış olur (mevcut `aiCompletedAt` guard).
3. **Remove Objects rollback:** `REPLICATE_REMOVAL_MODEL` env'i yanlış bir slug'a set edilirse boot fail — `REPLICATE_REMOVAL_MODEL role mismatch` mesajı.
4. **Clean & Organize (değişmez ama regresyonsuz):** Dağınık oda fotoğrafı → full mode → yeni kısa taxonomy ile çalışır → mobilya maskelenmemiş, clutter maskelenmiş, FLUX Fill boş yüzey üretmiş.
5. **Clean & Organize taxonomy logs:** Slack `segment.mask_detected` event payload'unda `textPrompt` alanı `.` ile ayrılmış görünür.
6. **Staging validation artifact:** 20+ foto üzerinde görsel QA sonuçları runbook'a commit edilmiş.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-19-001-clutter-removal-best-practices-requirements.md](../brainstorms/2026-04-19-001-clutter-removal-best-practices-requirements.md)
- Related plan: [docs/plans/2026-04-19-001-feat-segmentation-inpainting-pipeline-plan.md](./2026-04-19-001-feat-segmentation-inpainting-pipeline-plan.md)
- Runbook: `docs/runbooks/segment-inpaint-pipeline.md`
- Kod noktaları: `src/lib/ai-providers/{capabilities,replicate,router,index,types}.ts`, `src/lib/env.ts`, `src/lib/generation/segment-inpaint.ts`, `src/services/generation-processor.ts`, `src/lib/tool-types.ts`, `src/lib/prompts/dictionaries/clutter-taxonomy.ts`
- External: [advimman/lama](https://github.com/advimman/lama), [lama-cleaner](https://github.com/a-milenkin/lama-cleaner), [GroundingDINO README](https://github.com/IDEA-Research/GroundingDINO)
