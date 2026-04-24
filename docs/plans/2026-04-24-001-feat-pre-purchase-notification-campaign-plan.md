---
title: 14-Day Pre-Purchase Notification Campaign
type: feat
status: active
date: 2026-04-24
---

# 14-Day Pre-Purchase Notification Campaign

## Overview

Satın alma (premium) yapılmadığı sürece, kullanıcıya indirme gününden itibaren 14 gün boyunca önceden tanımlı içerik + saatlerde push bildirim gönderen bir kampanya sistemi kurulur. Backend Cloud Tasks ile her kullanıcı için 13 adet bildirimi install anında zamanlar. Bildirimler premium olan kullanıcılara gönderilmez. Bildirim içerikleri uygulamadaki gerçek tool'lara (iç mekan, banyo, mutfak, bahçe, virtual staging "Oda Doldur", replace-object "Kanepeni Değiştir", reference style, gallery) deep-link'ler.

## Problem Frame

Uygulama şu anda sadece event-driven FCM push gönderiyor (generation completed/failed). Yeni kullanıcının ilk haftalarda ürünün tool'larını keşfetmesini ve satın almaya dönüşmesini sağlayacak bir retention/aktivasyon kampanyası yok. Kullanıcı tarafından hazırlanmış detaylı 14 günlük template (Türkçe, tool-spesifik, 2 adet ödeme bildirimi dahil) bu boşluğu dolduracak. Hedef: premium olmayan kullanıcıların push üzerinden doğru tool'a yönlendirilip dönüşüm oranının artması.

## Requirements Trace

- R1. Kullanıcı app'i ilk açtığında (veya FCM token'ı ilk kaydolduğunda) 14 günlük kampanya zamanlanır.
- R2. Her bildirim, uygulama local-time'ına göre belirtilen saatte ulaşır (TR kullanıcı çoğunluk — backend user'ın timezone alanına göre hesaplar, yoksa `Europe/Istanbul` varsayar).
- R3. Premium'a geçen kullanıcıya kalan bildirimler gönderilmez (kampanya iptal edilir).
- R4. Kullanıcı iOS Ayarlar'dan bildirimleri kapatırsa veya FCM token silinirse dispatch sessizce atlanır.
- R5. Bildirim title/body metinleri TR ve EN için ayrı, tool-adı ve stil adları ile tutarlı (mevcut `Localizable.xcstrings` kullanımıyla uyumlu).
- R6. Bildirime tıklama kullanıcıyı hedef tool'un wizard giriş ekranına (veya paywall / gallery'ye) yönlendirir.
- R7. 13 aktif bildirim + 1 sessiz gün (Gün 7 — 5 Nisan Pazar). Gün 5 = paywall deneme CTA, Gün 13 = %50 indirim CTA.
- R8. Kampanya idempotenttir: aynı kullanıcı için iki kere zamanlanmaz; retry'larda çift gönderim olmaz.

## Scope Boundaries

- **In:** Zamanlanmış push bildirim gönderimi, premium gate, deep-link routing, TR/EN metinler.
- **Out:**
  - In-app message / banner (sadece push).
  - A/B test farklı template setleri (tek varyant ile başlıyoruz).
  - Bildirim açılma / dönüşüm analytics pipeline'ı (mevcut analytics eventlerine hook ile opsiyonel not eklenebilir, ayrı plan).
  - Kullanıcının zaman dilimine göre akıllı saat ayarlama (sadece fixed offset + saat, basit çözüm).
  - Android desteği (proje iOS-only).

## Context & Research

### Relevant Code and Patterns

