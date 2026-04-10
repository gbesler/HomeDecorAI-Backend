---
date: 2026-04-10
topic: interior-prompt-quality
---

# Interior Design Prompt Quality & Extensible Prompt Architecture

## Problem Frame

`HomeDecorAI` iOS uygulamasının Interior Design wizard akışı, kullanıcıdan oda fotoğrafı + oda tipi (12) + stil (18) alarak BE'ye gönderir. BE bu girdileri tek bir generic şablondan geçirerek Replicate (prunaai/p-image-edit) veya fal.ai (flux-2/klein/9b/edit) modellerine prompt olarak verir.

Mevcut prompt (`HomeDecorAI-Backend/src/lib/prompts.ts`), 216 farklı {oda × stil} kombinasyonu için tek bir jenerik iskelet kullanıyor; stil sadece kelime olarak interpolate ediliyor, oda tipinin kendine has odak noktaları yansıtılmıyor, yapısal koruma direktifi zayıf, negatif prompt yok, fotoğrafçılık kalite token'ları yok. Bunun sonucu: `luxury bathroom` ile `japandi gamingRoom` aynı iskeletten geçiyor ve Flux Edit modellerinden çekilebilecek kalitenin önemli bir kısmı yerde kaldığı değerlendiriliyor — ancak bu değerlendirme şu an için kanıtlanmış değildir. Plan, R1–R23 implementasyonuna geçmeden önce bir **Phase 0: Pre-Planning Validation** aşamasında bu varsayımı ölçüp ucuz-fix vs full-rewrite arasındaki gerçek kazancı belirlemelidir (aşağıda P0.* ile listelenmiştir).

Ayrıca iOS tarafında şu an canlı olmayan 8 tool daha (ExteriorDesign, VirtualStaging, GardenDesign, PaintWalls, FloorRestyle, CleanOrganize, ExteriorPainting, ReferenceStyle) ileride BE'ye eklenecek. Interior Design için yazılacak prompt sistemi, bu tool'ların kolayca plug-in olabileceği paylaşımlı primitives + dictionaries + tool-specific builder mimarisine oturmalı.

Bu iş, hem prompt kalitesinin tavanını yükseltmeyi hem de ileride genişlemeyi sorunsuz yapabilecek bir altyapı koymayı hedefliyor.

## Requirements

### Phase 0: Pre-Planning Validation (blocking)

Bu aşama `/ce:plan` çağrılmadan önce tamamlanmalıdır. Amacı: (a) sprint premise'ini ampirik olarak doğrulamak, (b) teknik blocker'ları ölçmek, (c) R1–R23 scope'unun bu ölçümlere göre daraltılması/genişletilmesi gerekip gerekmediğini görmek.

- **P0.1. Mevcut prompt baseline'ı.** Mevcut `buildInteriorDesignPrompt` ile 20–30 output üretilmeli: en az 5 farklı stil × 5 farklı oda kombinasyonu + 3–5 uç durum (christmas+bathroom, airbnb+gamingRoom, stairway+minimalist). Her output şu failure-mode kategorilerinden biriyle etiketlenmeli: `wrong-style` / `structural-drift` / `photo-quality` / `model-artifact` / `acceptable`.
- **P0.2. Ucuz fix denemesi.** Mevcut prompt şablonuna SADECE R4 (structural preservation primitive) ve R7 (negative prompt) manuel olarak eklenerek aynı 20–30 kombinasyon tekrar üretilmeli. Baseline ile A/B karşılaştırılmalı. Eğer ucuz fix failure oranını >50% oranında düşürüyorsa R2/R3/R5/R6 katmanlarının marjinal kazancı sorgulanmalı ve R1–R7 scope'u daraltılmalı.
- **P0.3. Flux token budget ölçümü.** Her iki provider modelinin (`prunaai/p-image-edit`, `fal-ai/flux-2/klein/9b/edit`) prompt token limiti test edilmeli: (a) kasıtlı uzun bir prompt (500+ token) gönder, output'un uzun prompt'a reaksiyon gösterip göstermediğini ölç, (b) modelin tokenizer'ı T5-256 mı, T5-512 mi yoksa başka mı belirlenmeli. Sonuç R1–R7 kompozisyonu için hard token budget tanımlamalı.
- **P0.4. Negative prompt schema doğrulaması.** Replicate `prunaai/p-image-edit` modeline `negative_prompt` alanıyla bir test çağrısı gönder; schema rejection vs silent-drop vs accept davranışını ölç. Aynısı fal.ai için. Destek yoksa R16'nın inline "avoid:" fallback'i aktif edilir.
- **P0.5. Style-pick analytics (mümkünse).** Firestore veya in-app analytics'ten son 30–90 günde kullanıcıların 18 stil arasında pick distribution'ı çekilmeli. <5% pick alan stiller tespit edilip dict-authoring önceliğinden düşürülmeli. Analytics yoksa bu adım atlanır ve eşit ağırlık varsayılır.
- **P0.6. User-outcome baseline.** Bugünkü regeneration rate (kullanıcının aynı girdilerle kaç kez re-generate ettiği) ve save/share rate Firestore history'den çekilebiliyorsa ölçülmeli. Bu, Success Criteria'daki user-outcome metriği için referans olur. Ölçülemiyorsa plan aşamasında instrumentation eklenmesi R'ye eklenir.

