---
title: "Clean & Organize / Remove Objects — endüstri standardı ile hizalama"
status: active
date: 2026-04-19
related_plan: docs/plans/2026-04-19-001-feat-segmentation-inpainting-pipeline-plan.md
---

# Clutter Removal — Endüstri Best Practices ve Boşluk Analizi

## Problem Frame

Şu an iki aracımız canlıya gitmek üzere:

- **Clean & Organize** — Grounded-SAM 2 + 18 kelimelik statik clutter taxonomy + FLUX Fill.
- **Remove Objects** — iOS brush ile mask + FLUX Fill.

Kullanıcı taxonomy'ye itiraz etti ("bir ton eşya var hangisi"). Bu bir doc bug'ı değil, **yaklaşım bug'ı**: piyasadaki güçlü ürünler ne statik liste ne de FLUX Fill ile çalışıyor. Bu doc, endüstrinin nasıl çalıştığını belgeleyip bizim pipeline'ımızdaki spesifik boşlukları ve doğru düzeltme yönünü sabitler — planlama aşaması tekrar kararsız kalmasın diye.

## Endüstri Landscape (kanıtla)

### Üç kullanıcı etkileşim arketipi

| Arketip | Örnek ürünler | Kullanıcı eylemi | Altyapı |
|---|---|---|---|
| **Brush/click** (bizim Remove Objects) | Cleanup.pictures, Magic Eraser, Apple Clean Up, SnapEdit, Photoshop Remove Tool | Kaldırılacak alanı fırça ile boya | **LaMa** (WACV 2022) — Fourier konvolüsyonlu, obje çağrıştırmaz, sadece arka planı uzatır |
| **Auto-detect + opsiyonel NL yönerge** (bizim Clean & Organize'a en yakın) | REimagineHome, Edensign, Collov, InstantDecoAI | "Declutter the room" / "keep the chair, remove the table" | Open-vocabulary detection + depth/line/plane structural understanding; panoptic ADE20K segmentasyon |
| **Empty-the-room** (farklı ürün) | VirtualStaging.art, RoomLab empty-room modu | Tek tıkla tüm mobilya kaldır | Aynı auto-detect + tüm mobilya kategorisi maskeleme |

### Production'da hangi modeller

- **Inpainting:** 
  - **LaMa** — "obje-kaldırma" use case'i için endüstri dominant. Cleanup.pictures'ın altında bu var; lama-cleaner OSS projesi Cleanup'ın frontend'ini fork'lamış. Hızlı (~1s), prompt gerektirmez, halüsinasyon yok.
  - **FLUX Fill** — "belirli bir şeyle değiştir" generative edit'te (reklam görselleri, gökyüzü ekleme) iyi. Cleanup use case'inde "spurious elements" ekleme eğiliminde (Aligned Stable Inpainting paper, 2026).
  - **SD-based inpaint** — "unnatural boundaries" ve halüsinasyon sorunlu.
- **Segmentasyon:**
  - ADE20K-trained modeller (SegFormer-B5, InternImage, Mask2Former) → 150 sınıflı panoptic indoor parsing, en güçlüler %60+ mIoU.
  - Grounded-SAM 2 (GroundingDINO + SAM 2) → open-vocabulary, text-prompt ile hedeflenmiş segmentasyon.
  - En iyi ürünler **ikisini birden** kullanıyor: panoptic yapısal anlayış + open-vocab kullanıcı hedefi.
- **Clutter tanımı (akademik):**
  - ICCV 2023 "Clutter Detection and Removal in 3D Scenes" → clutter'ı "frequently-moving objects" olarak tanımlıyor, statik taxonomy'yi açıkça reddediyor. "Commonly-studied object categories well-captured değil" diyor.
  - Eğitim: ScanNet + Matterport3D, noisy-label grouping + virtual rendering + area-sensitive loss.

### Grounded-SAM prompting best practices (dokümantasyon)

- Kategoriler **`.` ile ayrılır**, `,` ile değil (tokenizer davranışı).
- Kısa tutulur — resmi demo prompt'ları 1-3 kelime (`"bear."`, `"person. bag."`).
- `text_threshold` knob'u ile kesinlik ayarlanır.
- Text-similarity ile post-hoc filtrele.
- **Bizim mevcut durumumuz:** 18 kelime virgülle ayrılmış, threshold ayarlanmamış — her iki konvansiyonu da ihlal ediyor.

## Bizim Sistemdeki Boşluklar (kanıtlı)

| # | Boşluk | Kanıt | Etki |
|---|---|---|---|
| G1 | **Remove Objects için yanlış inpainting modeli** | Cleanup.pictures / Magic Eraser LaMa kullanıyor; FLUX Fill bu use case'te "spurious elements" ekliyor. | Objeyi silmek yerine yerine başka bir şey uyduruyor; kullanıcı "temiz yüzey" bekliyor. Daha pahalı + daha yavaş. |
| G2 | **Clean & Organize için yanlış taxonomy stratejisi** | Endüstri statik liste kullanmıyor; open-vocab + NL ya da panoptic segmentasyon + clutter/decor classifier tercih ediyor. ICCV 2023 paper statik taxonomy'yi açıkça yetersiz buluyor. | 18 kelimelik liste bağlam-kör: "books" sehpada decor, yerde clutter — ikisini de maskeler; "clothes" battaniyeyi de yakalar. |
| G3 | **Grounded-SAM prompt formatı yanlış** | Virgülle değil nokta ile ayrılmalı; 18 kelime fazla uzun. | False positive artar, mobilyayı yanlışlıkla maskeler. |
| G4 | **Statik taxonomy staging'de doğrulanmadı** | Plan'ın kendisi "ilk testlerde ayarlanacak" diyor. | Prod'a tahminle gidiyoruz; ilk 100 kullanıcıda quality issue patlar. |
| G5 | **Yapısal prior yok** | Collov ve REimagineHome depth/line/plane kullanıyor; büyük alan silindiğinde perspektif tutarlı kalıyor. Bizde yok. | Remove Objects büyük bir objeyi silince yer/duvar birleşim çizgileri distorsiyonlu görünebilir. |
| G6 | **Edge refinement katmanı yok** | Cutout.Pro ve Magic Eraser "coarse segment + edge refinement" iki aşamalı mimari kullanıyor. SAM mask'i kaba kalıyor. | Silme sınırında belirgin "halka" artifact'ı. |

## Hedef State

Bu brainstorm'un `ce:plan`'a taşımasını istediğim üç seviye var — scope pick'i bir sonraki adımda netleşecek:

### Seviye 1 — Minimum Viable Fix (1-2 gün work)

**Amaç:** Prod'a gitmeden kritik iki bug'ı kapat.

- **H1 (G1):** `removeObjects` tool'u için FLUX Fill yerine **LaMa** kullan (Replicate'te `cjwbw/lama` veya `allenhooo/lama` fork'u). User-brush → LaMa, prompt gerekmiyor. FLUX Fill `removeObjects` registry'sinden çıkar.
- **H2 (G2+G3+G4):** `cleanOrganize` taxonomy'sini 5-7 yüksek-kesinlikli kelimeye indir, `.` ayırıcı kullan, staging'de 20-30 gerçek foto ile görsel QA yap, tune et. Flux Fill *segment bölgesi* üzerinde kalır (burada generative replacement kabul edilebilir çünkü "boş yüzey" üret denmiş).

**Non-goal:** Yeni UX, yeni model eğitimi, structural prior.

### Seviye 2 — Endüstri Parite (hafta ölçeğinde)

H1 + H2 **artı**:

- **H3 (G2):** Clean & Organize'a opsiyonel NL yönerge alanı ekle ("remove the cups and bottles", "empty the desk"). Boş bırakılırsa preset (full/light) davranır. REimagineHome pattern'i.
- **H4 (G2):** Grounded-SAM'e ek olarak **ADE20K panoptic segmenter** koş (SegFormer veya Mask2Former Replicate'te). Clutter adayı segmentleri panoptic'in "furniture/wall/floor" sınıfı ile kesiştirerek filtrele — mobilyayı yanlışlıkla silme riski düşer.