- `HomeDecorAI-Backend/src/lib/cloud-tasks.ts` — Cloud Tasks enqueue helper; `scheduleTime` ile ileri tarihli task atılabilir. Mevcut `enqueueGenerationTask` deseni örnek alınacak (OIDC audience + dispatchDeadline).
- `HomeDecorAI-Backend/src/lib/notifications/fcm.ts` — `sendEachForMulticast` ile multicast push, invalid token auto-prune. Mevcut `sendGenerationNotification` fonksiyonu generalize edilecek (title/body/data parametreli bir `sendCampaignNotification` ekle).
- `HomeDecorAI-Backend/src/lib/notifications/token-store.ts` — `users/{uid}.fcmTokens` okuma/yazma; aynı pattern'i reuse.
- `HomeDecorAI-Backend/src/lib/notifications/i18n.ts` — şu an `completed/failed` iki kind var; yeni `campaign` dispatch'te per-template TR/EN metin map'i eklenecek.
- `HomeDecorAI-Backend/src/controllers/users.controller.ts` — `POST /api/users/me/fcm-token` mevcut. Campaign scheduling tetikleyicisi: bu endpoint'te ilk başarılı token kayıt anında `schedulePreLaunchCampaign(uid)` çağrılacak (idempotent).
- `HomeDecorAI-Backend/src/services/generation-processor.ts` — Cloud Tasks receiver örneği; yeni `/internal/notifications/campaign-fire` receiver'ı aynı OIDC doğrulama deseniyle eklenecek.
- `HomeDecorAI/HomeDecorAI/App/AppDelegate.swift` — deep-link handler (`handleDeepLink`, `handleNotificationUserInfo`). Şu an sadece `generation/<id>` route ediliyor; tool ve paywall route'ları eklenecek.
- `HomeDecorAI/HomeDecorAI/Core/Paywall/PremiumStateManager.swift` — `isPremium` state; değişimi backend'e bildirmek için yeni `POST /api/users/me/premium-state` endpoint'i veya mevcut user sync akışına alan eklenecek.
- `HomeDecorAI/HomeDecorAI/Features/Wizard/Models/HomeTool.swift` — tool kimlikleri (interior/bathroom+roomType/kitchen+roomType/garden/virtualStaging/replaceAddObject/referenceStyle). Deep-link `toolId`'leri bu enum'ın raw string'leri ile eşleşecek.
- `HomeDecorAI/HomeDecorAI/Resources/Localizable.xcstrings` — TR/EN tool adları, stil adları mevcut; campaign-specific stringler buraya yeni key'lerle eklenmeyecek (metin backend'de tutulacak) ama tool isimlendirmesi referans alınacak.

### Institutional Learnings

- Backend FCM gönderiminde premium gate yok şu an; sadece `FCM_ENABLED` kill-switch var. Campaign dispatch'ine per-user premium check zorunlu.
- Firestore `users/{uid}` auth doc'u token + `createdAt` tutuyor; `isPremium`, `timezone`, `preLaunchCampaign.state` alanları oraya eklenecek.
- Cloud Tasks tombstone sorunu: task-name dedup için `{uid}-campaign-day-{N}` deseni kullanılacak; retry'da isim atlanacak (mevcut retry deseniyle uyumlu).
- Özellik adları TR'de kısa ve uzun varyantlar içeriyor (ör. "Sahneleme" / "Sanal Sahneleme"). Kampanya metinlerinde kullanıcı dostu uzun varyantlar kullanılacak (plan template'i ile hizalı).

### External References

- Firebase Admin SDK (firebase-admin) `admin.messaging()` — mevcut kullanımla devam.
- Google Cloud Tasks `scheduleTime` — ms cinsinden ileri tarih; 30 günlük üst sınır var → 14 gün güvenli.

## Key Technical Decisions