Phase 0 sonunda bir kısa özet yazılmalı ve bu brainstorm dokümanı update edilmelidir. Eğer ucuz fix (P0.2) baseline'ı çözüyorsa sprint scope'u R4+R7 odaklı daraltılmalı; çözmüyorsa R1–R18 olduğu gibi planlanmalı.

### Prompt Anatomy (Interior Design)

Her Interior Design prompt'u şu 7 katmandan kompoze edilmelidir:

- **R1. Action directive.** Açık "transform / restyle" cümlesi, hem oda tipini hem stili dahil eden ama kelime tekrarına düşmeyen formda.
- **R2. Style descriptor (zengin).** Her stil için sözlükten çekilecek şu alanları içermelidir:
  - `coreAesthetic` — 2–3 defining adjective
  - `colorPalette` — 3–4 somut renk adı (ör. "warm walnut, off-white, brass, deep charcoal"), "neutral" gibi belirsiz sözcükler yasak
  - `materials` — ahşap türü, metal kaplaması, kumaş tipleri, taş türleri
  - `signatureItems` — stil tanımlayıcı parça isimleri (ör. japandi = "low wood platform bed, paper lantern, wabi-sabi ceramics")
  - `lightingCharacter` — ışığın sıcaklığı, yumuşaklığı, kaynak tipi
  - `moodKeywords` — 2–3 mood sözcüğü
  - `actionMode: "transform" | "overlay" | "target"` — R1 action directive'inin hangi varyantı kullanılacağını belirler. Varsayılan `"transform"` (tam restyle); `"overlay"` mevcut stili koruyup üzerine katman ekler (christmas); `"target"` bir hedef/kullanım durumu encode eder (airbnb).
  - `guidanceBand: "creative" | "balanced" | "faithful"` — R17'deki guidance scale band'ine karşılık gelir. Per-style tuning yerine 3 bant, empirik veri birikene kadar.
- **R3. Room focus.** Oda tipine göre neye odaklanılacağı sözlükten çekilmelidir (ör. bathroom → fixtures, tiles, vanity hardware; stairway → railings, runners, wall gallery; gamingRoom → ergonomic setup, ambient RGB, cable management). Her oda için "ne eklenmeli / ne eklenmemeli" hatırlatması.
- **R4. Structural preservation primitive (paylaşılan).** Camera angle, perspective, ceiling height, wall positions, window count/shape/view, door placements, floor plan boundaries aynı kalmalı. Duvar/pencere/kapı eklenmesi/çıkarılması yasak. Bu bölüm tüm edit-based tool'ların (interior, exterior design, virtual staging vs.) tekrar kullanacağı bir primitive olarak tanımlanmalı.
- **R5. Photography quality primitive (paylaşılan).** Professional interior editorial photography, wide-angle, natural daylight + warm ambient fill, sharp focus, HDR, magazine-quality composition — tüm photorealistic tool'ların paylaşacağı bir primitive.
- **R6. Lighting & atmosphere.** Stilden türetilen zaman/ışık önerisi (ör. Scandinavian → bright overcast morning; Luxury → golden hour with warm interior glow; Industrial → late afternoon with long window shadows).
- **R7. Negative guidance.** Warped perspective, distorted furniture, floating objects, extra rooms, duplicate or added windows, visible text/watermark, cartoonish rendering, unrealistic proportions, empty cluttered mess — sabit bir "avoid" listesi.