**Non-goal:** Kendi model eğitimi, 3D sahne anlayışı.

### Seviye 3 — Fark Yaratan (ay ölçeğinde)

H1+H2+H3+H4 **artı**:

- **H5 (G5):** Monokülar depth (DPT, Depth Anything) + line detection → inpaint context'i bu priors'larla zenginleştir. Büyük-alan kaldırmada perspektif tutarlılığı.
- **H6 (G6):** Coarse mask → edge refinement pass (matting model veya SAM2 fine-tuned). Temiz silme sınırı.
- **H7:** Kendi "clutter vs decor" binary classifier'ını ADE20K + staging'den türetilen etiketli setle eğit. Bağlam-aware maskeleme (sehpadaki kitap vs. yerdeki kitap).

## Scope Boundaries (bu brainstorm için)

- **IN:** Clean & Organize ve Remove Objects mevcut pipeline'ına odaklı düzeltmeler.
- **NOT in:** Virtual Staging'in empty-the-room modu (ayrı ürün kararı). 3D sahne rekonstrüksiyonu. Mobil on-device segmentasyon.
- **NOT in:** Paint-walls / floor-restyle stacks — onlar surface-restyle, generative paint için FLUX/Pruna doğru model.

## Key Decisions (bu brainstorm çıktısı)