- **Zamanlayıcı: Cloud Tasks `scheduleTime`**, cron/node-cron değil. Her kullanıcı için install-time'da 13 task atılır. Neden: mevcut altyapı, exactly-once benzeri garanti, per-user zamanlama, scale concern yok.
- **Tetikleyici: İlk başarılı FCM token kayıt.** `createdAt` yerine token-register kullanıyoruz çünkü bildirim gönderilemeyecek kullanıcı için kampanya açmak anlamsız; ayrıca onboarding'in bildirim-izin adımı bu noktaya denk gelir.
- **Metinler kodda sabit (static map), Firestore Remote Config değil.** 14 template × 2 dil = 28 metin. Değiştirmek için deploy yeter; ilk versiyonda config overhead'i yok. İleri versiyonda Remote Config override eklenebilir.
- **Premium gate dispatch anında.** Scheduling sırasında iptal etmek yerine, her task fire olduğunda `users/{uid}.isPremium` okunur; true ise task no-op döner. Avantaj: premium iptalinde basit (iptal gerekmez), ek: premium upgrade sonrası task'ı silmek yerine ucuz Firestore read.
- **Timezone: kullanıcı timezone'u yoksa `Europe/Istanbul`** varsayılır. iOS `TimeZone.current.identifier` token register'da birlikte gönderilir. Backend `luxon` veya native `Intl.DateTimeFormat` ile slot saatini absolute UTC'ye çevirir.
- **Deep-link şeması:** `homedecorai://tool/<toolId>?roomType=<rt>` (tool wizard'ı açar), `homedecorai://paywall?offer=trial|half-off` (paywall'u açar), `homedecorai://gallery` (profil tab'ı). Mevcut `homedecorai://generation/<id>` korunur.
- **Sessiz gün (Gün 7): hiç task atılmaz.** 13 task schedule edilir, gün numaraları 1–6, 8–14.
- **Idempotency:** Cloud Tasks task-name `{uid}-precampaign-day-{N}` — ikinci schedule çağrısı ALREADY_EXISTS fırlatır, caller success olarak ele alır (mevcut pattern). `users/{uid}.preLaunchCampaign.scheduledAt` timestamp ikinci savunma hattı.

## Open Questions

### Resolved During Planning

- **Trigger noktası:** İlk `POST /api/users/me/fcm-token` başarısı (createdAt değil).
- **Premium gate yeri:** Dispatch anı (fire-time Firestore read).
- **Metinlerin yeri:** Backend kodunda sabit TR/EN map (`src/lib/notifications/campaign-templates.ts`).
- **Timezone:** Fallback `Europe/Istanbul`; iOS token register payload'ına `timezone` eklenir.
- **iOS premium state sync:** `PremiumStateManager` state değişiminde backend'e PATCH. Yoksa deneme/iptal sinyalleri kaçar.

### Deferred to Implementation

- Cloud Tasks queue isimlendirmesi (`campaign-push` vs mevcut queue'yu reuse). Implementation'da queue adını ve rate limit'i karar ver.
- Backend dispatch'te user language kaynağı: mevcut `users/{uid}.language` (token register'da güncelleniyor mu?) kontrol ederek, yoksa generation `language` field deseniyle token register sırasında stamp edilecek.
- Analytics event eklenecek mi (`campaign_push_sent`, `campaign_push_opened`) — şimdilik deferred; Amplitude yerine mevcut analytics pipeline kontrol edilsin.
- Test-mode kısaltılmış schedule (örn. 14 dakika = 14 gün) için env flag eklensin mi — QA sırasında faydalı.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
[iOS first launch]
    └── user grants notifications
          └── iOS POST /api/users/me/fcm-token { token, timezone, language }
                └── backend: upsert user doc (fcmTokens, timezone, language)
                └── backend: schedulePreLaunchCampaign(uid)
                      ├── read users/{uid}.preLaunchCampaign.scheduledAt — if set, return
                      ├── compute install baseline = now
                      ├── for N in [1,2,3,4,5,6,8,9,10,11,12,13,14]:
                      │     slot = TEMPLATES[N].slot (TZ-local hour/min)
                      │     scheduleTime = install_baseline + day_offset @ slot in user TZ → UTC
                      │     enqueue Cloud Task
                      │         name = {uid}-precampaign-day-{N}
                      │         url  = /internal/notifications/campaign-fire
                      │         body = { uid, day: N }
                      │         scheduleTime
                      └── stamp users/{uid}.preLaunchCampaign = { scheduledAt, version }

[Cloud Tasks fires scheduled task at T]
    └── POST /internal/notifications/campaign-fire (OIDC verified)
          ├── read users/{uid}: isPremium? → 200 no-op + log
          ├── read fcmTokens → empty? → 200 no-op
          ├── pick language (user.language ?? 'tr')
          ├── template = TEMPLATES[day][language]
          ├── sendEachForMulticast(tokens, title, body, data={ deepLink: template.deepLink, campaignDay: N })
          └── prune invalid tokens; stamp users/{uid}.preLaunchCampaign.lastFiredDay

[iOS receives push, user taps]
    └── AppDelegate.handleNotificationUserInfo
          └── handleDeepLink(deepLink)
                ├── "generation/<id>"          → existing route
                ├── "tool/<toolId>?roomType=X" → push new DeepLinkRoute.tool(...)
                ├── "paywall?offer=trial"      → push DeepLinkRoute.paywall(offer)
                └── "gallery"                   → switch tab to Profile
```

**Template table (source of truth — used as directional content, not final copy):**

| Day | TZ-local slot | Deep link | Tip |
|-----|--------------|-----------|-----|
| 1   | 19:30 | `tool/interiorDesign` | Aktivasyon |
| 2   | 19:45 | `tool/interiorDesign?roomType=living_room` | Özellik tanıtımı |
| 3   | 15:30 | `tool/referenceStyle` | Görsel vaat |
| 4   | 19:15 | `tool/interiorDesign?roomType=bathroom` | Alt-özellik |
| 5   | 11:30 | `paywall?offer=trial` | **Ödeme #1** (3 gün trial) |
| 6   | 14:00 | `tool/interiorDesign?roomType=living_room` | Hafta sonu |
| 7   | —     | —                     | DİNLENME (task yok) |
| 8   | 19:30 | `tool/interiorDesign?roomType=kitchen` | Alt-özellik |
| 9   | 19:00 | `tool/gardenDesign`   | Alt-özellik |
| 10  | 15:45 | `tool/virtualStaging` | Yeni özellik |
| 11  | 19:30 | `tool/replaceAddObject` | Problem odaklı |
| 12  | 19:15 | `gallery` | Motivasyon |
| 13  | 19:30 | `paywall?offer=half-off` | **Ödeme #2** (%50 indirim) |
| 14  | 11:00 | `tool/referenceStyle` | İlham |

## Implementation Units

- [ ] **Unit 1: Campaign template registry (backend)**

**Goal:** 14 günlük kampanyanın tüm template verisini (day, slot, deepLink, TR/EN title/body, tip) tek kaynaktan okunur hale getir.

**Requirements:** R5, R7

**Dependencies:** None

**Files:**
- Create: `HomeDecorAI-Backend/src/lib/notifications/campaign-templates.ts`
- Create: `HomeDecorAI-Backend/src/lib/notifications/campaign-templates.test.ts`

**Approach:**
- Export `type CampaignDay = 1|2|3|4|5|6|8|9|10|11|12|13|14` (7 hariç).
- Export `PRE_LAUNCH_TEMPLATES: Record<CampaignDay, { slotHour: number; slotMinute: number; deepLink: string; tr: { title; body }; en: { title; body } }>`.
- Deep-link stringleri `homedecorai://...` formatında tam URL tutulur.
- TR metinleri user plan'dakiyle birebir. EN metinleri çeviri (EN kullanıcı oranı düşük ama TR snapshot'ı için gerekli).