### Style Coverage (18 stilin tamamı)

- **R8. Her stil için sözlük girdisi zorunludur.** Aşağıdaki stillerin her biri R2'de tanımlanan 6 alanı eksiksiz doldurmalıdır: `modern, minimalist, scandinavian, industrial, bohemian, contemporary, midCentury, coastal, farmhouse, japandi, artDeco, traditional, tropical, rustic, luxury, cozy, christmas, airbnb`.
- **R9. Christmas — overlay mode + room whitelist.** Christmas, `actionMode: "overlay"` ile işaretlenir. R1 action directive'inin overlay varyantı "preserve the existing interior style and layer seasonal Christmas decor" cümlesini üretir. Layered decor: Christmas tree, garland, warm string lights, seasonal throws, wrapped gifts, wreaths. **Per-room whitelist:** overlay davranışı yalnızca `livingRoom, diningRoom, entryway, bedroom` için tam recipe ile aktiftir. Bu dört oda için sözlükte per-room christmas recipe tanımlanır (ör. `entryway`: wreath on door, garland on railing, welcome runner; `diningRoom`: tablescape, centerpiece, festive linen). Whitelist dışındaki odalar (`bathroom, kitchen, gamingRoom, office, homeOffice, studyRoom, underStairSpace, stairway`) için overlay fallback: yalnızca minimum festive accent (wreath, small string lights, seasonal hand towels / decor items), oda-specific dialect (R13/R14/R15) korunur. `bathroom + christmas` gibi kombinasyonlarda "Christmas tree in bathroom" gibi absürt öğeler üretilmez.
- **R10. Airbnb — target mode.** Airbnb, `actionMode: "target"` ile işaretlenir. R1 action directive'inin target varyantı "stage this room as broadly appealing rental-ready space with durable, neutral but warm finishes" cümlesini üretir. Signature items yerine "rental-optimized staging principles": minimum kişisel nesne, dayanıklı malzemeler, evrensel konforlu staging, iyi aydınlatılmış davet edici atmosfer. **Room-dialect interaction:** target mode R13/R14/R15 oda-specific dialect'leriyle çakışmaz — `airbnb + gamingRoom` kombinasyonu gaming setup'ı korur ama RGB'yi kısar, kişisel objeleri temizler, nötralize eder; `airbnb + bathroom` fixtureları korur ama neutral palette'le değiştirir; `airbnb + stairway/underStairSpace` için minimal styling uygulanır.
- **R11. Kapsayıcı test.** 18 stilden en az 10 tanesi için, jenerik "the room in a {style} style" cümlesini içermeyen, sözlükten dolu somut çıktı üretebilmeli.

### Room Coverage (12 odanın tamamı)

- **R12. Her oda için focus map girdisi zorunludur.** `livingRoom, bedroom, kitchen, underStairSpace, diningRoom, bathroom, entryway, stairway, office, homeOffice, studyRoom, gamingRoom`.
- **R13. Bathroom / kitchen özel dili.** "Replace all furniture" dili yerine fixture/tile/hardware odaklı language kullanılmalı (bathroom: vanity, mirror, fixtures, tile pattern, lighting; kitchen: cabinetry, countertop, backsplash, hardware, island).
- **R14. Unusual rooms (stairway, entryway, underStairSpace).** Mobilya ekleme dili değil, hat/runner/lighting/wall art/built-in storage odaklı dil. "Replace all furniture" ifadesi bu odalar için çıkarılmalı.
- **R15. GamingRoom özel dili.** Ergonomic chair, multi-monitor desk setup, ambient RGB accent lighting, cable management, acoustic paneling gibi gaming-specific unsurlar. Stil overlay'i bunların üzerine uygulanır.

### Generation Pipeline Enhancements

