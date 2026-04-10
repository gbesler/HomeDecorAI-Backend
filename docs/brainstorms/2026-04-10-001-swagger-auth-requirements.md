---
date: 2026-04-10
topic: swagger-auth-single-path
---

# Swagger Auth: Single Firebase Path (Pattern A)

## Problem Frame

HomeDecorAI-Backend şu anda iki ayrı authentication yolunu paralel olarak destekliyor:

1. **`bearerAuth`** — iOS uygulamasının üreteceği Firebase ID token'ı. Üretim (production) için tasarlanmış yol.
2. **`apiKey`** — Swagger UI'dan hızlı test için eklenmiş `X-API-Key` bypass. `src/middlewares/firebase-auth.ts:41-45`'te Firebase doğrulamasını tamamen atlıyor ve `swagger-test-user` kimliği ile request'i geçiriyor.

İki somut sorun doğuruyor:

- **Güvenlik (öncelikli):** `SWAGGER_API_KEY` bypass'ı hem development hem production ortamında aktif. Key sızarsa (env dashboard ekran görüntüsü, yanlış repo commit'i, geliştirici makinesi kaybı), internetteki herhangi bir aktör Firebase doğrulamasını tamamen atlayıp `/api/design/interior` endpoint'ine istek atabilir. Bu da Replicate/fal.ai kredilerinin boşa harcanmasına, Firestore'da sahte generation kayıtlarına ve faturalandırma riskine yol açar.
- **Geliştirici UX'i:** Swagger UI'ın "Authorize" modalı iki ayrı auth alanı gösteriyor (`bearerAuth` ve `apiKey`). Hangisinin hangi amaçla doldurulacağı dokümantasyondan anlaşılmıyor; yanlış alana yazılınca sessiz 403 alınıyor ve hata mesajı kullanıcıyı doğru yöne yönlendirmiyor.

Ek olarak middleware'de bir **User-Agent kontrolü** var (`firebase-auth.ts:49`) — request'in `User-Agent` header'ı `HomeDecorAI/` ile başlamazsa 403 atıyor. Bu kontrol gerçek bir güvenlik sağlamıyor (herhangi bir `curl -H` tek adımda atlar) ve tarayıcıdan açılan Swagger UI'ın `User-Agent` header'ını set etme yetkisi olmadığı için Swagger UI'dan yapılan *hiçbir* request'in — geçerli Firebase token'ı bile olsa — bu noktayı geçmesi mümkün değil.

iOS tarafında henüz backend'e HTTP isteği atan bir client kodu yok (`HomeDecorAI/Core/Network/` altında sadece `NetworkMonitor` ve `FirestoreService` mevcut). Yani auth flow'u retrofit edilmiyor, **sıfırdan tek yollu** olarak kurulabilir.

## Requirements

**Backend — Auth sadeleştirme**

- R1. Middleware tek bir authentication path'i sağlamalı: geçerli bir Firebase ID token doğrulaması. Token doğrulanırsa `request.userId` decoded UID'ye set edilir; doğrulanamazsa 401 döner.
- R2. `X-API-Key` tabanlı bypass kodu middleware'den tamamen kaldırılmalı. `SWAGGER_API_KEY` environment variable bu repo'da kullanılmaz.
- R3. User-Agent kontrolü middleware'den tamamen kaldırılmalı. `HomeDecorAI/` prefix gereksinimi, özel 403 mesajı ve ilgili log satırı silinir.
- R4. Middleware'in 401 yanıtları, hatanın sebebini ayırt edilebilir kılmalı (örn. eksik header, bozuk token, expired token). Mesajlar iOS client'ın ve Swagger kullanıcısının doğru düzeltmeyi yapabileceği kadar açıklayıcı olmalı.

**Backend — OpenAPI ve dokümantasyon**

- R5. OpenAPI spec'te (`src/app.ts` components.securitySchemes) yalnızca `bearerAuth` tanımı kalmalı. `apiKey` scheme silinir.
- R6. Tüm korumalı route'ların `security` tanımı yalnızca `[{ bearerAuth: [] }]` olmalı; `apiKey` referansları silinir.
- R7. `bearerAuth`'un Swagger açıklaması, geliştiricinin nasıl bir token alıp Authorize alanına yapıştıracağına dair kısa yönerge içermeli. Yönerge, dev-token script'ine (R8) işaret etmeli.
- R8. Repo'da, yerel geliştirme sırasında kullanılabilecek bir test Firebase kullanıcısı için geçerli bir ID token üreten, minimal bir script bulunmalı. Script `.env` (veya eşdeğer, gitignored) dosyasından kimlik bilgilerini okumalı, token'ı stdout'a yazmalı ve geliştiricinin kopyala-yapıştır ile Swagger UI'a aktarmasını mümkün kılmalı.

**Backend — Env ve secrets temizliği**