**Patterns to follow:**
- `HomeDecorAI-Backend/src/lib/notifications/i18n.ts` stili — sabit object map + type-safe erişim.

**Test scenarios:**
- Happy path: her 13 gün için `tr.title`, `tr.body`, `deepLink` tanımlı.
- Edge case: `CampaignDay` type'ı 7'yi içermiyor (compile-time check).
- Happy path: `slotHour` 0–23, `slotMinute` 0–59.
- Happy path: `deepLink` tüm template'lerde `homedecorai://` ile başlıyor.

**Verification:** Unit test yeşil.

---

- [ ] **Unit 2: User doc schema + premium/timezone sync**

**Goal:** `users/{uid}` doc'una `isPremium`, `timezone`, `language`, `preLaunchCampaign` alanlarını ekle; iOS premium state değişimlerini backend'e bildiren endpoint'i aç.

**Requirements:** R3, R2

**Dependencies:** None

**Files:**
- Modify: `HomeDecorAI-Backend/src/controllers/users.controller.ts` — `POST /api/users/me/fcm-token` request body'sine `timezone?`, `language?` alanlarını kabul et (Zod schema); yeni endpoint `PATCH /api/users/me/premium-state` ekle (`{ isPremium: boolean, productId?: string, expiresAt?: number }`).
- Modify: `HomeDecorAI-Backend/src/schemas/users.schema.ts` (varsa) veya controller-local schema.
- Modify: `HomeDecorAI-Backend/src/routes/users.routes.ts` (varsa).
- Modify: `HomeDecorAI/HomeDecorAI/Shared/Utilities/NotificationManager.swift` — token register call'una `timezone: TimeZone.current.identifier`, `language: LanguageManager.shared.languageCode` ekle.
- Modify: `HomeDecorAI/HomeDecorAI/Core/Paywall/PremiumStateManager.swift` — entitlement listener'da değişim olduğunda `DesignAPIService.syncPremiumState(isPremium:productId:expiresAt:)` çağır.
- Modify: `HomeDecorAI/HomeDecorAI/Core/Network/DesignAPIService.swift` — yeni `syncPremiumState(...)` metodu (`PATCH /api/users/me/premium-state`).
- Create: `HomeDecorAI-Backend/src/controllers/users.controller.test.ts` ilgili testler (mevcut bir test dosyası varsa extend).

