# Передача frontend: календар адміністратора, бронювання, підписка

Інструкція для frontend (`my-app`) за контрактами `develop` після PR #45–#51 (2026-11-11).

## Де контракт

- **`docs/openapi.json`** — актуальний OpenAPI 3.1 цього репозиторію. Згенерований з коду (`services/booking/src/openapi/document.ts`, схеми — `src/openapi/schemas.ts` і ті самі Zod-схеми, що валідують запити). Тест `services/booking/test/openapi-snapshot.test.ts` у CI падає, якщо файл розійшовся з кодом; оновлення: `npm run openapi:export -w services/booking`.
- **Живий `/openapi.json` і `/docs`** вмикаються лише `ENABLE_API_DOCS=true`; на staging вимкнено. До деплою `develop` staging може віддавати старішу версію API — перевіряйте версію в `GET /health/ready` (`version` = commit SHA).
- Детально: [booking.md](booking.md) (бронювання, графік, закриття дат), [notifications.md](notifications.md) (листи й статуси), [auth-and-profiles.md](auth-and-profiles.md) (профіль, підписка).

## Стан розгортання

Перевіряйте фактичну версію staging у `GET /health/ready` (`version` = commit SHA) — staging може відставати від `develop`.

- З 2026-11-11 на staging розгорнуто `841f4ee`: листи про бронювання й маркетинг **увімкнені**, але лише для погоджених тестових адрес (інші → `skipped` / `403 TEST_RECIPIENT_NOT_ALLOWED`).
- Пряма підписка підтвердженого користувача (`outcome: "subscribed"` / `"already_subscribed"`) — у `develop` після PR про пряму підписку; до її деплою staging відповідає за старим правилом (`202 confirmation_sent` і для підтвердженого email).
- Інтерфейс має коректно працювати і з вимкненими функціями: `booking.notification` = `null`, `notifications` = `[]`, `marketingAvailable` = `false`, маршрути маркетингу → `404`.

## Інструкція для frontend-агента

