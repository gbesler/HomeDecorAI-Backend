---
title: "feat: Segmentasyon + Inpainting Pipeline (Clean & Organize mask-based + Remove Objects)"
type: feat
status: superseded
superseded_by: docs/plans/2026-04-19-003-refactor-sam3-lama-unified-pipeline-plan.md
date: 2026-04-19
target_repo: HomeDecorApp monorepo (HomeDecorAI-Backend + HomeDecorAI iOS)
---

> ⚠️ **Superseded** by [2026-04-19-003-refactor-sam3-lama-unified-pipeline-plan.md](./2026-04-19-003-refactor-sam3-lama-unified-pipeline-plan.md).
> Implementation'ı (Unit 1-7) uygulandı + ce:review fix'leri merge edildi, ancak sonrasında SAM 3 + LaMa unified pipeline'ına refactor kararı alındı.

# feat: Segmentasyon + Inpainting Pipeline

## Context (Neden)

Bugünkü **Clean & Organize** aracı `prunaai/p-image-edit` modelini saf prompt ile çağırıyor: "remove all visible clutter". Model, hangi pikselin clutter olduğunu bilmeden tüm kareyi yeniden üretiyor; bu yüzden mobilyayı, duvar rengini, perdeyi "temizlerken" istemeden değiştiriyor. Structural-preservation layer'ı bunu tam önleyemiyor çünkü müdahale bölgesi maskelenmemiş.

Bu plan iki aracı mask-based inpainting pipeline'ına taşır:

1. **Clean & Organize** — SAM2 (Grounded-SAM) ile clutter otomatik maskelenir, yalnızca o bölge FLUX Fill ile doldurulur. Mobilya ve geometri pikselde korunur.
2. **Remove Objects** — yeni araç. Kullanıcı iOS'ta silmek istediği bölgeyi fırça ile boyar, mask PNG S3'e yüklenir, backend aynı FLUX Fill ile doldurur. SAM kullanılmaz (brush seçildi).

Ortak kazanç: `segment.service.ts` + `inpaint.service.ts` — her iki aracın da tükettiği yeniden kullanılabilir bir segmentasyon+inpainting alt katmanı.

## Problem Frame

- **Bugün ne kırık:** Clean & Organize prompt-only olduğu için "temiz oda" isteği ile birlikte tarz, aydınlatma, mobilya detayları da modelin yaratıcılığına teslim ediliyor. Kullanıcı "sadece dağınıklığı al" diyor, AI oturma odasını yeniden tasarlıyor.
- **Boşluk:** Spesifik obje (koltuk, lamba, poster vb.) silme yok. Kullanıcı halihazırda var olan ama istemediği tek bir nesneyi kaldıramıyor.
- **Hedef çıktı:** Sadece maskelenmiş bölgesi değişen, geri kalanı pixel-perfect korunan bir render.

## Requirements Trace

- **R1.** Clean & Organize pipeline'ı: photo → Grounded-SAM2 ile clutter-mask → FLUX Fill ile inpaint → sonuç. Mevcut prompt-only yol kaldırılır.
- **R2.** Remove Objects pipeline'ı: photo + brush-mask URL → FLUX Fill ile inpaint → sonuç. SAM çağrılmaz.
- **R3.** Her iki araç da `TOOL_TYPES` registry'sine entry ile katılır; generic controller factory kullanılır (yeni route/controller yazılmaz).
- **R4.** Mask üretimi (SAM) ve inpaint çağrıları tek sağlayıcıdan (Replicate) yapılır — tek circuit breaker, tek rate-limit.
- **R5.** `declutterLevel` (full | light) Grounded-SAM text-prompt agresifliğini ayarlar: full = geniş clutter listesi, light = sadece yüzey clutter.
- **R6.** iOS'ta yeni Remove Objects wizard (sıfırdan): photo upload → brush canvas → preview/confirm → submit. Mevcut `HomeTool` kartına eklenir.
- **R7.** Mask PNG iOS'tan S3'e aynı Cognito kimlikli direct-upload path'i ile yüklenir; backend sadece `maskUrl` alır.
- **R8.** generation-processor idempotency korunur: `aiCompletedAt` checkpoint'i tüm pipeline'ı (segment + inpaint) kapsar; retry üzerine iki kere inpaint çalışmaz.
- **R9.** Token budget / prompt layer mimarisi korunur — `clean-organize.ts` prompt builder'ı inpaint'e özel sadeleştirilir (Flux Fill farklı prompting rejimine sahip).