**Approach:**
- Backend validation: Zod. `timezone`: `Intl.supportedValuesOf('timeZone').includes(...)` veya basit regex (`/^[A-Za-z_]+\/[A-Za-z_]+$/`).
- Firestore write: partial update, `fcmTokensUpdatedAt` deseniyle.
- iOS premium-sync idempotent: aynı durumu iki kere gönderse backend aynı değeri yazar; problem yok.

**Patterns to follow:**
- Mevcut `users.controller.ts` FCM token endpoint'inin auth/validation/logging yapısı.

**Test scenarios:**
- Happy path: token-register + timezone → Firestore'da alan yazılı.
- Edge case: geçersiz timezone → 400.
- Happy path: premium-state PATCH → Firestore `isPremium=true` yazılı; response 204.
- Error path: auth'suz request → 401.
- Integration: iOS tarafı: premium state değişimi (mock RevenueCat event) → ağ çağrısı tetikleniyor (Swift unit test, URL protocol mock).

**Verification:** Endpoint'ler manuel curl'de çalışıyor; Firestore'da alan güncelleniyor; iOS build başarılı ve entitlement değişimi ağ çağrısı atıyor.

---

- [ ] **Unit 3: Campaign scheduler (Cloud Tasks enqueue)**

**Goal:** Kullanıcı için 13 ileri tarihli push task'ı tek seferlik zamanla.

**Requirements:** R1, R2, R7, R8

**Dependencies:** Unit 1, Unit 2

**Files:**
- Create: `HomeDecorAI-Backend/src/services/pre-launch-campaign.service.ts` (`schedulePreLaunchCampaign(uid)`).
- Modify: `HomeDecorAI-Backend/src/lib/cloud-tasks.ts` — yeni `enqueueCampaignTask({ uid, day, scheduleTime })` fonksiyonu ekle. `enqueueGenerationTask` deseni reuse.
- Modify: `HomeDecorAI-Backend/src/controllers/users.controller.ts` — token-register endpoint success case'inde `schedulePreLaunchCampaign(uid)` çağır (non-fatal; hata logla ama 2xx kır). Background olarak await etme veya `void` bırakma kararı: non-blocking.
- Create: `HomeDecorAI-Backend/src/services/pre-launch-campaign.service.test.ts`.

**Approach:**
- `scheduleTime` hesabı: `install_baseline_utc` + `day_offset_days` gün, sonra user TZ'deki slot saatine yuvarla → UTC'ye çevir. Native `Intl.DateTimeFormat` veya `luxon` — kodbase hangi dependency'ye sahipse onu kullan (package.json kontrol).
- Task name: `precampaign-{uid}-day-{N}` — ALREADY_EXISTS yakala, success say.
- Firestore'da `users/{uid}.preLaunchCampaign = { scheduledAt: serverTimestamp(), version: 1, days: [1,2,...,14] }` stamp (idempotency guard — zaten set ise erken return).
- OIDC audience + queue path `cloud-tasks.ts` mevcut deseniyle.
- Queue: implementation'da mevcut queue'yu reuse ederse rate limit riski var → ayrı bir queue (`campaign-push`) önerilir; kararı implementer versin.

**Execution note:** Scheduling fonksiyonuna integration testi öncelikli — Cloud Tasks client'ı mock'layarak doğru scheduleTime + task name üretiliyor mu doğrula.

**Patterns to follow:**
- `HomeDecorAI-Backend/src/lib/cloud-tasks.ts` `enqueueGenerationTask` — OIDC, dispatchDeadline, ALREADY_EXISTS handling.

**Test scenarios:**
- Happy path: ilk çağrı 13 task enqueue eder, Firestore stamp'ler.
- Edge case: ikinci çağrı (aynı uid) → 0 task, no-op.
- Edge case: Gün 7 için task enqueue edilmez (assert count=13, days=[1..6,8..14]).
- Edge case: user timezone `America/Los_Angeles` → her task `scheduleTime` LA slot saatine denk gelen UTC.
- Edge case: user timezone yok → `Europe/Istanbul` fallback.
- Error path: Cloud Tasks ALREADY_EXISTS → exception fırlatılmaz, success sayılır.
- Integration: gerçek Firestore emulator'de stamp + idempotency.

