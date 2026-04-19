---
title: "refactor: SAM 3 + LaMa unified pipeline (supersedes plans 001 & 002)"
type: refactor
status: active
date: 2026-04-19
origin: docs/brainstorms/2026-04-19-001-clutter-removal-best-practices-requirements.md
supersedes:
  - docs/plans/2026-04-19-001-feat-segmentation-inpainting-pipeline-plan.md
  - docs/plans/2026-04-19-002-refactor-lama-remove-taxonomy-tighten-plan.md
---

# SAM 3 + LaMa Unified Pipeline (v1)

## Overview

Tek bir mimari. Clean & Organize ve Remove Objects'in altında **iki model** çalışır:

- **SAM 3** (segmentasyon — `mattsays/sam3-image`)
- **LaMa** (inpainting — `allenhooo/lama` veya eşdeğeri)

Mevcut durumda üç model var (Grounded-SAM 2 + FLUX Fill + iki tool ayrı orkestrasyon). Bu plan onu **iki modele** indiriyor ve **iki tool'u aynı inpainter'a** bağlıyor. FLUX Fill tamamen kaldırılıyor.

## Problem Frame

Brainstorm (origin doc) iki gerçeği ortaya çıkardı:

1. **Endüstri standardı = SAM + LaMa (Inpaint Anything pattern).** Cleanup.pictures, IOPaint, SnapEdit, Apple Clean Up, Magic Eraser — hepsi bu mimaride. FLUX Fill "belirli bir şeyle değiştir" için, "temiz yüzeyle doldur" için değil.
2. **SAM 3 (Kasım 2025) GroundingDINO bağımlılığını kaldırdı.** Native "concept prompt" kabul ediyor — `"clutter"`, `"empty bottle"` gibi kavramsal noun phrase'ler. Bizim 18-kelimelik virgül-ayrılı taxonomy'miz anlamsız kaldı: SAM 3 `"clutter"` kavramını zaten anlıyor.

