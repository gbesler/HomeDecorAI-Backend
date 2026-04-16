---
date: 2026-04-16
topic: prompt-tightening-structural-preservation
---

# Prompt Tightening for Structural Preservation

## Problem Frame

HomeDecorAI'nin tool'larında kalite sorunları var:

1. **Interior Design Tool:** Oda yapısını (duvar pozisyonları, pencere sayısı, kamera açısı) korumuyor — stil değişikliği yaparken odanın geometrisi de değişiyor.

2. **Exterior Design Tool:** Hiç değişiklik yapmıyor veya çok minimal değişiklik yapıyor — koruma direktifleri o kadar ağır ki model değişiklik yapmaktan kaçınıyor.

**Örnek:**
- Input: Gri bir salon fotoğrafı
- Beklenen: Aynı oda yapısı, farklı mobilya/dekor stili
- Gerçek: Oda açısı değişiyor, pencere sayısı/pozisyonu farklı

## Tüm Tool'ların Detaylı Analizi

### 11 Tool İncelemesi

| Tool | Action Directive | Sorunlu Pattern | Severity |
|------|-----------------|-----------------|----------|
| **interior-design** | `Convert this {room} to a {style} interior, replacing the furniture...` | ❌ "Convert" + "replacing" = tam değişiklik sinyali | **HIGH** |
| **exterior-design** | `Do not change the building geometry, openings, or massing` | ❌ Negatif direktif Flux'ta çalışmıyor | **HIGH** |
| **virtual-staging** | `Do not remove or replace existing furniture — only add items...` | ❌ Negatif direktif | **MEDIUM** |
| **garden-design** | `Reimagine this garden as a {style} landscape, restyling...` | ⚠️ "Reimagine" + "restyling" agresif | **MEDIUM** |
| **patio-design** | `Restyle this patio as a {style}, keeping the existing layout...` | ✅ İyi pattern: "Restyle...keeping" | **LOW** |
| **pool-design** | `Restyle this pool as a {style}, keeping the existing pool footprint...` | ✅ İyi pattern | **LOW** |
| **outdoor-lighting** | `Relight this outdoor scene as a {style}, keeping the existing layout...` | ✅ İyi pattern | **LOW** |
| **reference-style** | `Restyle image 1 to match the aesthetic of image 2...` | ✅ İyi pattern | **LOW** |
| **paint-walls** | `Restyle the wall surfaces...Keep every other element identical` | ✅ İyi pattern | **LOW** |
| **floor-restyle** | `Restyle the flooring...Keep every other element identical` | ✅ İyi pattern | **LOW** |
| **_surface-restyle-base** | Shared helper — uses positive preservation | ✅ İyi pattern | **LOW** |

### Sorunlu Pattern'ler Detayı

#### 1. Interior Design (HIGH SEVERITY)

```typescript
// interior-design.ts:107-109
const actionDirective =
  `Convert this ${humanRoom} to a ${style.coreAesthetic} ${styleLabelFromKey(roomType, style)} interior, ` +
  `replacing the furniture, decor, and finishes with items that match the ${style.coreAesthetic} aesthetic.`;
```

**Sorunlar:**
- "Convert" fiili tam dönüşüm sinyali veriyor
- "replacing" fiili mevcut öğelerin tamamen değiştirilmesini ima ediyor
- Preservation clause sonda, düşük priority

#### 2. Exterior Design (HIGH SEVERITY)

```typescript
// exterior-design.ts:124-126
const actionDirective = preservationMode
  ? `Repaint and refinish the exterior... Do not change the building geometry, openings, or massing — only restyle...`
  : `Restyle the exterior... replacing cladding, finishes, paint...`;
```

**Sorunlar:**
- "Do not change" negatif direktif — Flux ignore ediyor veya tersine yorumluyor
- preservationMode'da çok kısıtlayıcı, renovationMode'da çok agresif
- "replacing" fiili yine sorunlu

#### 3. Virtual Staging (MEDIUM SEVERITY)

```typescript
// virtual-staging.ts:114-116
const actionDirective = isKeepLayout
  ? `Preserve any existing furniture... Do not remove or replace existing furniture — only add items...`
  : `Stage this empty ${humanRoom}...`;
```

**Sorunlar:**
- "Do not remove or replace" negatif direktif
- keepLayout modunda çok kısıtlayıcı

#### 4. Garden Design (MEDIUM SEVERITY)