## Scope Boundaries

- Wall/floor/window yeniden kaplama **bu planda değildir** — zaten `paint-walls` ve `floor-restyle` araçları ile çözülüyor.
- fal.ai'ye geçiş yok; **sadece Replicate**.
- Remove Objects için SAM tap/lang varyantları bu sürümde yok — brush-only.
- On-device segmentation (CoreML SAM) yok; tüm iş sunucu tarafı.
- Geri uyumluluk (eski prompt-only clean-organize) korunmaz; tam değiştirme.

## Context & Research

### İlgili kod ve pattern'ler (repo-relative)

- `HomeDecorAI-Backend/src/lib/tool-types.ts` — araç registry'si; her yeni araç tek entry.
- `HomeDecorAI-Backend/src/lib/prompts/tools/clean-organize.ts` — değiştirilecek prompt builder.
- `HomeDecorAI-Backend/src/lib/ai-providers/replicate.ts` — model çağrı wrapper'ı; input.imageUrl tek/çok-image desteği mevcut.
- `HomeDecorAI-Backend/src/lib/ai-providers/capabilities.ts` — yeni modelleri (SAM2, FLUX Fill) kaydetme yeri.
- `HomeDecorAI-Backend/src/services/generation-processor.ts` — idempotent pipeline; segment+inpaint tek "AI stage" içinde kalmalı.
- `HomeDecorAI-Backend/src/lib/circuit-breaker.ts` — iki ardışık Replicate çağrısı aynı breaker grubundan geçer.
- `HomeDecorAI-Backend/src/lib/storage/cognito-credentials.ts` — iOS mask upload'u için aynı credential akışı.
- `HomeDecorAI/HomeDecorAI/Features/Wizard/ViewModels/CleanOrganizeWizardViewModel.swift` — örnek VM; yeni Remove Objects VM bu patterne uyar.
- `HomeDecorAI/HomeDecorAI/Features/Wizard/Views/CleanOrganizeWizardView.swift` — wizard step container örneği.
- `HomeDecorAI/HomeDecorAI/Features/Home/Models/HomeTool.swift` — yeni Remove Objects kartı.
- `HomeDecorAI/HomeDecorAI/Core/Network/DesignAPIService.swift` — yeni `removeObjects` çağrısı.

### External referanslar

- **Replicate / meta/sam-2** — box + point + text (Grounding-DINO-destekli) prompt modları. Bizim için: Grounded-SAM2 variant (örn. `lucataco/grounded-sam-2`) text-prompt ile doğrudan clutter listesi veriyor, binary mask PNG üretir.
- **Replicate / black-forest-labs/flux-fill-pro** — mask-guided inpainting, `image` + `mask` + `prompt` alır. Mask beyaz=doldur, siyah=koru.
- Flux prompting rehberi: pozitif tanım, negasyon yok → mevcut `positive-avoidance` primitive yeniden kullanılır.

### Institutional learnings

- `clean-organize.ts` comment'i: "Flux models do not honor negation" — FLUX Fill için de geçerli.
- Tool registry'den geçen her araç otomatik olarak rate-limit + Firestore round-trip'ini miras alır.
- `generation-processor` retry'da AI stage'i en fazla bir kez çalıştırır; iki adımı (segment+inpaint) tek transaction altında tutmak şart.

## Key Technical Decisions