v1 hedefi: mimariyi tek, temiz, endüstri standardıyla hizalı bir hale getirmek. Her iki aracın da tek inpainter (LaMa), tek segmenter (SAM 3 — sadece Clean & Organize'da), paylaşılan helper kullanması.

## Requirements Trace

- **R1.** `removeObjects` pipeline'ı: client brush mask → LaMa → output. FLUX Fill yok.
- **R2.** `cleanOrganize` pipeline'ı: SAM 3 (text prompt) → mask → LaMa → output. Grounded-SAM 2 + FLUX Fill yok.
- **R3.** Taxonomy dictionary (`clutter-taxonomy.ts`) silinir. `declutterLevel` (full/light) backend'de SAM 3 concept prompt'ını modüle eder:
  - `full` → `"clutter"` (SAM 3'ün geniş kavram anlayışı)
  - `light` → `"trash . empty bottles . dirty dishes"` (yalnızca dar, yüksek-kesinlikli nesne sınıfları)
- **R4.** Mask persist + idempotency invariant'ı korunur: SAM 3 sonrası mask S3'e yazılır, `segmentationMaskUrl` checkpoint'i LaMa çağrısından ÖNCE yazılır (plan 001'in R8'i).
- **R5.** Env değişkenleri: `REPLICATE_SEGMENTATION_MODEL` default → `mattsays/sam3-image`; `REPLICATE_REMOVAL_MODEL` (yeni) default → `allenhooo/lama`. Eski `REPLICATE_INPAINT_MODEL` (FLUX Fill) **silinir**.
- **R6.** iOS kontratı hiç değişmez: `{imageUrl, declutterLevel}` ve `{imageUrl, maskUrl, prompt?}`. `prompt` alanı backend'de yok sayılır (LaMa path'te kullanılmıyor).
- **R7.** Circuit breaker mantığı korunur: SAM 3 ve LaMa `designCircuitBreaker`'a sample yazar; NoMaskDetectedError breaker'ı kirletmez.
- **R8.** Model slug'ları env'den overridable kalır; startup role verification iki model için de çalışır.

## Scope Boundaries

- **NOT:** iOS değişikliği. Remove Objects wizard, brush canvas, Clean & Organize wizard aynen.
- **NOT:** Natural-language yönerge ("keep the chair, remove the table") — Seviye 2.
- **NOT:** Tap-to-select SAM point prompt UX — Seviye 1.5 opsiyonel; bu plan'da yok.
- **NOT:** Depth/structural priors, edge refinement — Seviye 3.
- **NOT:** Video desteği (SAM 3.1 Object Multiplex) — bizim için relevant değil.
- **NOT:** Virtual Staging / Paint Walls / Floor Restyle — tek pixel dokunulmaz.
- **NOT:** ADE20K panoptic segmenter — Seviye 2.
- **NOT:** FLUX Fill'i başka bir tool'da da kullanmak — bu plan'dan sonra kodda hiçbir yerden referans kalmamalı (silinir).

## Context & Research

### Relevant Code and Patterns

- `src/lib/ai-providers/capabilities.ts` — `PROVIDER_CAPABILITIES`; SAM 3 ve LaMa entry eklenir, FLUX Fill entry **silinir**. `ModelRole` union: `"edit" | "segment" | "remove"`. `"inpaint"` kaldırılır.
- `src/lib/ai-providers/replicate.ts` — `callSegmentationReplicate` SAM 3 schema'sına adapte (input: `image + text_prompt`; output: maskURL). `callInpaintingReplicate` **silinir**. Yeni `callRemovalReplicate` LaMa için (input: `image + mask`; output: imageUrl).
- `src/lib/ai-providers/router.ts` — `callSegmentation` korunur (schema iç değişim). `callInpainting` **silinir**. Yeni `callRemoval`.
- `src/lib/ai-providers/types.ts` — `InpaintingInput/Output` **silinir**. `RemovalInput/Output` eklenir. `NoMaskDetectedError` kalır.
- `src/lib/env.ts` — `REPLICATE_INPAINT_MODEL` **silinir**. `REPLICATE_REMOVAL_MODEL` default `allenhooo/lama`. `REPLICATE_SEGMENTATION_MODEL` default `mattsays/sam3-image`. Startup role verification: `"segment"` ve `"remove"`.
- `src/lib/generation/segment-inpaint.ts` → **yeniden adlandır** `segment-remove.ts`. İçinde `runSegmentationAndPersistMask` + `runRemoval`. `runInpaint` **silinir**.
- `src/services/generation-processor.ts` — `mode` union: `"edit" | "segment-remove" | "remove-only"`. `"segment-inpaint"` ve `"inpaint-only"` **silinir**. Dispatch iki path: `segment-remove` (Clean & Organize) ve `remove-only` (Remove Objects).
- `src/lib/tool-types.ts` — `cleanOrganize` `mode: "segment-remove"`. `removeObjects` `mode: "remove-only"`. Her iki entry'de `models: {replicate, falai}` alanı **silinir** (kimse okumuyor).
- `src/lib/prompts/tools/clean-organize.ts` — `PromptResult.segmentTextPrompt` üretmeye devam eder ama dictionary yerine `declutterLevel` → concept mapping:
  - `full` → `"clutter"`
  - `light` → `"trash . empty bottles . dirty dishes"`
  - `inpaintPrompt` alanı **silinir** (LaMa prompt almıyor; `prompt` alanı `PromptResult` şeklinde boş string'e set edilir veya optional yapılır).
- `src/lib/prompts/tools/remove-objects.ts` — `buildRemoveObjectsPrompt` **silinir** veya trivial hale iner (sadece `PromptResult` stub'ı; LaMa prompt almadığı için içerik önemsiz).
- `src/lib/prompts/dictionaries/clutter-taxonomy.ts` — **silinir**.
- `src/lib/prompts/types.ts` — `PromptResult.prompt` optional yapılır veya boş string kabul edilir. `segmentTextPrompt?` kalır.
- `docs/runbooks/segment-inpaint-pipeline.md` → **yeniden adlandır** `segment-remove-pipeline.md`. Model slug'ları + validation güncellenir.
- `src/services/generation-processor.ts` — `recordAiResult`'a geçen `prompt` alanı artık LaMa'dan geldiği için anlamsız; boş string veya sentinel yazılır (DB schema değişmez, audit için).

### External References (confirmed)

- **SAM 3** — [Meta release (Nov 2025)](https://ai.meta.com/research/sam3/), [arxiv:2511.16719](https://arxiv.org/abs/2511.16719), [facebookresearch/sam3](https://github.com/facebookresearch/sam3), Replicate: [`mattsays/sam3-image`](https://replicate.com/mattsays/sam3-image) (~$0.001/run). Concept prompts: short noun phrases, image exemplars.
- **LaMa** — [advimman/lama (WACV 2022)](https://github.com/advimman/lama), Replicate forks: [`allenhooo/lama`](https://www.aimodels.fyi/models/replicate/lama-allenhooo), [`twn39/lama`](https://replicate.com/twn39/lama). L40S GPU ~2s latency.
- **Inpaint Anything pattern** — [arxiv:2304.06790](https://ar5iv.labs.arxiv.org/html/2304.06790), [geekyutao/Inpaint-Anything](https://github.com/geekyutao/Inpaint-Anything), reference OSS: [Sanster/IOPaint](https://github.com/Sanster/IOPaint) (formerly lama-cleaner, Cleanup.pictures'ın altı).
- **Grounded-SAM 2 retire gerekçesi** — SAM 3 `"clutter"`, `"yellow school bus"` gibi concept prompt'ları native anlıyor; GroundingDINO sandwich'i kalkıyor. SAM 3 SAM 2'ye göre daha iyi edge quality (review'daki G6 "edge refinement" boşluğunu kısmen kapatır).

### Institutional Learnings

- Plan 001'de yapılan review 7 bulgu çıkardı; onların çoğu fix'lendi. Kalan "P0 checkpoint ordering" fix uygulandı, ancak bu plan onu devralıyor: `runSegmentationAndPersistMask` içinde checkpoint write yeri aynı yerde kalacak.
- `claimProcessing resume` race condition (ce:review P2 #12) bu plan'da çözülmüyor; pre-existing ve bu refactor scope'unda değil.
- `validateClientUploadHost` (controller'da eklendi) `removeObjects` maskUrl'ünü allowlist kontrolüne alıyor — değişmez, doğru davranış.
- Mevcut `segment.mask_detected` / `inpaint.completed` log event'leri yeniden adlandırılabilir (`remove.completed`) ama observability dashboard'ları için migration gerekir — Deploy notes'ta var.

## Key Technical Decisions

- **LaMa tek inpainter.** Hem `cleanOrganize` hem `removeObjects`'ın altında. Brainstorm'daki "cleanOrganize FLUX Fill'de kalsın" notu iptal edildi: araştırma derinleştikçe LaMa'nın "clutter'ı sil + temiz yüzey" use case'i için FLUX Fill'den kesin üstün olduğu görüldü (IOPaint = lama-cleaner = Cleanup.pictures delili). Mimari simplicity + kalite = LaMa everywhere.
- **SAM 3 tek segmenter.** Grounded-SAM 2 retire edilir. Native concept prompts, GroundingDINO bağımlılığı yok, daha temiz sınır.
- **Taxonomy dictionary silinir.** SAM 3 concept mode'unda `"clutter"` tek kelime sufficient. `declutterLevel=light` biraz daha dar concept list'e gider (`"trash . empty bottles . dirty dishes"`), ama 18-kelime yerine 3-kelime.
- **Remove Objects `prompt` alanı deprecated (silinmez, yoksayılır).** iOS contract backward-compat için aynı kalır; LaMa path'te consume edilmez. Firestore'da da yazılmaz (yerine sentinel boş string). Kullanıcı yazarsa API silent drop — 1 sürüm sonra iOS'ta UI'dan kaldırılabilir.
- **Yeni mode isimleri:** `segment-remove` (Clean & Organize) ve `remove-only` (Remove Objects). Eski `segment-inpaint` ve `inpaint-only` mode isimleri kaldırılır — çünkü artık FLUX Fill yok, "inpaint" semantik olarak yanlış.
- **PromptResult.prompt optional.** LaMa prompt almadığı için builder'ın dönüş şekli bu alan olmadan da geçerli. Edit mode (Pruna/Klein) hâlâ prompt doldurur.
- **Env var cleanup:** `REPLICATE_INPAINT_MODEL` silinir. Kimse okumayacak.
- **Rollback stratejisi:** Full revert single commit. Feature flag yok. Staging'de 1 hafta doğrulanır, prod'a tek kerede gider. Rollback gerekirse bu PR'ı revert → plan 001'in son hali (FLUX Fill + Grounded-SAM 2) geri gelir.

## Open Questions

### Resolved During Planning

- **S: SAM 3 fork'u hangisi?**  
  Ç: `mattsays/sam3-image` — Meta'nın resmi SAM 3'ünün Replicate wrapper'ı, tek maintained community fork. Staging'de doğrulanır; başarısızsa Roboflow Inference API fallback (aynı backend-side `callSegmentation` aboveviç değişikliği).

- **S: LaMa fork'u hangisi?**  
  Ç: `allenhooo/lama` default; `twn39/lama` yedek. İkisi de aynı `advimman/lama` checkpoint'ini servis ediyor; staging'de benchmark sadece latency farkı için (kalite aynı). Default `allenhooo/lama` çünkü daha olgun.

- **S: `cleanOrganize` de LaMa kullanırsa "boş yüzey üret" davranışı garantili mi?**  
  Ç: Evet, LaMa'nın tek işi bu. FFC (Fast Fourier Convolutions) arka planı doğal şekilde uzatır; Samsung Research yazısı ve IOPaint paper bunu delil olarak gösteriyor.

- **S: SAM 3 output shape?**  
  Ç: Replicate model readme'si eksik; en olası `image + mask_url` veya `mask` (base64/URL). Implementation-time'da kesinleşir; `extractMaskUrl` helper zaten 4 shape probe ediyor (string, array, object.mask, object.masks[0]).

- **S: Eski tool'ları kullanan legacy Firestore doc'lar ne olacak?**  
  Ç: Prod'a geçmemişti; staging data throwaway. Ama kod açısından: eski `mode: "segment-inpaint"` ile create edilmiş doc'lar processor'da "unknown mode" ile VALIDATION_FAILED olur. Kabul edilebilir — staging test doc'larıdır.

### Deferred to Implementation

- SAM 3 input field tam adları (`image` vs `image_url`; `text` vs `text_prompt` vs `prompt`). İlk staging request'i 400 dönerse adapter düzeltilir.
- LaMa input field tam adları — aynı şekilde.
- `light` declutterLevel'ın ideal concept prompt kelime seti — staging'de 20+ foto görsel QA.
- `recordAiResult.prompt` alanına ne yazılacak (boş string mi, `"[LaMa]"` sentinel'i mi) — audit/metric için ufak karar; implementation'da netleşir.

## High-Level Technical Design

> *Directional; implementation spec değil.*

```
                 ┌─── Clean & Organize ───┐
                 │   photo + level        │
                 │                        │
                 ▼                        ▼
           /api/design/            /api/design/
           clean-organize          remove-objects
                 │                        │
                 │                        │ maskUrl (iOS brush)
                 ▼                        │
           SAM 3 (concept)                │
           "clutter" or                   │
           "trash . empty bottles"        │
                 │                        │
                 │ maskUrl                │
                 ▼                        │
           persist mask → S3              │
           checkpoint Firestore           │
                 │                        │
                 └─────────┬──────────────┘
                           │
                           ▼
                        ┌──────┐
                        │ LaMa │
                        └──┬───┘
                           │ outputImageUrl
                           ▼
                    persist → S3
                    mark completed
                           │
                           ▼
                    iOS Firestore listener
```

İki tool aynı `runRemoval(imageUrl, maskUrl)` çağrısını paylaşıyor. Mask kaynağı farklı ama LaMa invocation tek.

## Implementation Units

- [ ] **Unit 1: Capabilities + env + type sistemleri hizalama**

**Goal:** `ModelRole` union'ını `"edit" | "segment" | "remove"` yap, SAM 3 ve LaMa entry ekle, FLUX Fill ve Grounded-SAM 2 entry'lerini sil, env'i güncelle.

**Requirements:** R5, R8

**Dependencies:** yok

**Files:**
- Modify: `src/lib/ai-providers/capabilities.ts` — `ModelRole` değişimi; `mattsays/sam3-image` (role: segment), `allenhooo/lama` (role: remove). `adityaarun1/grounded-sam-2` silinir. `black-forest-labs/flux-fill-pro` silinir. `prunaai/p-image-edit` ve `fal-ai/flux-2/klein/9b/edit` (role: edit) kalır.
- Modify: `src/lib/env.ts` — `REPLICATE_INPAINT_MODEL` silinir. `REPLICATE_REMOVAL_MODEL` eklenir (default `allenhooo/lama`). `REPLICATE_SEGMENTATION_MODEL` default `mattsays/sam3-image`. Startup role verification: `segment` + `remove` iki alan.
- Modify: `src/lib/ai-providers/types.ts` — `InpaintingInput`, `InpaintingOutput` silinir. `RemovalInput` (`{imageUrl, maskUrl}`), `RemovalOutput` (`{imageUrl, provider, durationMs}`) eklenir.

**Approach:**
- SAM 3 capability: `supportsNegativePrompt: false`, `supportsGuidanceScale: false`, `supportsReferenceImage: true` (image exemplar desteği var ama bu plan'da kullanmıyoruz), `maxPromptTokens: 128` (concept prompt tipik 1-5 kelime).
- LaMa capability: tüm flag'ler `false`, `maxPromptTokens: 0`.
- Startup verification mesajları güncellenir (hedef: env yanlışsa 1 saniyede boot'ta exit).

**Test scenarios:**
- Happy path: doğru env ile boot → `role verification` geçer.
- Error path: `REPLICATE_SEGMENTATION_MODEL=black-forest-labs/flux-fill-pro` → role mismatch → `process.exit(1)`.
- Error path: unknown slug → warn log, boot devam.
- Unit: `PROVIDER_CAPABILITIES["mattsays/sam3-image"].role === "segment"`.

**Verification:** `pnpm test src/lib/ai-providers && pnpm test src/lib/env` yeşil. Dev boot'unda yanlış env ile anında fail.

---

- [ ] **Unit 2: Provider adapter + router helpers**

**Goal:** `callSegmentationReplicate` SAM 3 schema'sına adapte et; `callInpaintingReplicate` sil; yeni `callRemovalReplicate` + `callRemoval`.

**Requirements:** R1, R2, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/ai-providers/replicate.ts` — `callSegmentationReplicate` input `{image, text_prompt}` olarak SAM 3'e gönderir (Grounded-SAM 2'nin aynı field adlarıyla uyumlu olma ihtimali yüksek; kesin isim implementation-time). `extractMaskUrl` helper değişmez (aynı probe logic). `callInpaintingReplicate` **silinir**. Yeni `callRemovalReplicate(model, {imageUrl, maskUrl})` → LaMa wrapper.
- Modify: `src/lib/ai-providers/router.ts` — `callSegmentation` iç değişim yok (iç helper'ı aynı imza). `callInpainting` **silinir**. `callRemoval(input)` env'den slug okur, withRetry maxRetries: 1, breaker sample. `NoMaskDetectedError` hâlâ segmentation'da geçerli; LaMa'da yok.
- Modify: `src/lib/ai-providers/index.ts` — `callInpainting`, `InpaintingInput/Output` export'ları **silinir**. `callRemoval`, `RemovalInput/Output` eklenir.

**Approach:**
- SAM 3 text prompt separator `.` konvansiyonu korunur (GroundingDINO'dan miras ama SAM 3 de aynı konvansiyonu kullanıyor per paper/docs).
- LaMa wrapper minimal: sadece image + mask gönderir; output tek URL (extractImageUrl helper'ı reused).
- Dead code (FLUX Fill) tamamen silinir; retired comment'le bırakılmaz.

**Test scenarios:**
- Happy path: mocked SAM 3 response → `SegmentationOutput.maskUrl`.
- Happy path: mocked LaMa response → `RemovalOutput.imageUrl`.
- Error path: Replicate 5xx → retry 1 kez → sonra breaker record false + rethrow.
- Edge case: SAM 3 boş mask → `NoMaskDetectedError` (mevcut davranış).
- Edge case: LaMa null output → `Replicate removal returned no image`.

**Verification:** `pnpm test src/lib/ai-providers/{replicate,router}` yeşil.

---

- [ ] **Unit 3: `segment-remove.ts` + processor mode rewrite**

**Goal:** `segment-inpaint.ts` dosyası `segment-remove.ts`'e rename; `runInpaint` silinir, `runRemoval` eklenir. Processor `mode` union'ı yenilenir.

**Requirements:** R1, R2, R4

**Dependencies:** Unit 2

**Files:**
- Rename + edit: `src/lib/generation/segment-inpaint.ts` → `src/lib/generation/segment-remove.ts`. `runSegmentationAndPersistMask` korunur (aynen; checkpoint-before-LaMa invariant'ı plan 001'den taşınır). `runInpaint` silinir; `runRemoval({imageUrl, maskUrl})` LaMa wrapper.
- Modify: `src/services/generation-processor.ts` — `mode` union `"edit" | "segment-remove" | "remove-only"`. `segment-inpaint` ve `inpaint-only` branch'leri silinir. İki yeni branch:
  - `segment-remove`: `doc.segmentationMaskUrl` varsa reuse; yoksa `runSegmentationAndPersistMask` + `recordSegmentationCheckpoint` + `runRemoval`.
  - `remove-only`: `params.maskUrl` oku, direkt `runRemoval`.
- Modify: `src/lib/ai-providers/index.ts` — import path ayarı (`segment-remove.js`).

**Approach:**
- Checkpoint ordering invariant'ı korunur (review'daki P0 fix). `runSegmentationAndPersistMask` sonrası, `runRemoval` öncesi `recordSegmentationCheckpoint` write.
- StorageUploadError / CognitoCredentialMintError catch branch'leri (review'daki P1 #3 fix) aynen korunur.
- `NoMaskDetectedError` branch (review'daki fix) aynen korunur.
- `recordAiResult({prompt, ...})` çağrısında prompt olarak `""` (boş string) yazılır; builder'dan gelen prompt artık LaMa-relevant değil.

**Test scenarios:**
- Happy path segment-remove: mocked SAM 3 → persisted mask → mocked LaMa → `outputImageUrl` + `aiCompletedAt` set.
- Happy path remove-only: `params.maskUrl` var → SAM skip → mocked LaMa → `outputImageUrl`.
- Edge case: retry path on segment-remove — `doc.segmentationMaskUrl` dolu → SAM skip, direkt LaMa.
- Error path: SAM 3 `NoMaskDetectedError` → `VALIDATION_FAILED`.
- Error path: LaMa 5xx → `AI_PROVIDER_FAILED` (breaker sample = false).
- Error path: mask persist StorageUploadError → `STORAGE_FAILED`.
- Integration: `generation-processor` idempotency test — aynı generationId 2x → SAM 1 kez, LaMa 1 kez.

**Verification:** `pnpm test src/services/generation-processor` yeşil. Staging'de uçtan uca clean-organize + remove-objects isteği başarılı.

---

- [ ] **Unit 4: Prompt builder simplification**

**Goal:** Clean & Organize builder taxonomy dictionary yerine `declutterLevel → concept prompt` mapping. Remove Objects builder minimale düşür. Taxonomy dosyası sil.

**Requirements:** R3, R6

**Dependencies:** Unit 1 (type değişimi)

**Files:**
- Modify: `src/lib/prompts/tools/clean-organize.ts` — builder return'ü:
  - `segmentTextPrompt`: `declutterLevel === "full" ? "clutter" : "trash . empty bottles . dirty dishes"`
  - `prompt`: `""` (LaMa consume etmiyor)
  - Diğer alanlar (`guidanceScale: KLEIN_GUIDANCE_BANDS.faithful`, `actionMode: "transform"`, vs.) aynı.
  - `promptVersion`: `"cleanOrganize/v3.0-sam3-lama"`.
- Modify: `src/lib/prompts/tools/remove-objects.ts` — builder minimal; sadece `PromptResult` şekline uyar (prompt `""`, diğer alanlar default). `DEFAULT_FILL_PROMPT` silinir.
- Delete: `src/lib/prompts/dictionaries/clutter-taxonomy.ts` — komple silinir.
- Modify: `src/lib/prompts/types.ts` — `PromptResult.prompt` yorumuna not: "edit modeli için builder'lar doldurur; segment-remove/remove-only modellerinde `""` kabul edilebilir."

**Approach:**
- SAM 3 concept `"clutter"` kelimesi test edilmemiş tahmin değil; Meta'nın SAM 3 paper'ı `"yellow school bus"` örneği veriyor, concept mode'un amacı tam bu. Staging'de validation Unit 5'te.
- `light` mode için 3 yüksek-kesinlikli kelime; taxonomy'nin özeti. Daha da kısalabilir staging sonucuna göre.

**Test scenarios:**
- Unit: `buildCleanOrganizePrompt({declutterLevel: "full"})` → `segmentTextPrompt === "clutter"`.
- Unit: `buildCleanOrganizePrompt({declutterLevel: "light"})` → `segmentTextPrompt === "trash . empty bottles . dirty dishes"`.
- Unit: `buildRemoveObjectsPrompt({})` → `prompt === ""`, diğer alanlar valid.
- Integration: tool-types registry'den `cleanOrganize.buildPrompt(...)` doğru `PromptResult` üretir.

**Verification:** `pnpm test src/lib/prompts` yeşil. Eski `clutter-taxonomy.ts` referansları (grep ile) sıfır.

---

- [ ] **Unit 5: Tool-types güncelleme + staging validation + runbook**

**Goal:** `mode` isimlerini yeni union'a güncelle, dead `models` alanlarını sil, runbook'u yeni mimariye göre revize et, staging'de validation yap.

**Requirements:** R1, R2, R6, R8

**Dependencies:** Unit 1, 2, 3, 4

**Files:**
- Modify: `src/lib/tool-types.ts` — `cleanOrganize.mode = "segment-remove"`, `removeObjects.mode = "remove-only"`. Her iki entry'de `models: {replicate, falai}` alanı silinir (schema'dan kaldırılır; diğer edit-mode tool'larda kalır).
- Modify: `ToolTypeConfig` type — `models` alanı `edit` mode'da required, diğerlerinde required-olmayan'a çekilir (veya tamamen optional yapılır). Discriminated union güzel olurdu ama carrying cost yüksek; şimdilik optional.
- Rename + edit: `docs/runbooks/segment-inpaint-pipeline.md` → `docs/runbooks/segment-remove-pipeline.md`. Yeni model slug'ları, yeni observability event isimleri (`remove.completed` LaMa için), validation checklist.
- Update: runbook'a "Staging validation protocol" bölümü — 20 dağınık oda fotoğrafı koleksiyonu, her seviye için gözle QA (furniture false-positive < %5, clutter recall > %70, boş mask < %10).

**Approach:**
- Tool-types schema change breaking type'ı minimize etmek için `models?` optional yap + edit-mode tool'larda runtime guard (processor edit branch'i `tool.models` varlığını assume ediyor zaten; null olursa type error).
- Runbook'a deploy sırası: (1) Unit 1-2 deploy (dead kod, hiçbir şeyi bozmaz). (2) Unit 3-4 deploy (trafik yeni mimariye düşer). (3) Staging 1 hafta gözlem + validation protocol. (4) Prod deploy.

**Test scenarios:**
- Unit: `TOOL_TYPES.cleanOrganize.mode === "segment-remove"`.
- Unit: `TOOL_TYPES.removeObjects.mode === "remove-only"`.
- Unit: `TOOL_TYPES.interiorDesign.mode === undefined || "edit"` (edit-mode tool'lar dokunulmamış).
- Integration staging: gerçek SAM 3 + LaMa ile uçtan uca bir clean-organize + bir remove-objects generation. Sonuç görsel olarak doğru (hayalet yok, temiz sınır).
- Runbook validation protocol uygulanır; sonuçlar runbook'a tarihli commit ile yazılır.

**Verification:** `pnpm test src/lib/tool-types` yeşil. Staging deploy + manuel doğrulama + runbook'ta validation kaydı.

## System-Wide Impact

- **Interaction graph:** Eski `generation-processor → runSegmentThenInpaint → callSegmentation + callInpainting` yerine `generation-processor → runSegmentationAndPersistMask + runRemoval → callSegmentation + callRemoval`. İki tool aynı `runRemoval` call'ını paylaşıyor.
- **Error propagation:** `NoMaskDetectedError` (segment-remove only), `StorageUploadError`, `CognitoCredentialMintError` — mevcut classification aynı. `AI_PROVIDER_FAILED` / `AI_TIMEOUT` aynı. Yeni error yok.
- **State lifecycle:** Segment-remove: `segmentationMaskUrl` checkpoint aynı. Remove-only: checkpoint yazılmaz. Retry idempotency aynı.
- **API surface parity:** iOS kontratı hiç değişmez. Remove Objects `prompt?` field backend'de ignore. `declutterLevel` full/light backend dispatch davranışı değişir ama API şeması aynı. Generation history / Firestore doc shape değişmez.
- **Integration coverage:** Mevcut `aiCompletedAt` + `storageCompletedAt` + FCM event'leri aynen. İki yeni log event: `remove.completed` (LaMa succeed). Mevcut `inpaint.completed` silinir — dashboard alarmlarını migrate et.
- **Unchanged invariants:** interiorDesign, exteriorDesign, garden, patio, pool, outdoorLighting, paintWalls, floorRestyle, virtualStaging, referenceStyle, exteriorPainting — hepsi `mode: "edit"` default'ta, Pruna/Klein stack'leri dokunulmaz. Rate limits, auth, Cognito, Cloud Tasks, FCM layer aynı.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SAM 3 concept prompt `"clutter"` SAM 2 + GroundingDINO `"clothes, cups, bottles, ..."` kombinasyonundan daha kötü sonuç verir | Staging'de 20+ foto validation (Unit 5). Kötüyse `light` listesinin genişletilmiş versiyonu default'a geçer veya SAM 3 exemplar prompt'a geçilir. |
| `mattsays/sam3-image` fork'u SAM 3'ün tam feature-set'ini expose etmeyebilir (ör. image exemplar alanı eksik) | Plan'da exemplar kullanmıyoruz. Eksiklik concept-only path'i etkilemez. |
| LaMa `allenhooo/lama` fork'u mask edge'lerinde artifact bırakır | `twn39/lama` yedek fork. Kaliteye değil, edge refinement pass'e (Seviye 3) ihtiyaç olursa Seviye 3. |
| FLUX Fill silinmesi nedeniyle acil rollback zorlaşır | Full revert = single-commit PR revert. Git history intact. 1 hafta staging gözlemi sonrası prod'a. |
| iOS `prompt` alanını hâlâ kullanıcıya göstererek yanlış beklenti yaratır | iOS v+1 release notu: "prompt alanı ileride kaldırılacak". 1 sürüm sonra iOS UI'dan temizlenir. Bu plan'ın scope'unda değil. |
| SAM 3 output shape `extractMaskUrl` helper'ının bildiği 4 varyantın dışında | Implementation time'da staging 400'de netleşir; helper'a 5. varyant eklenir. |
| Observability dashboard'ları eski event isimlerine bağlı | `inpaint.completed` → `remove.completed` rename; dashboard migration notu runbook'ta. |

## Documentation / Operational Notes

- Runbook rename + rewrite: `docs/runbooks/segment-remove-pipeline.md`. İçerikte: model slug'ları, env var'ları, observability event isimleri, rollback prosedürü, IAM policy gereksinimi (`masks/*` prefix — plan 001'den taşınıyor).
- Slack alert migration: `inpaint.completed` → `remove.completed`. Pre-deploy task; ops channel'da duyuru.
- Deploy sırası:
  1. Unit 1 (capabilities + env) + Unit 2 (provider adapter) — dead kod, kimse kullanmıyor.
  2. Unit 3 (processor mode rewrite) + Unit 4 (builder simplify) — trafik yeni mimariye düşer.
  3. Staging 1 hafta gözlem (`segment.empty_mask` oranı, latency p95, FCM success rate).
  4. Unit 5 (tool-types final + runbook + validation protocol).
  5. Prod deploy.
- Rollback: staging'de p95 > 25s veya `segment.empty_mask` > %15 ise tek-commit revert, plan 001 son haline dönüş.

## Verification (uçtan uca)

1. **Clean & Organize staging `full`:** Dağınık oturma odası → `declutterLevel=full` → SAM 3 concept `"clutter"` ile mask → LaMa fill. Sonuç: mobilya pixel-perfect, clutter (kıyafet, kupa, şişe) silinmiş.
2. **Clean & Organize staging `light`:** Aynı foto → `light` → daha dar concept → daha az alan maskelenir.
3. **Remove Objects staging:** Yastık fırça ile boya → LaMa fill. Sonuç: yastık silinmiş, kanepe dokunulmamış, hayalet yok.
4. **Idempotency:** Cloud Tasks aynı generationId'i 2x gönderirse — SAM 3 1 kez, LaMa en fazla 1 kez (checkpoint invariant).
5. **Rollback drill:** Revert PR açılıp merge edilince plan 001 davranışı geri gelir (env var değişimi de olabilir).
6. **Slug migration:** `REPLICATE_SEGMENTATION_MODEL` = yanlış-role slug → boot fail. Doğru slug → boot geçer.
7. **Backward compat:** iOS'taki eski Remove Objects submit'ı (prompt alanıyla) ignore edilir ama 202 döner.
8. **Validation artifact:** Runbook'ta 20+ foto staging QA sonuçları commit'lenmiş.

## Sources & References

- **Origin:** [docs/brainstorms/2026-04-19-001-clutter-removal-best-practices-requirements.md](../brainstorms/2026-04-19-001-clutter-removal-best-practices-requirements.md)
- **Supersedes:** `docs/plans/2026-04-19-001-feat-segmentation-inpainting-pipeline-plan.md`, `docs/plans/2026-04-19-002-refactor-lama-remove-taxonomy-tighten-plan.md`
- **Runbook target:** `docs/runbooks/segment-remove-pipeline.md` (rename)
- **External:**
  - [SAM 3 paper (arxiv:2511.16719)](https://arxiv.org/abs/2511.16719)
  - [Meta SAM 3 release](https://ai.meta.com/research/sam3/)
  - [facebookresearch/sam3](https://github.com/facebookresearch/sam3)
  - [Replicate mattsays/sam3-image](https://replicate.com/mattsays/sam3-image)
  - [advimman/lama (WACV 2022)](https://github.com/advimman/lama)
  - [Replicate allenhooo/lama](https://www.aimodels.fyi/models/replicate/lama-allenhooo)
  - [Inpaint Anything (arxiv:2304.06790)](https://ar5iv.labs.arxiv.org/html/2304.06790)
  - [Sanster/IOPaint (lama-cleaner reference)](https://github.com/Sanster/IOPaint)