```typescript
// garden-design.ts:120-122
const actionDirective = preservationMode
  ? `Refresh the planting and surface treatments...keeping the existing layout, paths, and plot shape intact.`
  : `Reimagine this garden as a ${style.coreAesthetic} landscape, restyling planting, hardscape finishes...`;
```

**Sorunlar:**
- "Reimagine" çok agresif fiil
- "restyling" belirsiz — ne kadar değişiklik?

### İyi Pattern Örnekleri (Referans)

#### Patio/Pool/Outdoor Lighting — Doğru Pattern

```typescript
// patio-design.ts:74
`Restyle this patio as a ${style.coreAesthetic}, keeping the existing layout and structural elements intact.`
```

**Neden iyi:**
- "Restyle" kontrollü fiil
- "keeping...intact" pozitif koruma
- Action + Constraint aynı cümlede

#### Paint-Walls/Floor-Restyle — Doğru Pattern

```typescript
// paint-walls.ts:45-48
focusDirective:
  "Keep every other element in image 1 identical — furniture, flooring, " +
  "ceiling, fixtures, artwork, and decor stay exactly as they are; only the " +
  "wall surfaces receive the new finish."
```

**Neden iyi:**
- "Keep...identical" pozitif koruma
- "only the wall surfaces" explicit boundary
- Negatif kelime yok

## Root Cause Analysis

BFL Flux prompting guide'larından (docs.bfl.ml, mimicpc.com) elde edilen bulgular:

### Sorun 1: Yanlış Fiil Seçimi

Mevcut interior prompt'ta kullanılan fiiller:
- `Convert this room to...` 
- `replacing the furniture...`

BFL dokümantasyonu:
> **"The verb 'transform' without qualifiers often signals to Kontext that a complete change is desired."**

"Convert", "transform", "replace" gibi fiiller modele **tam değişiklik** sinyali veriyor.

### Sorun 2: Negatif Direktifler

Mevcut exterior prompt'ta:
- `Do not change the building geometry, openings, or massing`

BFL dokümantasyonu:
> **"FLUX.2 does not support negative prompts. Focus on describing what you want, not what you don't want."**
> **"Inline 'avoid: ...' syntax is also harmful — the model is not trained to interpret it as negation."**

### Sorun 3: Constraint'lerin Yanlış Konumu

Mevcut yapı:
```
[Action] ... [Style details] ... [Preservation at the end]
```

BFL best practice:
```
[Action] while [Constraint/Preservation] ... [Style details]
```

> **"Word order matters - FLUX.2 pays more attention to what comes first."**

### Sorun 4: Preservation Clause'un Zayıflığı

Mevcut structural preservation:
```
"while preserving the exact wall positions, window count..."
```

BFL önerisi:
```
"while maintaining the exact same position, scale, camera angle, framing, and perspective"
```

Daha spesifik ve "lock" semantiği taşıyan ifadeler gerekiyor.

## Requirements

### Prompt Structure Refactoring (Tüm Tool'lar)

**R1. Action Directive Verb Standardization**
Tüm tool'larda tutarlı fiil kullanımı:
- ✅ "Restyle" — kontrollü değişiklik
- ✅ "Change" — spesifik değişiklik
- ✅ "Add" — ekleme
- ❌ "Convert" — tam dönüşüm sinyali
- ❌ "Transform" — tam dönüşüm sinyali
- ❌ "Reimagine" — çok agresif
- ❌ "Replace" — belirsiz kapsam

**R2. Eliminate All Negative Language**
Tüm prompt'lardan şu pattern'ler kaldırılmalı:
- ❌ "Do not change..."
- ❌ "Do not remove..."
- ❌ "Do not replace..."
- ❌ "avoid..."
- ❌ "without..."

Her biri pozitif karşılığıyla değiştirilmeli:
- ✅ "while keeping...intact"
- ✅ "while maintaining..."
- ✅ "Keep...identical"
- ✅ "Only change..."

**R3. Action + Constraint Pattern**
Her action directive şu pattern'i izlemeli:
```
[Action verb] [what to change] while [preservation clause]. [Explicit boundary].
```

Örnek:
```
Restyle the furniture and decor in this living room to a modern aesthetic 
while keeping the exact same room layout, camera angle, and perspective. 
Only change the furniture, decor, and finishes.
```

**R4. Explicit "Only Change" Boundary**
Her tool için neyin değişeceği explicit olmalı:
- Interior: "Only change the furniture, decor, and finishes"
- Exterior: "Only change the paint colors, cladding finishes, and trim details"
- Virtual Staging: "Only add complementary furniture pieces"
- Garden: "Only change the planting and surface treatments"