**Verification:** Unit test yeşil; local emulator'de token-register + scheduler çalışınca Cloud Tasks dashboard'da 13 task görünür.

---

- [ ] **Unit 4: Campaign fire receiver + dispatch**

**Goal:** Cloud Tasks zamanlanmış saatte receiver'ı çağırınca, premium/token kontrolü + FCM gönderim yap.

**Requirements:** R3, R4, R5

**Dependencies:** Unit 1, Unit 2, Unit 3

**Files:**
- Create: `HomeDecorAI-Backend/src/controllers/campaign.controller.ts` (`POST /internal/notifications/campaign-fire`).
- Modify: `HomeDecorAI-Backend/src/routes/*` — register route with internal OIDC guard.
- Modify: `HomeDecorAI-Backend/src/lib/notifications/fcm.ts` — `sendCampaignNotification({ uid, day, language })` helper ekle (generalize `sendGenerationNotification` veya onun yanına).
- Create: `HomeDecorAI-Backend/src/controllers/campaign.controller.test.ts`.

**Approach:**
- OIDC middleware: mevcut internal task audience doğrulaması reuse (bkz. generation-processor).
- Akış:
  1. `users/{uid}` oku → `isPremium=true` ise 200 `{ skipped: 'premium' }`.
  2. `getFcmTokens(uid)` → boşsa 200 `{ skipped: 'no-tokens' }`.
  3. language: `user.language ?? 'tr'`.
  4. template: `PRE_LAUNCH_TEMPLATES[day][language]`.
  5. `sendEachForMulticast` — mevcut invalid-token prune reuse.
  6. `users/{uid}.preLaunchCampaign.lastFiredDay = day` stamp.
- FCM data payload: `{ campaignDay: String(day), deepLink: template.deepLink, kind: 'campaign' }`.
- Apple APNs: `sound: default`, `mutable-content: 1` (mevcut pattern).
- `FCM_ENABLED` kill-switch respect.

**Patterns to follow:**
- `HomeDecorAI-Backend/src/services/generation-processor.ts` — OIDC receiver + best-effort notify.
- `HomeDecorAI-Backend/src/lib/notifications/fcm.ts` — multicast + prune.

**Test scenarios:**
- Happy path: tokens + non-premium → FCM çağrısı doğru payload ile, `lastFiredDay` stamp'lendi.
- Edge case: premium=true → FCM çağrısı yok, log entry var.
- Edge case: tokens boş → FCM çağrısı yok.
- Edge case: language='en' → English template kullanılır.
- Edge case: invalid day (örn. 7 veya 99) → 400 (Zod).
- Error path: FCM returns unregistered-token → token prune edilir, response yine 200.
- Error path: OIDC doğrulanmadı → 401/403.
- Integration: end-to-end local test — scheduler'ı 60s ileriye ayarla, task fire olduğunda gerçek Firebase project'e push düşsün (sandbox).

**Verification:** Test cihazında push baloncuğu doğru TR başlık/body ile görünür; deep link kullanıcıyı doğru tool'a götürür.

---

- [ ] **Unit 5: iOS deep-link router genişletmesi**

**Goal:** Push notification tap'i tool, paywall ve gallery deep-link'lerini doğru ekrana yönlendirsin.

**Requirements:** R6