- **Tek "AI stage" iki model çağrısı içerir.** `callDesignGeneration` içinde segment→inpaint zinciri olur; ara mask URL Firestore'a yazılır (`segmentationMaskUrl`), idempotency checkpoint tek kalır. İki ayrı stage yapmak retry semantiğini kırar.
- **Mask kalıcılığı:** SAM çıktısı Replicate geçici URL'si; inpaint çağrısından önce S3'e persist edilir (`persistGenerationImage` yeniden kullanılır, key prefix `masks/`). Retry'da mevcut mask URL tekrar kullanılır.
- **Grounded-SAM text-prompt sözlüğü:** `clutter-dictionary.ts` — full/light seviyesi için iki ayrı clutter taxonomisi. Örn full: "clothes, cups, bottles, papers, cables, toys, random items, bags, cleaning supplies". light: "loose papers, cups, bottles, random small items".
- **Remove Objects mask ingestion:** iOS PNG mask S3'e yüklendikten sonra backend sadece `maskUrl` alır; validation: mask erişilebilir, PNG, image ile aynı boyut, >%0.5 beyaz piksel. %30'dan fazla maske = uyarı/hata (kullanıcı büyük alanı inpaint'le değil başka araçla yapsın).
- **FLUX Fill prompt'u inpaint-context'li:** "clean surface continuation of the surrounding material, matching lighting and perspective" — mevcut `structural-preservation` primitive Flux Fill için de kullanılır çünkü inpaint sınırında tutarlılık gerekir.
- **guidanceBand = faithful** her iki araç için; yaratıcılık düşük, rekonstrüksiyon yüksek.
- **Araç isimleri:**
  - `cleanOrganize` (mevcut; prompt builder değişir, tool entry body schema aynı kalır)
  - `removeObjects` (yeni tool type; body: `imageUrl`, `maskUrl`, `prompt?`)

## Open Questions

### Planlama sırasında çözüldü

- **S: Segment + inpaint tek stage mi iki stage mi?**  
  Ç: Tek stage. İki stage retry karmaşası yaratır ve kullanıcıya ek bildirim lifecycle'ı gerektirir.

- **S: Remove Objects'te SAM?**  
  Ç: Hayır. Kullanıcı brush seçti → mask doğrudan iOS'tan gelir.

- **S: Grounded-SAM yerine saf SAM2 otomatik mode?**  
  Ç: Hayır. SAM2 auto-mode tüm objeleri maskeler, clutter'ı ayırt edemez. Grounded-SAM text-prompt gerekli.

### Uygulamaya ertelendi

- **Flux Fill vs. prunaai inpaint model seçimi kalite ölçümü:** ilk sürüm flux-fill-pro; eğer latency > 15s olursa `flux-fill-dev` veya alternatif değerlendirilir.
- **Mask dilate/erode parametreleri:** Grounded-SAM mask kenarları zaman zaman objenin içini keser; ilk testlerde dilate px belirlenecek.
- **iOS brush fırça yarıçapı / undo derinliği:** tasarım review'ında finalize.

## High-Level Technical Design

> *Bu diyagram yaklaşımın şeklini gösterir, implementation spec değildir.*

```
Clean & Organize akışı:
┌──────────┐      ┌──────────────┐      ┌─────────────────┐      ┌────────────┐
│ iOS      │      │ Backend      │      │ Replicate       │      │ Replicate  │
│ Wizard   │─────▶│ /design/     │─────▶│ Grounded-SAM2   │─────▶│ FLUX Fill  │
│ photo+   │      │  clean-      │      │ (text: clutter  │      │ (image +   │
│ level    │      │  organize    │      │  taxonomy)      │      │  mask)     │
└──────────┘      └──────────────┘      └────────┬────────┘      └─────┬──────┘
                          │                      │ mask PNG             │ final
                          │                      ▼                      │ image
                          │                  persist mask               │
                          │                  to S3                      │
                          │◀─────────────────────┴──────────────────────┘
                          ▼
                   Firestore doc
                   (completed)

Remove Objects akışı (SAM yok):
┌──────────┐  upload   ┌──────────┐      ┌──────────────┐      ┌────────────┐
│ iOS      │──────────▶│ S3       │      │ Backend      │      │ Replicate  │
│ Brush    │   photo   │ (photo + │      │ /design/     │─────▶│ FLUX Fill  │
│ canvas   │   mask    │  mask)   │      │ remove-      │      │            │
│          │           │          │      │ objects      │      │            │
└──────────┘           └──────────┘      └──────────────┘      └────────────┘
```

## Implementation Units

- [ ] **Unit 1: Replicate provider'a SAM2 + FLUX Fill model kayıtları**

**Goal:** Yeni modelleri capability matrix'ine ve replicate adapter'ına ekle.

**Requirements:** R4

**Dependencies:** yok

**Files:**
- Modify: `HomeDecorAI-Backend/src/lib/ai-providers/capabilities.ts` — `adityaarun1/grounded-sam-2` (veya doğrulanan variant) + `black-forest-labs/flux-fill-pro` entry'leri.
- Modify: `HomeDecorAI-Backend/src/lib/ai-providers/replicate.ts` — mask_image input desteği; segment çağrısının binary output (mask URL) döndürebilmesi için return tipini genişlet.
- Modify: `HomeDecorAI-Backend/src/lib/ai-providers/types.ts` — `CallResult` union'a `maskUrl` variant veya ayrı `callSegmentation` fonksiyonu.

**Approach:**
- Mevcut `callDesignGeneration` sadece image url döndürüyor; yeni `callSegmentation(imageUrl, textPrompt)` fonksiyonu eklenir — aynı Replicate client, aynı circuit-breaker grubu.
- Capabilities matrix'ine her model için `maxPromptTokens`, `supportsGuidanceScale`, `role` (`"segment" | "inpaint" | "edit"`) alanları.

**Test scenarios:**
- Happy path: Grounded-SAM mock response → `maskUrl` döner.
- Happy path: FLUX Fill mock response → `imageUrl` döner.
- Error path: Replicate 5xx'de circuit-breaker mevcut kuralını izler.
- Error path: Grounded-SAM boş mask döndürürse (hiç clutter bulamazsa) `NoMaskDetectedError` fırlatır.

**Verification:** `pnpm test src/lib/ai-providers` yeşil. Manual: `callSegmentation` ile bir test photo → geçerli mask URL.

- [ ] **Unit 2: Segmentation + inpainting ortak servisi**

**Goal:** İki aracın da tüketeceği pipeline'ı tek yerde kapsüle et.

**Requirements:** R1, R2, R4, R8

**Dependencies:** Unit 1

**Files:**
- Create: `HomeDecorAI-Backend/src/lib/generation/segment-inpaint.ts` — `runSegmentThenInpaint({imageUrl, textPrompt, inpaintPrompt, declutterLevel})` ve `runInpaintOnly({imageUrl, maskUrl, inpaintPrompt})`.
- Modify: `HomeDecorAI-Backend/src/services/generation-processor.ts` — AI stage içinden tool type'a göre bu helper'lardan birini çağır; segmentation mask'i S3'e persist et ve Firestore doc'una `segmentationMaskUrl` yaz.
- Modify: `HomeDecorAI-Backend/src/lib/firestore.ts` — `recordAiResult` veya yeni `recordSegmentationCheckpoint` alanı ekle.

**Approach:**
- `runSegmentThenInpaint` adımları: (1) `callSegmentation` → temp mask URL (2) `persistGenerationImage` ile mask'i S3'e yaz (`masks/{generationId}.png`) (3) `callInpainting` → final image URL.
- Idempotency: Firestore doc'unda `segmentationMaskUrl` varsa SAM'i atla, doğrudan inpaint'e git.
- Tek `aiCompletedAt` checkpoint'i sonunda yazılır; retry yarıda kalmış inpaint'i yeniden dener ama SAM'i tekrar çalıştırmaz.

**Test scenarios:**
- Happy path (segment+inpaint): mocked SAM + inpaint → doc'a `segmentationMaskUrl` ve final URL yazılır.
- Happy path (inpaint-only): brush mask URL ile direkt inpaint; SAM atlanır.
- Edge case: SAM boş mask → `NoClutterDetectedError`, generation `failed` ile işaretlenir (kullanıcıya "oda zaten temiz görünüyor" mesajı).
- Integration: generation-processor retry → `segmentationMaskUrl` checkpointi varsa SAM ikinci kez çağrılmaz.
- Error path: S3 mask persist başarısız → retry action, SAM tekrar çalıştırılmaz (geçici mask URL hâlâ geçerliyse tekrar S3'e yaz).

**Verification:** `pnpm test src/lib/generation/segment-inpaint` yeşil. Integration test generation-processor'u bir clean-organize job ile uçtan uca (mocked providers) koşturur.

- [ ] **Unit 3: Clean & Organize prompt builder'ı mask-based moda taşı**

**Goal:** Prompt-only akıştan segment+inpaint akışına geç; tool type entry'sini güncelle.

**Requirements:** R1, R3, R5, R9

**Dependencies:** Unit 2

**Files:**
- Create: `HomeDecorAI-Backend/src/lib/prompts/dictionaries/clutter-taxonomy.ts` — `{full: string[], light: string[]}` clutter kelime listeleri (SAM text prompt için).
- Modify: `HomeDecorAI-Backend/src/lib/prompts/tools/clean-organize.ts` — builder iki çıktı verir: `segmentTextPrompt` (Grounded-SAM için) + `inpaintPrompt` (FLUX Fill için). Mevcut 7-layer yapısı inpaint prompt'una özel sadeleşir (clutter-removal'da tarz değişmediği için palette/style layer yok).
- Modify: `HomeDecorAI-Backend/src/lib/tool-types.ts` — `cleanOrganize` entry'si yeni prompt result tipi kullansın; processor'a hangi pipeline'ın çağrılacağını söyleyen `mode: "segment-inpaint"` alanı.
- Modify: `HomeDecorAI-Backend/src/lib/prompts/types.ts` — `PromptResult`'a opsiyonel `segmentTextPrompt` alanı.

**Approach:**
- Prompt builder taxonomiden seviyesine göre string kurar: `"clothes, cups, bottles, ..."`.
- Inpaint prompt'u: "clean uncluttered surface continuing the surrounding material and lighting; preserve original room geometry".
- Token budget primitive'i inpaint prompt'una uygulanır (FLUX Fill ~200 token); SAM text promptu ayrı budget'ta.

**Test scenarios:**
- Happy path: `declutterLevel=full` → taxonomy'deki full listesi SAM prompt'una girer.
- Happy path: `declutterLevel=light` → sadece light listesi.
- Edge case: Token budget aştığında hangi layer drop edilir (mevcut trim logic regresyonsuz).
- Integration: tool-types registry'den `cleanOrganize` entry çekildiğinde `mode === "segment-inpaint"` ve builder doğru çıktı verir.

**Verification:** `pnpm test src/lib/prompts/tools/clean-organize` yeşil. Eski snapshot'lar güncellenir.

- [ ] **Unit 4: Remove Objects backend tool type (yeni araç)**

**Goal:** iOS'tan gelen `{imageUrl, maskUrl, prompt?}` payload'unu yeni `removeObjects` aracı olarak kaydet.

**Requirements:** R2, R3, R4, R7

**Dependencies:** Unit 2

**Files:**
- Create: `HomeDecorAI-Backend/src/lib/prompts/tools/remove-objects.ts` — `buildRemoveObjectsPrompt({prompt?})` → `PromptResult` with `mode: "inpaint-only"`.
- Create: `HomeDecorAI-Backend/src/schemas/remove-objects.ts` ve OpenAPI tanımı; `CreateRemoveObjectsBody = {imageUrl, maskUrl, prompt?: string}`.
- Modify: `HomeDecorAI-Backend/src/lib/tool-types.ts` — `removeObjects` entry ekle (rate-limit aynı tool-level).
- Modify: `HomeDecorAI-Backend/src/schemas/generated/api.ts` — codegen sonrası.
- Modify: `HomeDecorAI-Backend/src/lib/generation/types.ts` — `ProcessGenerationInput` varyantına `maskUrl` ekle.
- Modify: `HomeDecorAI-Backend/src/routes/design.ts` — generic controller factory zaten bu entry'yi otomatik handle eder; sadece export edilen route path kontrol edilir.

**Approach:**
- Prompt default: "clean surface continuation, matching lighting and perspective". Kullanıcı opsiyonel prompt verirse inpaint guidance'a eklenir ("replace with {userPrompt}").
- Mask validation middleware: `maskUrl` HEAD request ile erişilebilirlik, content-type image/png, dimensions image ile eş (backend download + image-size check).
- Mask beyaz piksel oranı %0.5 - %30 aralığında olmazsa `MaskValidationError`.

**Test scenarios:**
- Happy path: geçerli mask → inpaint çağrılır, final URL döner.
- Edge case: mask boyutu image ile uyuşmuyor → 400.
- Edge case: mask tamamen siyah → 400 "no area to modify".
- Edge case: mask %30'dan fazla beyaz → 400 "area too large, use Clean & Organize or Interior Design".
- Error path: maskUrl 404 → 400 "mask not found".
- Integration: generation-processor removeObjects job'u uçtan uca (mocked FLUX Fill) tamamlar.

**Verification:** `pnpm test src/lib/prompts/tools/remove-objects src/routes/design` yeşil. OpenAPI schema Swagger'da görünür.

- [ ] **Unit 5: iOS Remove Objects wizard (sıfırdan)**

**Goal:** Photo upload → brush canvas → preview/confirm → submit.

**Requirements:** R6, R7

**Dependencies:** Unit 4

**Files:**
- Create: `HomeDecorAI/HomeDecorAI/Features/Wizard/ViewModels/RemoveObjectsWizardViewModel.swift` — state: `selectedImage`, `maskImage`, `brushRadius`, `undoStack`, `submissionState`.
- Create: `HomeDecorAI/HomeDecorAI/Features/Wizard/Views/RemoveObjectsWizardView.swift` — step container (Photo → Mask Canvas → Review).
- Create: `HomeDecorAI/HomeDecorAI/Features/Wizard/Views/Steps/BrushMaskCanvasView.swift` — PencilKit veya custom `Canvas`/`DrawingGestureHandler`; siyah arka plan + beyaz stroke üretir (output PNG).
- Create: `HomeDecorAI/HomeDecorAI/Features/Wizard/Services/RemoveObjectsWizardFlow.swift` — step order.
- Modify: `HomeDecorAI/HomeDecorAI/Features/Home/Models/HomeTool.swift` — `.removeObjects` case.
- Modify: `HomeDecorAI/HomeDecorAI/Features/Home/Models/HomeToolCategory.swift` — kategori yerleşimi (muhtemelen mevcut "Enhance" veya benzer).
- Modify: `HomeDecorAI/HomeDecorAI/Core/Network/DesignAPIService.swift` — `removeObjects(imageUrl:, maskUrl:, prompt:)` çağrısı.
- Modify: `HomeDecorAI/HomeDecorAI/Resources/Localizable.xcstrings` — TR/EN metinler.

**Approach:**
- Brush output: image boyutunda CGContext, kullanıcı stroke'ları beyaz, arka plan siyah. PNG encode → iOS S3 direct upload (mevcut Cognito akışı) → `maskUrl`.
- Undo: son N stroke tutulur, her strokun path+radius'u stack'e yazılır, undo'da canvas yeniden render.
- Validation: mask render sonunda beyaz piksel oranı %0.5'den azsa "boya eksik" hatası client-side gösterilir, submit butonu disable.
- Review step: original + mask overlay preview, "Remove" CTA.

**Test scenarios:**
- Happy path: photo seç → bölge boya → submit → API çağrısı doğru payload ile yapılır.
- Edge case: mask boş → submit disabled.
- Edge case: undo tüm stroke'ları siler → submit tekrar disabled.
- Error path: S3 upload fail → kullanıcıya retry UI.
- Integration: GenerationListenerService Firestore doc tamamlandığında sonucu gösterir.

**Verification:** Xcode preview + simulator'de uçtan uca; staging backend ile bir test fotoğrafında gerçek FLUX Fill çağrısı.

- [ ] **Unit 6: Clean & Organize iOS wizard minimal uyarlama**

**Goal:** iOS akışı aynı (photo + declutterLevel); sadece sonuç süresinin uzadığına göre yükleme UX'i ayarlanır.

**Requirements:** R1 (client kırılmamalı)

**Dependencies:** Unit 3

**Files:**
- Modify: `HomeDecorAI/HomeDecorAI/Features/Wizard/ViewModels/CleanOrganizeWizardViewModel.swift` — hiçbir şey yok (endpoint body aynı). Bu unit büyük ihtimalle no-op; sadece QA doğrulaması.
- Modify: `HomeDecorAI/HomeDecorAI/Features/Home/Copy` veya benzer — "temizlik daha hassas çalışıyor" küçük tooltip metni (opsiyonel).

**Test expectation:** none — davranış değişmez; mevcut iOS testleri regresyonsuz geçmeli.

**Verification:** Mevcut Clean & Organize wizard'ı staging'de end-to-end koştur; sonuç görsel kalitesini yeni pipeline'da gözle kontrol et.

- [ ] **Unit 7: Rollout, observability, feature flag**

**Goal:** Mask-based pipeline'ı kontrollü aç; eski clean-organize yolunun tam kaldırılmadan önce canlıda doğrulama pencere.

**Requirements:** operational

**Dependencies:** Unit 3, 4

**Files:**
- Modify: `HomeDecorAI-Backend/src/lib/env.ts` — `CLEAN_ORGANIZE_PIPELINE` env (`legacy | mask`) feature flag.
- Modify: `HomeDecorAI-Backend/src/lib/tool-types.ts` — flag'e göre builder/mode seçimi.
- Modify: `HomeDecorAI-Backend/src/lib/logger.ts` çağrı noktaları — `event: "segment.mask_detected"`, `"segment.empty"`, `"inpaint.completed"` structured log'ları.
- Modify: runbook `HomeDecorAI-Backend/docs/runbooks/` altında yeni `segment-inpaint-pipeline.md`.

**Approach:**
- Staging'de `mask` ile 1 hafta A/B; latency p95 ve SAM-empty-rate metriği izle.
- Prod'da flag açıldıktan 2 hafta sonra legacy path silinir (follow-up PR).

**Test scenarios:**
- Happy path: flag=mask → yeni pipeline koşar.
- Happy path: flag=legacy → eski prompt-only koşar (geçiş süresince).
- Edge case: flag değeri invalid → legacy'ye düşer + warn log.

**Verification:** Staging deploy; Slack'te `segment.empty` oranı < %5 hedef.

## System-Wide Impact

- **Interaction graph:** `design.controller → design.service → generation-processor → segment-inpaint.ts → replicate adapter → firestore`. Yeni halka: mask'in S3'e persist edilmesi.
- **Error propagation:** `NoClutterDetectedError`, `MaskValidationError`, `SegmentationTimeoutError` → `markFailed` + `GenerationErrorCode` union'ına yeni kodlar; iOS listener bu kodları i18n mesajlara map eder.
- **State lifecycle:** Yeni Firestore alanı `segmentationMaskUrl` idempotency checkpoint'i; mevcut `aiCompletedAt` hâlâ nihai gate.
- **API surface parity:** `cleanOrganize` body şeması değişmez (backwards compatible). `removeObjects` yeni endpoint — iOS güncellemesi gerekir.
- **Integration coverage:** generation-processor idempotency testi — aynı generationId iki kez worker'a düşerse SAM 1 kez, inpaint en fazla 1 kez çalışır.
- **Unchanged invariants:** paint-walls, floor-restyle, interior-design, virtual-staging pipeline'ları değişmez. Rate-limit, auth, notification layer'ları aynı.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Grounded-SAM'in oda fotoğrafında clutter'ı kaçırması / mobilyayı clutter sanması | Clutter taxonomy'si dar ve negatif-listeli; staging'de görsel QA; mask-empty fallback mesajı. |
| İki Replicate çağrısı p95 latency'yi 20s+ çıkarabilir | Min-loading window zaten 30-60s; kullanıcıya UX açısından görünmez. Flux Fill seçimi "pro" yerine "dev"e düşürülebilir. |
| Mask kenarları objenin içini/dışını yanlış keser | `dilate` post-process (OpenCV pipeline veya Replicate predictor param) — ilk bulgularda ayarlanır. |
| Remove Objects brush ile kullanıcı çok büyük alan boyar | Client-side %30 cap + backend validation hard-reject. |
| iOS PNG mask upload S3 credential akışı mevcut koda uymuyor | `CognitoCredentialMintError` branch'i mevcut; mask upload aynı flow reuse eder. |
| Legacy clean-organize yoluna bağlı kullanıcı cihazları eski cevap bekliyor | Flag ile kademeli geçiş; body schema aynı, response aynı. |

## Documentation / Operational Notes

- Runbook: `HomeDecorAI-Backend/docs/runbooks/segment-inpaint-pipeline.md` — Grounded-SAM boş mask oranı alarmı, Flux Fill failover, mask S3 cleanup politikası (90 gün retention).
- Swagger'da `removeObjects` endpoint'i görünmeli (OpenAPI codegen).
- Slack kanalı: `#homedecor-alerts` — yeni `segment.empty_rate` metrik eşiği %5.
- Mask S3 prefix'i `masks/` için lifecycle rule: 90 gün sonra delete.

## Verification (uçtan uca)

1. **Clean & Organize:** Staging'de çok dağınık bir oturma odası fotoğrafı yükle → declutterLevel=full → generation tamamlandığında: (a) Firestore doc'ta `segmentationMaskUrl` dolu (b) final görsel sadece clutter'ı kaldırmış (c) duvar rengi/perde/mobilya pikselde korunmuş.
2. **Clean & Organize (light):** Aynı foto, declutterLevel=light → daha az alan maskelenir (Slack log `segment.mask_detected` payload'unda).
3. **Remove Objects:** Fotoğrafta bir yastığı brush ile boya → submit → final görselde yastık yok, kanepenin geri kalanı değişmemiş.
4. **Remove Objects edge:** Boş mask → client submit disabled. Büyük mask (>%30) → backend 400.
5. **Idempotency:** Cloud Tasks bir clean-organize job'u 2 kez gönderirse Replicate dashboard'unda SAM 1 kez, inpaint en fazla 1 kez çağrılmış olmalı.
6. **Rollback:** Feature flag `legacy`'ye çevrilince eski prompt-only akış tek commit ile restore olmadan çalışmaya devam eder.

## Sources & References

- Mevcut araç: `HomeDecorAI-Backend/src/lib/prompts/tools/clean-organize.ts`
- Tool registry: `HomeDecorAI-Backend/src/lib/tool-types.ts`
- Provider adapter: `HomeDecorAI-Backend/src/lib/ai-providers/replicate.ts`
- Processor: `HomeDecorAI-Backend/src/services/generation-processor.ts`
- Replicate Grounded-SAM 2 model sayfası (staging'de doğrulanacak)
- black-forest-labs/flux-fill-pro model sayfası
- Origin: bu konuşma (requirements doc'u yoktu; plan bootstrap ile yapıldı)