### Tool-Specific Fixes

**R5. Interior Design Prompt Rewrite (HIGH PRIORITY)**

Mevcut:
```
Convert this living room to a modern interior, replacing the furniture, decor, 
and finishes with items that match the modern aesthetic.
```

Yeni:
```
Restyle the furniture and decor in this living room to a modern aesthetic 
while keeping the exact same room layout, camera angle, and perspective. 
Only change the furniture, decor, and finishes.
```

**R6. Exterior Design Prompt Rewrite (HIGH PRIORITY)**

Mevcut (structuralPreservation):
```
Repaint and refinish the exterior of this house in a modern palette. 
Do not change the building geometry, openings, or massing — only restyle 
surface treatments, paint colors, cladding finishes, and trim details.
```

Yeni:
```
Change the paint and surface finishes of this house to a modern palette 
while keeping the exact same building shape, roof line, window positions, 
door placements, and camera angle. Only restyle the surface treatments.
```

Mevcut (renovationDesign):
```
Restyle the exterior of this house as a modern building, replacing cladding, 
finishes, paint, and surface treatments to match the modern aesthetic.
```

Yeni:
```
Restyle the exterior finishes of this house to a modern aesthetic 
while keeping the exact same building shape and camera angle. 
Change the cladding, paint colors, and surface treatments.
```

**R7. Virtual Staging Prompt Fix (MEDIUM PRIORITY)**

Mevcut (keepLayout):
```
Preserve any existing furniture in this living room and add complementary modern 
pieces to complete the staging. Do not remove or replace existing furniture — 
only add items that complement the current layout.
```

Yeni:
```
Add complementary modern furniture pieces to this living room 
while keeping all existing furniture exactly as it is. 
Only add items that harmonize with the current layout.
```

**R8. Garden Design Prompt Fix (MEDIUM PRIORITY)**

Mevcut (fullRedesign):
```
Reimagine this garden as a modern landscape, restyling planting, 
hardscape finishes, and signature features to match the aesthetic.
```

Yeni:
```
Restyle this garden to a modern landscape aesthetic 
while keeping the existing plot boundaries and camera angle. 
Change the planting, hardscape finishes, and signature features.
```

### Primitive Updates

**R9. Structural Preservation Primitive Update**

Mevcut `buildStructuralPreservation("interior")`:
```
"while preserving the exact wall positions, window count, window shapes, 
ceiling height, door placements, floor plan, camera angle, lens perspective, 
and vanishing points. Maintain identical room geometry. 
Do not add or remove walls, windows, or doors."
```

Yeni:
```
"while keeping the room in the exact same layout, camera angle, framing, 
and perspective. Maintain identical wall positions, window count, window 
shapes, ceiling height, and door placements."
```

**R10. Structural Preservation Primitive Update (Exterior)**

Mevcut `buildStructuralPreservation("exterior")`:
```
"while preserving the exact building massing, roof line, window count, 
window placements, door placements, and camera angle. 
Maintain identical structural geometry."
```

Yeni:
```
"while keeping the building in the exact same position, scale, camera angle, 
and perspective. Maintain identical building shape, roof line, window 
positions, and door placements."
```

**R11. Positive Avoidance Stays Intact**
Mevcut `POSITIVE_AVOIDANCE_BASE` zaten pozitif dil kullanıyor — değişiklik gerekmez.

### Word Order Priority

**R12. Constraint Position in Layer Composition**
Structural preservation primitive'in priority'si 3'ten 1.5'e (action+focus ile merge) yükseltilmeli:

Mevcut layer order:
```
1. action+focus
2. style-core
3. structural-preservation  ← Çok geç!
4. positive-avoidance
5. style-detail
6. photography-quality
7. lighting
```

Yeni approach — constraint'i action'a merge et:
```
1. action+focus+preservation  ← Hepsi birlikte!
2. style-core
3. positive-avoidance
4. style-detail
5. photography-quality
6. lighting
```

## Success Criteria

1. **Structural Fidelity Test (Interior):** Aynı input fotoğrafı + farklı stiller ile 10 generation yapıldığında, 10'unun 8'inde:
   - Kamera açısı korunuyor
   - Pencere sayısı/pozisyonu aynı
   - Duvar pozisyonları aynı
   - Oda geometrisi tanınabilir şekilde aynı

2. **Style Application Test (Exterior):** Exterior tool ile 5 farklı stil denendiğinde, 5'inin 4'ünde:
   - Görünür stil değişikliği var (renk, finish)
   - Bina geometrisi korunmuş