```text
Задача для frontend (my-app, Next.js). Реалізуй UI за контрактами backend Massage-backend
Джерело контракту — docs/openapi.json у репозиторії Massage-backend (гілка develop; OpenAPI 3.1, згенерований з коду; CI перевіряє,
що файл збігається з кодом). Живий {API}/openapi.json на staging вимкнено (ENABLE_API_DOCS=false) або він може бути старішим за develop —
на нього не покладайся. Нових полів і маршрутів не вигадуй; якщо чогось бракує — зупинись і напиши, чого саме.
Усі адмін-маршрути: Authorization: Bearer <Firebase ID token> верифікованого адміністратора; 401 AUTH_REQUIRED/…, 403 FORBIDDEN.
Дати — YYYY-MM-DD за Europe/Paris; час — "HH:MM"; моменти — ISO UTC. Помилки: { message, code, …деталі на верхньому рівні }.
503 CALENDAR_BUSY { retryAfterSeconds } + заголовок Retry-After → повтор пізніше. 400 VALIDATION_FAILED { errors: [{ field, message }] }.

1. Календар адміністратора: тиждень / місяць (до 62 дат за запит)
GET /api/admin/schedule/days?from=2027-03-01&to=2027-03-31 → 200
{ "timeZone": "Europe/Paris", "days": [
  { "date": "2027-03-10", "weekday": 3, "closed": false, "source": "weekly",
    "intervals": [{ "start": "09:00", "end": "20:30" }],
    "closure": { "closedAt": "2027-03-01T08:00:00.000Z" },
    "effective": { "open": false, "intervals": [] } } ] }
- closed / source / intervals = графік дати (виняток "exception" або тижневе правило "weekly") — до нього дата повернеться після відкриття.
- closure ≠ null = дата закрита для нових бронювань і перенесень (наявні записи лишаються).
- effective = робочі інтервали з урахуванням закриття: effective.open=false і [] — дата закрита або без робочих годин.
  Це НЕ вільні години: зайнятість і доступні початки визначає лише API доступності
  (GET /api/services/{serviceId}/availability?from&to — слоти для послуги); не вираховуй їх із effective і бронювань.
Показуй: «закрито» — за closure; «вихідний за графіком» — за closed; робочі години дня — effective.intervals.
Не виводь закриття з closed і робочі години з intervals (це графік без урахування закриття).
У календарі адміністратора робочі інтервали (effective) і бронювання (п. нижче) — окремі шари; не віднімай одне від іншого.

GET /api/admin/bookings?from=2027-03-01&to=2027-03-31 → 200 { "from", "to", "timeZone", "bookings": [AdminBooking] }
(одна дата: ?date=2027-03-02 → { "date", "timeZone", "bookings" }; date разом із from/to → 400). Усі статуси, за startsAt.
AdminBooking: { id, status: "confirmed"|"cancelled", phase: "upcoming"|"in_progress"|"finished"|"cancelled", timeZone, startsAt, endsAt,
  service: { id, name, durationMinutes, priceCents, currency }, payment: "on_site", cancellation: { by, at, reason } | null,
  allowedActions: { reschedule, cancel }, history: [...], createdAt,
  client: { profileId, name, email, phone }, notifications: [AdminNotification] }
Групуй бронювання за датою startsAt у Europe/Paris і показуй на днях календаря, зокрема на закритих.

2. Вибір кількох дат, закриття й відкриття (1–62 різні дати, атомарно; повтор безпечний)
POST /api/admin/schedule/closures { "dates": ["2027-03-10", "2027-03-11"] } → 200
{ "timeZone": "Europe/Paris", "days": [ScheduleDay…], "bookings": [
  { "bookingId": "…", "date": "2027-03-10", "startsAt": "2027-03-10T09:00:00.000Z", "endsAt": "2027-03-10T10:00:00.000Z", "serviceName": "Massage 60" } ] }
- bookings — чинні записи цих дат, вони НЕ скасовані: покажи адміністратору список («ці клієнти мають записи — повідомте їх»), з посиланням на запис.
- Автоматичного скасування немає; скасування — лише окремою дією POST /api/admin/bookings/{id}/cancel { "reason"?: "…" } → { booking, changed }.
POST /api/admin/schedule/closures/reopen { "dates": [...] } → 200 { "timeZone", "days" } — прибирає лише закриття; після відкриття дата може лишатися без годин (effective.open=false), якщо її графік неробочий — так і покажи.
Зміна годин (наявне, без змін): PUT /api/admin/schedule/days { "days": [ { "date", "intervals": [{start,end}] } | { "date", "closed": true } | { "date", "useWeekly": true } ] }
→ 200 { timeZone, days } або 409 SCHEDULE_CONFLICT { conflicts: [{ bookingId, startsAt, endsAt, serviceName }] } (нічого не змінено).
Закриття (closures) і «вихідний» (PUT days closed:true) — різні дії: перша не чіпає записів, друга відхиляється при записах (409).

3. Результат створення, перенесення, скасування (клієнт)
POST /api/bookings (заголовок Idempotency-Key: 8–128 символів [A-Za-z0-9_-]) { serviceId, startsAt }
Ключ = один намір забронювати: створи новий ключ, коли користувач вирішує записатися (вибрав послугу й час і натиснув «Записатися»).
Повтор того самого запиту після тайм-ауту, мережевої помилки, 503 CALENDAR_BUSY чи невідомого результату — з ТИМ САМИМ ключем і тим самим тілом
(збережи пару ключ+тіло до отримання відповіді). Новий ключ — лише для нового наміру (інший час, інша послуга, новий запис після скасування).
Інше тіло з тим самим ключем → 422 IDEMPOTENCY_KEY_REUSED.
→ 201 { booking } ; повтор з тим самим ключем → 200 { booking } + Idempotent-Replayed: true (той самий запис, не дубль).
POST /api/bookings/{id}/reschedule { startsAt } → 200 { booking, changed } ; POST /api/bookings/{id}/cancel {} → 200 { booking, changed }.
Помилки: 409 SLOT_UNAVAILABLE { reason: "too_soon"|"beyond_horizon"|"outside_schedule"|"taken" } (закрита дата → outside_schedule),
409 RESCHEDULE_WINDOW_CLOSED, 409 BOOKING_NOT_ACTIVE, 409 CANCELLATION_WINDOW_CLOSED, 403 BOOKING_NOT_READY { blockers }.
Стан бронювання й стан листа — різні поля: успіх операції показуй за booking.status/changed, ніколи не за листом.
booking.notification = { event: "created"|"rescheduled"|"cancelled", status, reason } | null (null — листи вимкнені на сервері; нічого не показуй).
status: pending|sending → «Лист надсилається»; accepted → «Лист із деталями надіслано» (прийнято поштовим провайдером, не «доставлено»);
failed → «…підтверджено, але лист не вдалося надіслати. Деталі — у кабінеті»; interrupted → «Лист затримується»; skipped → нічого.
Адміністратору: booking.notifications[] (від найстаріших) { event, occurredAt, client: R, studio: R }, R = { status, reason, attempts, lastAttemptAt, acceptedAt };
studio.reason "scheduled" = лист студії чекає 30 хв після зміни; "superseded" = замінено новішою зміною; "unchanged" = перенесли й повернули.

4. Маркетингова підписка
Профіль (GET /api/me, POST /api/me/sync, PATCH /api/me): { profile, bookingReadiness, marketing, marketingAvailable }.
marketingAvailable відомий лише з завантаженого профілю: useAuth() → profile.status === 'ready' → profile.data.marketingAvailable.
Окремого запиту заради прапорця немає й не додавай.
- profile ready і marketingAvailable=false → не показуй чекбокс реєстрації, кнопку підписки в кабінеті й форму розсилки.
- profile ready і true → показуй.
- Профіль ще не завантажений (status 'idle'/'loading'), анонімний вхід не завершився або не вдався ('error'), користувача немає:
  це НЕ «вимкнено». Публічну форму показуй як зараз і покладайся на відповідь API:
  404 NOT_FOUND → наявне «L’inscription à la newsletter n’est pas encore ouverte.»; 403 TEST_RECIPIENT_NOT_ALLOWED → «Adresse non autorisée sur l’environnement de test.»
  (успіх не показуй). Чекбокс реєстрації й кнопку кабінету показуй лише при ready + true (вони потребують профілю).
- marketing = null, поки email не підтверджено → «Статус з'явиться після підтвердження email». Інакше:
  subscribed=false & pendingConfirmation=false → «не підписані» (кнопка «Підписатися»);
  pendingConfirmation=true → «очікує підтвердження за посиланням з листа» (кнопки «Надіслати лист ще раз» і «Відписатися»);
  subscribed=true → «підписані» (кнопка «Відписатися»).
Текст згоди й версія — MARKETING_CONSENT (version "2026-10-28.fr.1") поряд з кожним чекбоксом/кнопкою; чекбокс за замовчуванням не відмічений; сам по собі підписку не вмикає.
Підтверджена ідентичність = profile ready, profile.data.profile.authState === "registered" і profile.data.profile.emailVerified === true
(сервер перевіряє те саме за Firebase-токеном; frontend лише вибирає маршрут, нічого не «доводить» тілом запиту).

Вибір маршруту:
- Кабінет: завжди POST /api/me/marketing/subscription (адреси в тілі немає — лише власна адреса з токена).
- Головна сторінка (форма розсилки):
  - підтверджена ідентичність і адреса у формі = власна profile.data.profile.email (або форма показує лише кнопку «Підписатися з <email>»)
    → POST /api/me/marketing/subscription — підписка активна одразу;
  - гість, немає/не завантажено профіль, email не підтверджено, або введено ІНШУ адресу → публічний POST /api/marketing/subscriptions
    (підтвердження через лист). Ніколи не надсилай Bearer-маршрут для чужої адреси — його й неможливо: адреси в тілі немає.

POST /api/me/marketing/subscription { "consentTextVersion": "2026-10-28.fr.1" }:
- 200 { "outcome": "subscribed", "welcomeEmail": "sent"|"not_sent"|"unknown", "marketing": MarketingStatus } — підтверджений email, підписка АКТИВНА:
  «Vous êtes inscrit·e». welcomeEmail ≠ "sent" — підписка все одно активна; можна тихо додати «l’e-mail de bienvenue n’a pas pu être envoyé», без помилки підписки.
- 200 { "outcome": "already_subscribed", "marketing" } — уже була активна; нового листа немає.
- 202 { "outcome": "confirmation_sent" } — email не підтверджено: «перевірте пошту, підтвердіть за посиланням»;
  202 { "outcome": "no_action", "retryAfterSeconds"? } — лист уже надіслано нещодавно (повторно через N с) або результат невідомий.
- 403 REGISTERED_ACCOUNT_REQUIRED (гість), 403 TEST_RECIPIENT_NOT_ALLOWED (тестове середовище: адреса не в списку, нічого не змінено й не надіслано),
  409 CONSENT_TEXT_OUTDATED { currentConsentTextVersion }, 503 CONFIRMATION_EMAIL_NOT_SENT { retryAfterSeconds } (лише непідтверджений email), 404 — маркетинг вимкнено.
Після 200 онови статус із поля marketing (або GET /api/me). Не називай активну підписку «лист надіслано».

Реєстрація: POST /api/me/sync { "marketingOptIn": true, "marketingConsentTextVersion": "2026-10-28.fr.1" } (лише якщо чекбокс відмічено)
→ 200 профіль (поле marketing уже з новим станом) + "marketingOptIn": { "outcome", "welcomeEmail"?, "currentConsentTextVersion" }, outcome:
  "subscribed" (підтверджений email, наприклад Google: активна одразу; welcomeEmail як вище) | "already_subscribed" |
  "confirmation_sent" (непідтверджений email: перевірте пошту) | "no_action" (наприклад, раніше відписався — чекбокс сам не поновлює, лише кнопка) |
  "delivery_failed" | "unavailable" | "consent_text_outdated" | "failed" | "test_recipient_not_allowed" (успіх не показуй).
Синхронізація успішна за будь-якого outcome. Звичайний sync без marketingOptIn, вхід і підтвердження email ніколи не підписують.
Відписка: DELETE /api/me/marketing/subscription → 200 профіль (403 EMAIL_NOT_VERIFIED до підтвердження email); нова підписка після неї — та сама кнопка.
Публічна форма: POST /api/marketing/subscriptions { email, consentTextVersion } → 202 { code: "SUBSCRIPTION_REQUESTED" } (однакова відповідь для будь-якої адреси,
підписка — лише після посилання з листа); 403 TEST_RECIPIENT_NOT_ALLOWED; 409 CONSENT_TEXT_OUTDATED; 503 CONFIRMATION_EMAIL_NOT_SENT { retryAfterSeconds }; 404 — маркетинг вимкнено.
Сторінки посилань /marketing/confirm?token= і /unsubscribe?token= уже є — не змінюй їх шляхів.

Перевірка: unit-тести відображення станів; не покладайся на фіктивні дані замість контрактів; не вмикай маркетинг/листи на staging.
```