- **R16. Negative prompt pipeline desteği.** `lib/ai-providers/types.ts` içindeki `GenerationInput` tipine `negativePrompt?: string` alanı eklenmeli. `replicate.ts` ve `falai.ts` bu değeri provider-specific input shape'lerine iletmeli (her iki Flux Edit modelinin gerçek input şemasında hangi alan adıyla desteklendiği — `negative_prompt` veya başka — "Resolve Before Planning" bölümünde doğrulanmalıdır; destek yoksa negatif token'lar pozitif prompt'un sonuna "avoid: ..." cümlesi olarak inline edilir). Bu değer R7'de tanımlanan listeden üretilir ve her generation çağrısına eşlik eder.
- **R17. Guidance scale — band yaklaşımı (per-style değil).** `buildPrompt` fonksiyonu artık `{prompt, negativePrompt, guidanceScale}` döndürmelidir. Guidance scale değeri, stil sözlüğünün `guidanceBand` alanından (R2) türetilen bir band → numeric value map'i üzerinden belirlenir: `"creative"` (daha düşük guidance, stil daha gevşek yorumlanır), `"balanced"` (orta varsayılan), `"faithful"` (daha yüksek guidance, stil daha sadık render edilir). Her 18 stil için individual tuning yapılmaz — önce 3 bant ship edilir, per-style tuning Phase 0.1/0.2 ölçümleriyle veri geldikten sonra post-launch refinement olarak ele alınır. Band-numeric eşlemesi planlama sırasında her iki provider için ayrı ayrı doğrulanır (prunaai fork ile flux-2 klein'ın guidance_scale aralıkları farklı olabilir). Hem Replicate hem fal.ai call site'ı bu değeri iletmelidir — zaten provider kodu `guidance_scale` alanını hazır kabul ediyor. Bu değişiklik `src/services/design.service.ts:63` içindeki `const prompt = toolConfig.buildPrompt(...)` satırının yeni `{prompt, negativePrompt, guidanceScale}` shape'ini destructure etmesini ve `callDesignGeneration` çağrısında üç alanı da `GenerationInput`'a iletmesini gerektirir.
- **R18. Geriye dönük uyumluluk.** API shape'i (POST /interior request body) değişmemelidir. iOS wizard halen `{imageUrl, roomType, designStyle}` gönderir. Tüm yeni zenginleştirmeler BE internal'dır.

### Architecture & Extensibility