3. **Virtual Staging Test (keepLayout):** Mevcut mobilyalı bir oda ile test edildiğinde:
   - Mevcut mobilyalar yerinde
   - Yeni mobilyalar eklenmiş
   - Oda geometrisi korunmuş

4. **Garden Test (fullRedesign):** Bahçe fotoğrafı ile test edildiğinde:
   - Stil değişikliği görünür
   - Plot sınırları korunmuş
   - Kamera açısı aynı

5. **Regression Test:** Mevcut kabul edilebilir output'lar (patio, pool, lighting, paint-walls, floor-restyle) bozulmamış.

## Scope Boundaries

- Model değişikliği YOK — sadece prompt optimizasyonu
- iOS API contract değişikliği YOK
- Yeni tool eklenmesi YOK
- Token budget aşılmayacak (max 280 Pruna, 350 fal Klein)
- Dictionary içerikleri değişmeyecek

## Key Decisions

- **Prompt-first approach:** Model değiştirmeden önce prompt optimizasyonu deneniyor. Bu, en düşük maliyetli ve en hızlı çözüm.
- **BFL official guide'a tam uyum:** Tüm değişiklikler docs.bfl.ml/guides/prompting_guide_kontext_i2i ve prompting_guide_flux2 referans alınarak yapılıyor.
- **Verb selection is critical:** "Convert/transform/reimagine" yerine "restyle/change" kullanımı.
- **Negative language elimination:** Flux modelleri negatif direktifleri anlamıyor — tümü pozitif karşılıklarla değiştirilecek.
- **Good patterns exist:** patio, pool, outdoor-lighting, paint-walls, floor-restyle tool'ları zaten doğru pattern kullanıyor — bunlar referans olarak kullanılacak.

## Dependencies / Assumptions

- Pruna p-image-edit ve fal Klein 9B Edit modelleri Flux tabanlı ve BFL prompting guide'ları uygulanabilir
- Token budget'lar yeterli (interior ~200 token, exterior ~220 token hedef)
- Mevcut dictionary içerikleri (styles, rooms, buildings) değişmeyecek
- İyi çalışan tool'lar (patio, pool, etc.) referans olarak kullanılabilir

## Outstanding Questions

### Resolve Before Planning

- [Affects R5-R8][Needs validation] Yeni prompt yapısı ile 5-10 test generation yapılmalı ve baseline ile karşılaştırılmalı. Bu, planning öncesi yapılması gereken bir validation step. Test edilecek tool'lar: interior-design, exterior-design.

### Deferred to Planning

- [Affects R9-R10][Technical] Structural preservation primitive'in interior/exterior branch'leri ayrı fonksiyonlara mı bölünmeli yoksa mevcut switch yapısı mı korunmalı?
- [Affects R12][Technical] Layer composition'da constraint merge stratejisi — action directive'e inline mi yoksa ayrı layer olarak mı kalmalı?
- [Affects all][Technical] Token count validation — her yeni prompt versiyonu için token sayısı ölçülmeli.

## Affected Files Summary

| File | Priority | Changes |
|------|----------|---------|
| `interior-design.ts` | HIGH | R5: Action directive rewrite |
| `exterior-design.ts` | HIGH | R6: Action directive rewrite (both modes) |
| `virtual-staging.ts` | MEDIUM | R7: Remove negative language |
| `garden-design.ts` | MEDIUM | R8: "Reimagine" → "Restyle" |
| `structural-preservation.ts` | MEDIUM | R9-R10: Remove "Do not" clauses |
| `patio-design.ts` | LOW | No changes (reference pattern) |
| `pool-design.ts` | LOW | No changes (reference pattern) |
| `outdoor-lighting-design.ts` | LOW | No changes (reference pattern) |
| `paint-walls.ts` | LOW | No changes (reference pattern) |
| `floor-restyle.ts` | LOW | No changes (reference pattern) |
| `reference-style.ts` | LOW | No changes (reference pattern) |

## Next Steps

→ `/ce:plan` for structured implementation planning

Önce R5-R6'nın manuel test edilmesi önerilir:
1. Mevcut prompt ile 5 generation (interior + exterior)
2. Yeni prompt yapısı ile 5 generation (aynı input)
3. Structural fidelity karşılaştırması

Eğer prompt tightening yeterli değilse:
- Model değişikliği araştırılacak (Flux Kontext Pro, Flux 2 Pro gibi daha kontrollü modeller)
- Guidance scale desteği olan modellere geçiş değerlendirilecek