- **Statik taxonomy stratejisinden vazgeçiyoruz.** H2 kısa-kesin listeyi köprü olarak tutar, H3 (NL) ve H4 (panoptic) asıl çözüm.
- **Remove Objects için LaMa standart.** FLUX Fill'de kalmıyoruz; bu "object-removal" kategorisinin yanlış modeli.
- **Structural priors / edge refinement Seviye 3'te.** MVP için gereksiz carrying cost.

## Open Questions (planlama öncesi resolve)

| S | Karar gerekli çünkü | Notlar |
|---|---|---|
| Replicate'te LaMa slug'larından hangisi? | Model pin'i ve input schema | `cjwbw/lama`, `allenhooo/lama`, `pg56714/Inpaint-Anything/lama` aktif fork'lar. Staging benchmark bir-iki test foto ile. |
| NL yönerge alanı Clean & Organize'a eklenirse mevcut `declutterLevel` enum'u (`full`/`light`) kalacak mı? | API contract + iOS wizard impact | İki seçenek: (a) NL opsiyonel field, level default; (b) level'ı deprecate edip NL primary. (a) backward-compat, (b) UX daha temiz. |
| Seviye 1 mi 2 mi 3 mü hedefliyoruz? | Effort + timeline | Ürün kararı; bu brainstorm sadece seçeneklendiriyor. |
| Panoptic segmenter (Seviye 2) ayrı Replicate çağrısı daha = 3 ardışık model (SAM + panoptic + inpaint). Latency kabul edilebilir mi? | p95 budget | Staging'de p95 ~25s hedefi; üç model ile 30-40s realistik. |

## Success Criteria

Seviye 1 uygulanmış sayılır:
- ✅ Remove Objects 20 test fotoğrafta, önceki FLUX Fill sonuçlarına göre (a) halüsinasyon oranı < %5, (b) "objenin hayaleti" (residual shadow/edge) gözle görünür değil, (c) latency < 10s.
- ✅ Clean & Organize 30 test fotoğrafta, (a) mobilya maskeleme oranı < %5, (b) clutter yakalama oranı > %70 (seçili kelime listesi için), (c) `segment.empty_mask` oranı < %10.

Seviye 2/3 için ayrı brainstorm'da.

## Sources & References

- [Clutter Detection and Removal in 3D Scenes with View-Consistent Inpainting (ICCV 2023)](https://arxiv.org/abs/2304.03763) — clutter = frequently-moving objects, statik taxonomy reddediliyor
- [advimman/lama (WACV 2022)](https://github.com/advimman/lama) — LaMa referans implementasyonu
- [lama-cleaner OSS](https://github.com/a-milenkin/lama-cleaner) — Cleanup.pictures'tan fork edilmiş frontend
- [IDEA-Research/Grounded-SAM-2](https://github.com/IDEA-Research/Grounded-SAM-2) — pipeline referansı
- [GroundingDINO README](https://github.com/IDEA-Research/GroundingDINO) — `.` separator + kısa prompt best practice
- [ADE20K Dataset](https://github.com/CSAILVision/ADE20K) — 150-sınıflı indoor panoptic benchmark
- [REimagineHome Empty Your Space](https://www.reimaginehome.ai/empty-your-space) — NL-guided declutter UX
- [Collov AI API](https://collov.ai/API) — open-vocabulary detection + depth/line/plane
- [Aligned Stable Inpainting (2026)](https://arxiv.org/html/2601.15368v1) — FLUX Fill'in "spurious elements" eğilimi, SD inpainting'in "unnatural boundaries" sorunu
- Related plan: `HomeDecorAI-Backend/docs/plans/2026-04-19-001-feat-segmentation-inpainting-pipeline-plan.md`