- R9. `src/lib/env.ts` içindeki `SWAGGER_API_KEY` tanımı silinmeli. `.env.example` dosyasından da ilgili satır kaldırılmalı.
- R10. Eğer Render (production) veya herhangi bir deployment ortamında `SWAGGER_API_KEY` değeri set edilmişse, değişiklik yayına alındıktan sonra bu env var manuel olarak silinmeli (artık referans edilmiyor olsa bile attack surface'te bırakılmaması için).

**iOS entegrasyonu — tasarım bağlayıcıları**

- R11. iOS client, backend'e yapacağı her request için `Firebase.Auth.currentUser?.getIDToken()` çağrısından dönen token'ı `Authorization: Bearer <token>` header'ı olarak eklemeli. Token süresi Firebase SDK tarafından otomatik yönetilir; client tarafında ayrıca cache/refresh mantığı yazılmaz.
- R12. iOS client, kullanıcı oturum açmamışsa (currentUser nil ise) backend'e istek atmadan önce hata/yönlendirme akışına düşmeli. Bu, backend'in 401 dönmesine güvenmeden, client-side erken bir hata hattı oluşturur.

> Not: R11 ve R12 HomeDecorAI iOS repo'sunun bir parçası; backend repo'da implementasyonu yok. Burada yer almalarının sebebi, backend tarafındaki sözleşmenin (single bearer token) iOS tarafında açıkça karşılığı olduğunun belgelenmesi.

## Success Criteria

- Swagger UI'da "Authorize" modalı **tek bir alan** gösteriyor: `bearerAuth`.
- Production'da `SWAGGER_API_KEY` değerini bilen bir attacker, `/api/design/interior` endpoint'ine geçerli bir istek atmayı başaramıyor (bypass kodu artık yok).
- Geliştirici, repo'yu klonlayan biri olarak, dokümantasyonu takip ederek 5 dakika içinde Swagger UI'dan `/api/design/interior` endpoint'ine başarılı (veya business-logic 400/429) bir istek atabilmeli. Token üretme script'i bu akışın tek manuel adımı olmalı.
- Middleware dosyası `firebase-auth.ts`, tek yollu (Firebase token → decoded UID) bir akış olarak okunabilir; if-bypass-return pattern'ı kaldırılmış.
- `env.ts`'teki zod schema'da `SWAGGER_API_KEY` artık listelenmiyor.

## Scope Boundaries

- **iOS tarafındaki HTTP client implementasyonu bu brainstorm'un kapsamı değil.** R11/R12 sadece backend sözleşmesinin iOS'ta nasıl karşılanacağını belgeler; URLSession/async/await yapısının tasarımı, hata yönetimi, retry politikaları, token expiry UX'i ayrı bir brainstorm/plan konusudur.
- **Rate limiting politikası değişmiyor.** Mevcut `createRateLimitPreHandler("interiorDesign")` preHandler'ı olduğu gibi kalır. Test kullanıcısının rate limit'i normal bir kullanıcı ile aynı kovada.
- **Birden fazla ortam (staging/dev) oluşturulması kapsam dışı.** Pattern C (ayrı dev deployment) brainstorm sırasında değerlendirildi ve solo geliştirici için overkill bulunduğu için reddedildi. Gelecekte ekip büyürse ayrı bir brainstorm konusu.
- **Swagger UI'ın production'da tamamen kapatılması kapsam dışı.** Endpoint'ler Firebase ile korunuyor; Swagger UI'ın kendisi public kalabilir. `/docs` prod'da erişilebilir olmaya devam eder, sadece gerçek token gerekir.
- **User-Agent tabanlı telemetri/analytics kapsam dışı.** UA kontrolü siliniyor; UA bilgisi isteniyorsa analytics/logging katmanında ayrıca toplanabilir (bu brainstorm'un konusu değil).
- **Dev-token script'inin CI/CD entegrasyonu kapsam dışı.** Script yerel geliştirici makinesinde çalışacak şekilde tasarlanır; CI testlerinde Firebase Emulator veya mock kullanımı ayrı bir konudur.
- **Test kullanıcısının izolasyonu (ayrı Firebase proje, ayrı Firestore koleksiyonu) kapsam dışı.** Test kullanıcısı production Firebase projesinde normal bir user olarak yaşar; logs ve Firestore kayıtları onun UID'siyle tutulur.

## Key Decisions

- **Pattern A seçildi** (diğer iki alternatif: environment-gated bypass, ayrı dev deployment). Sebep: tek-ekip/solo geliştirici için en düşük karbon ayak izi; iOS tarafı zaten Firebase ID token üretmek zorunda, aynı mekanizmayı Swagger için de kullanmak "single source of truth for auth" prensibini korur; bypass kodu tamamen silinince attack surface küçülür.
- **User-Agent kontrolü tamamen silinecek** (alternatif: log-only yapmak). Sebep: gerçek güvenlik sağlamıyor (curl header ile bir saniyede atlanır), tarayıcıdan Swagger UI kullanımını teknik olarak imkânsız kılıyor (browser UA header'ı JS'ten set edilemez), kaldırıldığında hiçbir meşru kullanıcı kaybı olmuyor.
- **Production'da Swagger UI açık kalacak.** Attack surface Firebase token'ına indirgendiği için UI'ın kendisi tehlike değil. Kapatmak geliştirici ergonomisini azaltır.
- **Test kullanıcısı production Firebase projesinde yaşayacak.** Ayrı bir dev Firebase projesi kurmanın maliyeti (Firestore rules, service account, deployment config) Pattern A'nın sağladığı basitlikle ters orantılı.

## Dependencies / Assumptions

- Backend'de `firebase-admin` SDK zaten kurulu (`package.json`'da verify edildi) — Firebase doğrulama için ek bağımlılık gerekmeyecek.
- Firebase projesinde test için bir user hesabı oluşturulabiliyor (Firebase Console → Authentication → Add user, email/password provider açık). Bu proje-yönetimsel bir prerequisite; plan aşamasında değil, ilk çalıştırmada geliştirici tarafından yapılır.
- Firebase Auth REST API'sinin `accounts:signInWithPassword` endpoint'i (veya Admin SDK'nın `createCustomToken` + exchange akışı) test script'inden erişilebilir. Her ikisi de public Firebase API'leri.
- Render environment'ında `SWAGGER_API_KEY`'in şu anda set edilmiş olup olmadığı **bilinmiyor** — bugünkü 403 testinin kök sebebi büyük ihtimal bu env var'ın Render'da set edilmemiş olması veya yanlış değerle girilmiş olması. Bu brainstorm'un implementasyonu sonrası bu env var zaten gereksizleşeceği için **ayrıca debug edilmeyecek**; Render dashboard'dan silinecek.

## Alternatives Considered

- **Pattern B — Environment-gated bypass.** Bypass kodunu koruyup `NODE_ENV !== "production"` guard'ı eklemek. Reddedildi: dev ortamında kolaylık sağlar ama prod'da test etmek gerektiğinde (staging yokken olası) yine token gerekir, yani problemi tam çözmüyor; üstelik iki auth path'i bakım yükü olarak kalıyor.
- **Pattern C — Ayrı dev deployment + IP allowlist.** Prod ve dev olarak iki ayrı Render servisi. Reddedildi: solo geliştirici için iki deployment'ın maliyeti ve senkronizasyon yükü, kazanılan izolasyona değmiyor.
- **User-Agent kontrolünü log-only yapmak.** Reddedildi: observability değeri minimal (UA bilgisi request log'larda zaten mevcut), ek complexity için yeterli getiri yok.

## Outstanding Questions

### Resolve Before Planning

*(boş — blocking soru kalmadı)*

### Deferred to Planning

- [Affects R4][Technical] 401 hata mesajlarının tam yapısı ne olacak? (örn. structured error code mı, insan-okunur string mi, Problem Details RFC 7807 mı?) Planning sırasında iOS client'ın error handling ihtiyaçlarına bakarak karar verilmeli.
- [Affects R8][Technical] Token üretme script'i için `accounts:signInWithPassword` (public Firebase Auth REST) mi yoksa `firebase-admin` ile custom-token → exchange mi tercih edilmeli? İlki daha basit (20 satır, dış bağımlılık yok), ikincisi daha esnek (test user'sız çalışabilir). Planning sırasında trade-off'a bakıp seç.
- [Affects R8][Technical] Script hangi dille yazılacak? (`npm run` script'i olarak Node.js, backend stack ile uyumlu) — default tercih Node.js ama ecosystem uyumu planning'de doğrulanmalı.
- [Affects R7][Technical] Swagger `bearerAuth` description metni içinde script'e nasıl referans verilmeli? (README bağlantısı mı, inline komut mu, ayrı dev-docs sayfası mı?)
- [Affects R2, R9][Technical] `SWAGGER_API_KEY` referanslarının silinmesi sırasında başka hangi dosyalar etkilenir? (`.env.example`, `env.ts`, `firebase-auth.ts` zaten biliniyor; planning sırasında kapsamlı bir grep yapılmalı.)

## Separate Incident (out of this brainstorm)

Bugünkü 403 sorunu (`e6aaac74...` key'i ile curl test) bu brainstorm'un implementasyonu ile **doğal olarak** çözülecek çünkü bypass kodu tamamen silinecek. Yine de Render dashboard'dan `SWAGGER_API_KEY` env var'ı **manuel olarak silinmeli** (R10). O gün gelene kadar geçici workaround: prod'da debug amaçlı test etmek gerekirse Render env dashboard'dan değeri doğrula ve servisi restart et. Ama brainstorm implementasyonundan sonra bu workaround artık gerekmeyecek.

## Next Steps

-> `/ce:plan` for structured implementation planning