**Dependencies:** None (backend'den bağımsız test edilebilir)

**Files:**
- Modify: `HomeDecorAI/HomeDecorAI/App/AppDelegate.swift` — `handleDeepLink(_:)` ve `handleNotificationUserInfo(_:)` — şu anki sadece `generation/<id>` parsing'i, yeni `DeepLinkRoute` enum'a generalize.
- Create: `HomeDecorAI/HomeDecorAI/App/DeepLinkRoute.swift` — `enum DeepLinkRoute { case generation(String); case tool(HomeTool, roomType: RoomType?); case paywall(offer: String?); case gallery }` + `init?(url: URL)`.
- Modify: root view / scene router — yeni `Notification.Name.openToolRequested`, `openPaywallRequested`, `openGalleryRequested` observer'ları ekle; ilgili navigation handler'ları ile bağla (mevcut generation observer'ı modele al).
- Create: `HomeDecorAITests/DeepLinkRouteTests.swift`.

**Approach:**
- URL parsing: host = "generation"/"tool"/"paywall"/"gallery"; path/query parametreleri enum'a map'le.
- `HomeTool` raw value ile `toolId` parametresini eşle (`interiorDesign`, `gardenDesign`, `virtualStaging`, `replaceAddObject`, `referenceStyle`).
- `roomType` query (`?roomType=bathroom|kitchen|living_room`) → `RoomType` enum'a map'le; yoksa nil.
- Paywall offer param: `trial` → 3 gün free trial variantı öne çıkar; `half-off` → SpecialOffer flag'iyle uyumlu 50% variant.

**Patterns to follow:**
- Mevcut `AppDelegate.handleDeepLink` + `NotificationCenter.default.post(name: .openGenerationRequested, ...)` deseni.

**Test scenarios:**
- Happy path: `homedecorai://tool/interiorDesign?roomType=bathroom` → `.tool(.interiorDesign, roomType: .bathroom)`.
- Happy path: `homedecorai://paywall?offer=trial` → `.paywall(offer: "trial")`.
- Happy path: `homedecorai://gallery` → `.gallery`.
- Happy path: `homedecorai://generation/abc123` → mevcut davranış korunur.
- Edge case: bilinmeyen tool `homedecorai://tool/foo` → `nil` (route edilmez, log).
- Edge case: `roomType` geçersiz → `.tool(... roomType: nil)` (tool açılır, default room).
- Happy path (UI): push tap simülasyonu tool ekranına navigate ediyor (manual test + UI test opsiyonel).

**Verification:** Unit test yeşil; fiziksel cihazda simüle edilmiş push (Xcode scheme APNS payload file) tap edildiğinde doğru ekran açılıyor.

---

- [ ] **Unit 6: Premium-cancel-guard & manual QA tooling**

**Goal:** (a) Kullanıcı premium'a geçtikten sonra herhangi bir fire'da atlanmasını garantiye al, (b) QA için kısa-süre (N dakika = N gün) test modu ekle.

**Requirements:** R3, test edilebilirlik

**Dependencies:** Unit 3, Unit 4

**Files:**
- Modify: `HomeDecorAI-Backend/src/services/pre-launch-campaign.service.ts` — `CAMPAIGN_TEST_MODE_MINUTES` env flag (default unset). Set edildiğinde gün offset yerine dakika offset kullan.
- Modify: `HomeDecorAI-Backend/src/controllers/campaign.controller.ts` — (zaten premium gate Unit 4'te; bu unit test/assert + dokümante).
- Modify: `HomeDecorAI-Backend/src/lib/env.ts` — yeni env değişkeni tanımı.
- Modify: `HomeDecorAI-Backend/docs/runbooks/` — yeni runbook: `pre-launch-campaign.md` (nasıl enable/disable edilir, nasıl QA yapılır, premium user nasıl test edilir).

**Approach:**
- Test mode: scheduler tüm offset'leri dakikaya çevirir; 13 task 13 dakika içinde fire olur.
- Premium guard Unit 4'te; burada ekstra assertion test'i yaz.

**Patterns to follow:**
- Mevcut `env.ts` FCM_ENABLED tanımı.

**Test scenarios:**
- Happy path: `CAMPAIGN_TEST_MODE_MINUTES=1` → 13 task birer dakika arayla scheduled.
- Integration: fire sırasında `users/{uid}.isPremium=true` set edilip receiver çağrılırsa → skip.
- Integration: fire önce 1 kez başarılı, sonra token silinmiş → ikinci fire no-op.

**Verification:** Runbook adımları takip edilerek QA ortamında 13 bildirim 13 dakikada alınabiliyor; premium flag set edilince durduruluyor.

## System-Wide Impact

- **Interaction graph:**
  - `POST /api/users/me/fcm-token` now also triggers campaign scheduling (non-blocking, best-effort).
  - `PATCH /api/users/me/premium-state` new endpoint; no current consumers.
  - iOS `PremiumStateManager` observer now posts to network.
  - `AppDelegate.handleDeepLink` now dispatches new route types.
- **Error propagation:**
  - Scheduler failure (Cloud Tasks 5xx) must not block FCM token registration → non-fatal, logged + alert.
  - Receiver failure (exception) → Cloud Tasks retries; ensure idempotent (lastFiredDay stamp). Premium flip-to-true during retries is safe (guard reads fresh).
- **State lifecycle risks:**
  - User sign-out → FCM tokens cleared; scheduled tasks still fire but find empty tokens → no-op. Campaign doc remains; if same uid re-auth'lar ve `preLaunchCampaign.scheduledAt` set ise ikinci schedule atılmaz (istenen davranış; anonim auth yeniden kurulursa farklı uid).
  - User deletion: tasks fire, user doc yok → null-safe handling gerekli (Unit 4 edge case).
- **API surface parity:** Android yok; sadece iOS.
- **Integration coverage:** token-register → schedule → fire → push → deep link → view navigation — manuel end-to-end test zorunlu (Unit 6 runbook).
- **Unchanged invariants:**
  - Mevcut generation-completed push payload ve deep-link formatı değişmiyor.
  - Mevcut `users/{uid}.fcmTokens` okuma/yazma semantiği aynı.
  - `FCM_ENABLED=false` hem generation hem campaign dispatch'i durdurur.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Cloud Tasks `scheduleTime` 30 gün üst sınırı (OK ama alarma geç) | 14 gün güvenli, doc'a not düş. |
| Premium webhook / iOS sync gecikirse satın alma sonrası bildirim düşer | Dispatch-time Firestore read — gecikme pencerece küçük; ek olarak iOS client-side observer yapıyoruz. Receipt validation webhook'u ayrı çalışma kalemi. |
| Bildirim spam algısı, kullanıcı bildirimleri kapatır | Kapalı olursa backend sessizce skip eder. Analytics eklendikçe open-rate izlenir. |
| Timezone yanlış hesabı → gece 3'te bildirim | `Europe/Istanbul` fallback güvenli; iOS `TimeZone.current.identifier` mutlaka gönderilmeli. Test'lerde TZ fixtures. |
| Task tombstone / ALREADY_EXISTS | Mevcut retry patterninde çözüldü; task-name dedup + ALREADY_EXISTS catch. |
| Aynı uid iki kere schedule çağırırsa 26 task | Firestore `preLaunchCampaign.scheduledAt` guard + task-name dedup çifte savunma. |
| QA ortamında 14 günlük bekleme | `CAMPAIGN_TEST_MODE_MINUTES` env ile dakikalık sıkıştırma (Unit 6). |
| iOS `aps-environment: development` — production'a çıkmadan önce `production`'a çevirmek unutulur | PR checklist'e ekle; mevcut bir risk, bu plan büyütmüyor. |

## Documentation / Operational Notes

- Yeni runbook: `HomeDecorAI-Backend/docs/runbooks/pre-launch-campaign.md` — enable/disable, QA test mode, template değiştirme (deploy).
- Firestore rules: `users/{uid}.preLaunchCampaign` ve `isPremium` alanlarına client write'ı açılmamalı; sadece backend (admin SDK) yazabilir. Kural dosyasını gözden geçir.
- Monitoring: Cloud Tasks failure rate alert (receiver 5xx > %5 → Slack).
- Gelecek: A/B test altyapısı, analytics open-rate tracking, Android (out-of-scope).

## Sources & References

- Related code:
  - `HomeDecorAI-Backend/src/lib/cloud-tasks.ts`
  - `HomeDecorAI-Backend/src/lib/notifications/fcm.ts`
  - `HomeDecorAI-Backend/src/lib/notifications/token-store.ts`
  - `HomeDecorAI-Backend/src/lib/notifications/i18n.ts`
  - `HomeDecorAI-Backend/src/services/generation-processor.ts`
  - `HomeDecorAI-Backend/src/controllers/users.controller.ts`
  - `HomeDecorAI/HomeDecorAI/App/AppDelegate.swift`
  - `HomeDecorAI/HomeDecorAI/Shared/Utilities/NotificationManager.swift`
  - `HomeDecorAI/HomeDecorAI/Core/Paywall/PremiumStateManager.swift`
  - `HomeDecorAI/HomeDecorAI/Features/Wizard/Models/HomeTool.swift`
- External docs:
  - Google Cloud Tasks `scheduleTime` reference.
  - firebase-admin `messaging().sendEachForMulticast`.