- **R19. Prompt katmanı yeniden organize edilmeli.** Mevcut tek dosya `src/lib/prompts.ts` + `src/lib/tool-types.ts` yapısı, aşağıdaki modüler yapıya taşınmalıdır:
  - `dictionaries/` — `designStyles` ve `rooms` sözlükleri (birden fazla tool'un paylaşabileceği veri)
  - `primitives/` — `structuralPreservation`, `photographyQuality`, `negativePromptBase` (birden fazla tool'un paylaşabileceği prompt parçaları)
  - `tools/` — her tool için ayrı builder dosyası; bu sprint'te yalnızca `interiorDesign` doldurulacak
  - Tool-level `tool-types.ts` kaydı, `prompts/tools/*` içindeki gerçek builder'ı çağıran ince bir pass-through olmalıdır
- **R20. Paylaşım diskuru dict'lerde açık.** `designStyles` sözlüğü, iOS'ta `DesignStyle` enum'ının birden fazla tool tarafından paylaşıldığı gerçeğiyle uyumlu olmalı (Interior Design + ileride Exterior Design aynı 18 stili kullanacak). `rooms` sözlüğü aynı şekilde Interior Design + Virtual Staging için ortak.
- **R21. Primitive'ler tool-agnostic.** `structuralPreservation` ve `photographyQuality` primitive'leri "interior" kelimesini içermemeli; opsiyonel bir `subject` parametresi alıp "interior", "garden", "exterior" gibi çağrı yerinden dolduralabilir olmalıdır. Böylece Garden Design ileride aynı primitive'i reuse edebilir.
- **R22. Tool builder contract'ı — esnek shape.** Her tool için `buildPrompt(params) -> PromptResult` tek tip bir contract tanımlanmalı. `PromptResult` **zorunlu** alanlar: `prompt: string, negativePrompt: string, guidanceScale: number`. Ek olarak her tool kendi ihtiyacına göre opsiyonel tool-specific alanlar (ör. `referenceImageUrl?: string` ReferenceStyle için, `maskUrl?: string` object removal için, `seasonHint?: string` GardenDesign için) ekleyebilir. Bu esneklik, contract'ı ikinci tool geldiğinde kırmadan genişletmeyi mümkün kılar. `TOOL_TYPES` kaydı (`src/lib/tool-types.ts:11`) bu contract'a göre satisfies olmalı; mevcut `ToolTypeConfig` interface'i `buildPrompt: (params) => string` tanımını yeni `PromptResult` return shape'iyle değiştirmeli. Provider call site'ı yalnızca zorunlu 3 alanı okur, ekstraları ignore eder; tool-specific alanlar tool-specific provider call path'i gerektirdiğinde o path'te okunur. (Terminoloji: bu dokümanda **tool** = bir tasarım yeteneği birimi olarak kullanılır — architectural unit; **toolType** = o birimin `TOOL_TYPES` record'undaki string anahtarı — örn. `"interiorDesign"`.)
- **R23. Bu sprint'te implement edilen tek tool: `interiorDesign`.** Diğer tool'lar için `tools/` klasörüne placeholder dosya açılmaz; sadece mimari şekli korunduğu için gelecekte eklemek mekanik olur.
- **R24. Graceful enum degradation.** iOS `DesignStyle` veya `RoomType` enum'ına backend dictionary'sinde karşılığı olmayan bir değer eklerse (iOS ayrı ship edilebildiği için olası), builder hard-fail etmemelidir. `buildPrompt` bilinmeyen bir `designStyle` veya `roomType` aldığında şunları yapar: (a) generic fallback skeleton üretir (şu anki `buildInteriorDesignPrompt`'a yakın), (b) structured log emit eder (`event: "prompt.unknown_style"` veya `"prompt.unknown_room"`, level: warn, payload: `{designStyle, roomType}`), (c) fallback prompt yine R4 structural preservation + R7 negative prompt primitive'leriyle zenginleştirilir. Böylece iOS/backend sync drift'i user'ı 5xx ile karşılaştırmaz, gözlemlenebilir olarak degrade olur.
- **R25. Dictionary editorial validation.** 18 stil × 6–8 field'lık curated content'in kalitesi için bir validation eşiği: her stil için en az 3 referans görsel (Pinterest board, Architectural Digest, etc.) belirlenmeli ve dict entry'si bu referans setiyle yaklaşık eşleşmeli. Bu, "Japandi'ye yanlışlıkla brass eklemek" gibi yüksek özgüvenli hataları yakalar. Editorial owner: Yusuf (single-owner sprint için). Refresh cadence: plan aşamasında kararlaştırılır ama en geç 6 ayda bir review önerilir.
- **R26. Firestore prompt size cap.** Yeni zengin prompt'lar ~1500–3000 char'a ulaşabilir (mevcut ~300 char). `design.service.ts` içindeki `createGeneration` çağrısı, prompt'u Firestore'a yazmadan önce 4000 byte sınırına truncate etmeli (uzun olursa `...[truncated]` suffix'iyle). Ayrıca plan aşamasında `prompt` field'ının mevcut/planlı Firestore index'i olup olmadığı doğrulanmalı; eğer ileride search için indexlenecekse ayrı bir `promptSummary` field'ı kullanılmalıdır (Firestore indexed string 1500 byte limit'i nedeniyle).

## Success Criteria

**Build completeness:**
- 216 {oda × stil} kombinasyonunun tamamı, en az R1–R7 katmanlarını dolduran non-trivial bir prompt üretir.
- Her `buildPrompt` çağrısı `{prompt, negativePrompt, guidanceScale}` shape'inde bir object döndürür (plus opsiyonel tool-specific alanlar); `design.service.ts` call site'ı bu üç zorunlu değeri de provider'a iletir (R17, R22).
- Bilinmeyen enum değerleriyle çağrıldığında builder hard-fail etmez, generic fallback + warn log üretir (R24).

**User outcome (Phase 0.6 baseline'ına karşı karşılaştırılacak):**
- Regeneration rate (kullanıcının aynı girdilerle re-generate ettiği yüzde) **ölçülebilir ölçüde** düşer. Hedef rakam Phase 0.6 baseline'ı ölçüldükten sonra netleştirilecek; baseline ölçülemiyorsa plan instrumentation ekler ve ship sonrası 2 hafta izlenir.
- Save/share rate (varsa) yaklaşık eşit veya artar. Ship sonrası regression alarmı olarak kullanılır.
- Yapısal sadakat: örnek bir iOS test fotoğrafından üretilen output'lar, orijinal odanın pencere sayısı/yeri, tavan yüksekliği ve kamera açısını gözle görülür biçimde korur (manuel A/B: eski prompt vs yeni prompt, 3–5 oda × 3–5 stil örneği üzerinde).
- Stil ayrımı: aynı oda iki farklı stille render edildiğinde çıktılar belirgin biçimde farklı renk paleti, malzeme ve mood sergiler.
- Özel durumlar çalışır: `christmas` bir Christmas dekor katmanı eklerken altta yatan stili bozmaz; `airbnb` nötr-sıcak bir rental estetiği üretir; `stairway + minimalist` prompt'u "replace furniture" içermez; `bathroom + luxury` prompt'u fixture/vanity/tile dilinde çalışır.
- Geriye uyumluluk: iOS wizard akışı tek satır değişmeden çalışmaya devam eder; POST /interior request body aynı kalır.
- Extensibility demo'su: yeni bir tool (ör. `exteriorDesign`) eklemek için yalnızca (a) `tools/exteriorDesign.ts` yazmak, (b) `TOOL_TYPES`'a bir satır eklemek ve gerekirse (c) yeni bir dictionary eklemek gerekir; primitives ve shared dict'lere hiç dokunulmaz.

## Scope Boundaries

- iOS wizard akışına yeni adım/parametre eklenmeyecek (mood, intensity, preserveItems hint vs. bu sprint'te yok).
- POST /interior request body değişmeyecek (`imageUrl`, `roomType`, `designStyle` sabit kalır).
- Diğer 8 tool (ExteriorDesign, VirtualStaging, GardenDesign, PaintWalls, FloorRestyle, CleanOrganize, ExteriorPainting, ReferenceStyle) bu sprint'te implement edilmeyecek; sadece mimari onları mekanik olarak kabul edebilir hale getirilecek.
- Çoklu output + LLM-as-judge seçimi, generation sırasında LLM ile dinamik prompt expansion, prompt A/B test altyapısı bu sprint'te yok.
- Localization / çok dilli prompt yok. Tüm prompt'lar İngilizce (model girdisi olarak).
- Generation history (`GET /history`) payload'ı değişmeyecek; prompt metni Firestore'a `prompt` alanında zaten yazılıyor ve yeni prompt'lar otomatik bu akışa girecek.

## Key Decisions

- **Positioning (identity bet): curated reliability over creative variance.** HomeDecorAI, "AI beni şaşırtsın" ürünü değil, "AI seçtiğim stili sadık ve tahmin edilebilir şekilde uygulasın" ürünü olarak konumlanır. 18 curated stil, per-style descriptor dict, sabit negative prompt listesi ve bant-bazlı guidance scale hep bu bete hizmet eder. Ters trade-off: unexpected/delightful interpretations'tan feragat edilir. Bu karar post-launch user-outcome metriklerle (regen rate, save rate) geri test edilmelidir; yanlış bet ise stil count'u ve dict size'ı kısılıp multi-output + pick UX'e yönelim değerlendirilir.
- **Baseline-first ilerleme.** R1–R18'i doğrudan implement etmeden önce Phase 0 çalışmaları yapılacak (P0.1–P0.6). Bu, reviewer'lar tarafından yükseltilen "premise kanıtlanmamış" concern'üne doğrudan yanıttır; ucuz fix (P0.2) baseline'ı çözüyorsa full rewrite'ın marjinal kazancı sorgulanır ve scope daraltılır.
- **Dynamic LLM prompt expansion yerine static curated dictionaries.** 12 × 18 = 216 kombinasyon statik olarak kolayca yönetilebilir; runtime'da bir LLM çağırmak latency + maliyet + unpredictability ekler ve bu ölçekte kazancı yoktur. One-time LLM-assisted dictionary bootstrap (content yazımına yardımcı olması için) kabul edilir; runtime LLM çağrısı kabul edilmez.
- **iOS parametrelerini genişletmek yerine BE içinde zenginleştirme.** Yusuf'un talebi "iOS wizard'ın istediği her şeyi sağla" oldu, yani iOS'un mevcut çıktısını optimize etmek — yeni UX talep etmemek. İleride ek parametre gerekirse ayrı brainstorm edilecek.
- **Per-tool builder contract'ı `{prompt, negativePrompt, guidanceScale}` döndürür.** Bu, provider call path'inin ileride değişmesine gerek bırakmaz; yeni tool eklemek prompt bilgisinden fazlasını istemiyorsa hiç pipeline'a dokunmaz.
- **`Christmas` overlay mode + room whitelist.** Semantik olarak "stil değiştirme" değil "üzerine dekor ekleme" olduğu için `actionMode: "overlay"` ile işaretlenir ve action directive'i özel varyantla üretilir. Whitelist dışı odalarda (bathroom, gamingRoom, stairway vs.) yalnızca minimal festive accent uygulanır — "banyoda Christmas tree" gibi absürt kombinasyonlar önlenir.
- **`Airbnb` target mode — stil değil hedef.** `actionMode: "target"` ile işaretlenir. Kullanıcı short-term rental operatörü olarak düşünebilir; "generic rental-ready, neutralized" semantiği bu kitle için somut bir ihtiyaçtır. Homeowner'lar için "modern hotel look" olarak okunabilir, her iki intent de target semantiğiyle uyumlu.
- **`actionMode` field'ı ile special-case'ler architecture içine absorb edilir.** christmas ve airbnb hardcoded if/else dalları değil, her biri dict entry'sinde `actionMode` değeriyle flag'lenmiş stiller olarak modellenir. R1 action directive helper'ı `actionMode`'a göre branch'lenir. Gelecek özel stiller (ör. seasonal variants, staging modes) aynı mekanizmayı kullanır — hardcoded if/else birikmez.
- **R19–R23 architecture stays with flexible contract.** Reviewer konsensüsü "premature abstraction" riskini vurguladı; yine de tercih extensibility mimarisini bu sprint'te kurmak yönünde. Riski azaltmak için R22 contract'ı kırılabilir kapalı shape yerine zorunlu 3 alan + opsiyonel tool-specific alanlar formunda tanımlandı (VirtualStaging reference image, Garden season hint vs. ileride eklenebilir).
- **iOS wizard dokunulmaz bu sprint'te.** Reviewer'lar "tek opsiyonel kontrol eklemek dict'in işinin yarısını çözer" önerisini yükseltti; tercih iOS-sabit kalmak yönünde. Bu, dict'in daha çok sorumluluk almasını gerektirir (actionMode field'ı bu tercihi destekler). Karar post-launch yeniden değerlendirilebilir.
- **Bu brainstorm teknik/mimari bir karar içeriyor**, bu yüzden prompt anatomisi + modül yapısı bu doküman içindedir. Bunu planlamaya ertelemek, planlamanın ürün kararı icat etmesini gerektirirdi.

## Dependencies / Assumptions

- **Flux 2 / Flux Edit modellerinin uzun descriptive prompt'u iyi tolere ettiği varsayılıyor.** Her iki model de 300+ token prompt'larla iyi performans gösterir; yine de planlama sırasında prompt uzunluk sınırları doğrulanmalı.
- **Her iki provider'ın da `negative_prompt` alanını desteklediği varsayılıyor.** Replicate tarafında `prunaai/p-image-edit` ve fal.ai tarafında `fal-ai/flux-2/klein/9b/edit` için bu parametre gerçek girdi şemasında doğrulanmalı (Deferred to Planning).
- **`guidance_scale` parametresi**, `replicate.ts:22` ve `falai.ts:21` içinde zaten `input.guidanceScale !== undefined` kontrolüyle conditional olarak iletiliyor; yani provider call path'i hazır, `buildPrompt`'un dönmesi yeterli.
- `TOOL_TYPES` kaydı `src/lib/tool-types.ts:11` içinde şu an sadece `interiorDesign` tanımlı; mimari değişiklik bu dosyanın içeriğini, `ToolTypeConfig` interface'ini (line 3) ve tek callsite'ı (`design.service.ts:63`) etkiler.
- **Negative prompt ise guidance_scale gibi hazır değildir**: `replicate.ts` ve `falai.ts` dosyalarından hiçbiri bugün `negative_prompt` (veya benzer bir alan) iletmiyor. R16 iki provider dosyasına yeni `if (input.negativePrompt !== undefined)` blokları eklenmesini gerektirir. Alan adlarının doğrulanması "Resolve Before Planning" altında listelenmiştir.

## Outstanding Questions

### Resolve Before Planning

- [Affects R1–R7][Needs research] **Flux token budget doğrulaması.** 7 katmanlı kompozisyon tahmini ~200–300 token'a ulaşır. Replicate `prunaai/p-image-edit` ve fal.ai `fal-ai/flux-2/klein/9b/edit` modellerinin prompt token limitleri (T5 256 mı, 512 mi, farklı mı?) ve truncation davranışı (sessiz mi, hata mı) doğrulanmadan R1–R7 implement edilirse son katmanların (R6 lighting, R7 negative) sessizce kırpılma riski vardır. Implementation öncesi her iki model için token limit ölçülmeli ve R1–R7 kompozisyonunun her {stil × oda} kombinasyonu için bu limit altında kaldığı bir token budget kontrolü tanımlanmalı.
- [Affects R16][Needs research] **Negative prompt provider şema doğrulaması.** Replicate `prunaai/p-image-edit` ve fal.ai `fal-ai/flux-2/klein/9b/edit` input şemalarında negative prompt alanı (a) `negative_prompt` adıyla mı, (b) farklı bir adla mı, (c) hiç yok mu? Test: iki provider'a bilinen yanlış bir alan adıyla çağrı gönderip hata/silent-drop davranışını gözlemle. Alan adları doğrulanana kadar R16 implement edilmeye başlanmamalı; alan yoksa fallback (R16'da belirtilen inline "avoid:" cümlesi) implement edilmeli.

### Deferred to Planning

- [Affects R17][Technical] Band → numeric guidance_scale eşlemesi her iki provider için ayrı ayrı belirlenmelidir (prunaai fork ve flux-2 klein guidance_scale aralıkları farklı olabilir). Planlama sırasında her band için provider-specific numeric değer tablosu hazırlanır. Falsification testi: "faithful" band ile normal bir fotoğrafa en sadık stil uygulandığında output input'a neredeyse aynı olmamalıdır.
- [Affects R2][Needs research] Stil sözlüğü içerikleri (renk paleti, malzemeler, signature items) için kaynak: mevcut iOS `style_*` thumbnail'ları + kısa araştırma ile mi kurulur, yoksa one-time bir LLM yardımlı content bootstrap + Yusuf manuel review ile mi? Planlama sırasında karar verilebilir; sonuç yine statik dosyada yazılı olacak. R25 editorial validation gerekliliği her iki yolu da bağlar.
- [Affects R4, R5][Technical] Primitive'lerin "subject parameter" (interior / exterior / garden) ile nasıl parametrelendirileceği — string interpolation mı, küçük bir helper fonksiyon mu? Planlama implement detayı.
- [Affects R7, R16][Design] Negative prompt derivation kuralı: tüm 216 kombinasyon için identical static list mi, yoksa stil/oda-specific ek negatif token'lar (ör. christmas için "no summer decor") ile augmented mi? İlk versiyon için static base list + opsiyonel per-style append sufficient görülebilir; karar planlama sırasında verilir.
- [Affects R19][Technical] Dosya isimlendirme: `prompts/` alt klasör mü yoksa mevcut `lib/prompts.ts` dosyası `lib/prompts/index.ts`'e mi dönüşür? Drizzle/Fastify kurulumuyla çakışma yok, sadece tercih.
- [Affects R26][Technical] Firestore `prompt` field'ının bugün indexed olup olmadığı + ileride indexlenme ihtimali planlama sırasında doğrulanacak. Indexlenecekse `promptSummary` separate field olarak eklenir.

## Next Steps

1. **Phase 0 (blocking)**: P0.1–P0.6 çalışmalarını yürüt. Özellikle P0.1 (baseline), P0.2 (ucuz fix denemesi), P0.3 (Flux token budget) ve P0.4 (negative prompt schema). Phase 0 sonuçları bu dokümanın sonuna özet olarak eklenir.
2. **Re-review (opsiyonel)**: Phase 0 bulguları R1–R7 scope'unu önemli ölçüde değiştirirse `/ce:brainstorm` ile doküman güncellenir ve re-review edilir.
3. **Planning**: `/ce:plan` ile R1–R26 için structured implementation plan oluşturulur. Planlama, Phase 0 sonuçlarını, Deferred to Planning sorularını ve Key Decisions'ı referans alır.
