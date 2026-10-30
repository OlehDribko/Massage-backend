# Автентифікація, профілі та права доступу

Перший функціональний етап: Firebase Authentication, власні профілі користувачів у PostgreSQL (Neon) і серверні перевірки прав. Бронювання, графік, каталог послуг, оплата, SMS, AI, зображення і Notifications-сервіс сюди **не входять**.

## 1. Розподіл відповідальності

| Що | Хто відповідає | Де зберігається |
|---|---|---|
| Підтвердження особи: вхід Google, email + пароль, анонімна сесія гостя | Firebase Authentication | Firebase |
| Паролі, підтвердження email, відновлення пароля, зміна email | Firebase (клієнтський SDK і стандартні листи Firebase) | Firebase |
| Блокування акаунта (`disabled`), відкликання сесій | Firebase; backend перевіряє на кожному запиті | Firebase |
| Власний стабільний ID користувача, роль, ім'я, телефон | Backend | `UserProfile` у PostgreSQL |
| Копія email і `emailVerified` | Backend, **лише з перевіреного ID-токена** | `UserProfile` |
| Згода на маркетингові листи | Backend, окремо від акаунтів | `MarketingSubscription` |
| Рішення «можна / не можна» для бізнес-операцій | Backend (`src/modules/access`) | — |

**Firebase UID — зовнішній ідентифікатор.** Він зберігається в `UserProfile.firebaseUid` (унікальний) і ніколи не повертається клієнту. Майбутні бронювання посилатимуться на `UserProfile.id` (UUID).

**Анонімність — стан автентифікації, роль — атрибут авторизації.** Гість завжди `client`. База даних забороняє анонімному профілю мати роль `admin` (constraint `UserProfile_admin_not_anonymous`).

**Гостьовий ID не ідентифікує людину.** Одна людина може мати кілька анонімних сесій (інший браузер, очищені дані), а один пристрій можуть ділити кілька людей. Анонімний профіль не можна вважати унікальним клієнтом ні для обліку, ні для лімітів.

## 2. Аудит legacy-реалізації та що з нею зроблено

До цього етапу існував модуль `/api/users/*` (за прапорцем `ENABLE_LEGACY_USER_ROUTES`, вимкнений на staging):

| Елемент | Рішення | Причина |
|---|---|---|
| Реєстрація з паролем (`POST /api/users`), `passwordHash`, bcrypt | **Видалено код і залежність**; колонку `User.passwordHash` збережено | Два механізми входу заборонені; паролі тепер лише у Firebase. Дані не видаляються без окремого рішення |
| Власні JWT для підтвердження email і скидання пароля (`/verify-email`, `/resend-verification`, `/forgot-password`, `/reset-password`) | **Видалено** | Не можна мати власні токени паралельно з Firebase |
| `User.emailVerified`, `emailVerificationSentAt`, `status` | Код більше не використовує; дані збережено | Для переходу (див. нижче) |
| Підписка / відписка на розсилку (`/subscribe`, `/unsubscribe`) | **Адаптовано** в окремий модуль `/api/marketing` | Див. розділ 7 |
| JWT-сервіс дій (`jsonwebtoken`, `ACTION_TOKEN_SECRET`) | **Адаптовано**: лише для маркетингових посилань, лише HS256 | Посилання підтвердження й відписки в листах підписки |
| `User.marketingConsent` | Код не читає; **не переноситься** | Не є доказом підтвердженої згоди (див. нижче) |
| Brevo-клієнт, шаблони листів | **Адаптовано**: лише листи підписки | Службові листи акаунта шле Firebase |
| `ENABLE_LEGACY_USER_ROUTES` | `false` або відсутність приймаються й ігноруються; `true` — помилка запуску | Staging task definition досі передає `false` |

**Знайдені проблеми legacy-маршрутів підписки (виправлено в новому модулі):**
- **Перелічення адрес:** різні відповіді (`409 already subscribed`, «pending», «success») показували, чи відома адреса і чи вона підписана. Тепер відповідь завжди однакова: `202 SUBSCRIPTION_REQUESTED`.
- **Підписка без згоди власника адреси:** для вже підтвердженого email будь-хто міг увімкнути розсилку одним запитом. Тепер згода з'являється лише після переходу за посиланням із листа (double opt-in).
- **500 при відписці:** `unsubscribe` з токеном неіснуючого користувача падав на `P2025` і давав 500. Тепер відповідь та сама, що для існуючого.
- **Повторне використання посилань:** legacy-токен `email_verify` діяв 7 днів і міг повторно підтверджувати. Тепер посилання підтвердження одноразове (nonce у БД), а після відписки старе посилання підтвердження не підпише адресу знову.
- **Підтвердження email як згода:** у legacy-реєстрації `marketingConsent` з чекбокса ставав «підтвердженим» разом із підтвердженням email акаунта. Тепер підтвердження email у Firebase і підтвердження маркетингової підписки — різні дії.
- **Підписка змішувалась з акаунтом:** запис підписника створював `User` зі статусом `subscribed`, а підтвердження підписки ставило `emailVerified` акаунта. Тепер підписка — окрема таблиця, яка не створює й не змінює профілів.

**Що поза цим етапом (описано, не реалізовано):** масова розсилка запитів підписки на різні адреси (рядок на адресу й одна спроба на 10 хв на адресу; загальний ліміт — лише throttling API Gateway). Для захисту потрібен CAPTCHA або Firebase App Check — окреме завдання разом із frontend.

### Наявні користувачі (legacy `User`)

- Таблиця `User` лишається без змін; код її не читає.
- **Профілі не прив'язуються до Firebase за збігом email.** Людина з legacy-акаунтом реєструється у Firebase заново (Google або email + пароль); з'являється новий `UserProfile`, не пов'язаний з `User`.
- **Маркетингова згода не переноситься.** У legacy-даних немає доказу підтвердженої згоди: `marketingConsent` міг стати `true` без підтвердження (підписка вже перевіреної адреси), а `emailVerified` доводить лише робочу адресу. Legacy-підписники мають підписатися знову (форма або чекбокс). Старі посилання відписки з legacy-листів відповідають нейтрально `200 UNSUBSCRIBED` і нічого не змінюють. Перевірено інтеграційним тестом (legacy-рядки до міграції → `MarketingSubscription` порожня).
- Видалення `User` (разом із `passwordHash`) — окреме рішення після переходу. Пропозиція: після запуску production і перевірки, що ніхто не потребує даних, очистити `passwordHash` окремою міграцією, а таблицю видалити пізніше.

## 3. Модулі коду

| Файл | Призначення |
|---|---|
| `src/modules/auth/identity.ts` | Контракт `IdentityProvider` / `VerifiedIdentity`. Бізнес-код залежить лише від нього |
| `src/integrations/firebase/firebase-identity-provider.ts` | Єдине місце, де використовується Firebase Admin SDK |
| `src/http/auth/authenticate.ts` | Middleware `Authorization: Bearer <ID token>` |
| `src/modules/profiles/*` | Профіль: синхронізація з токена, читання, зміна власних полів, телефон |
| `src/modules/access/policies.ts` | Правила: готовність до бронювання, адміністрування, скасування, перенесення |
| `src/modules/access/require-access.ts` | Guards `requireBookingClient`, `requireAdmin` для майбутніх маршрутів |
| `src/modules/profiles/role-assignment.ts`, `src/admin/assign-role.ts` | Призначення ролі власником (команда, не HTTP) |
| `src/modules/marketing/*` | Підписка на розсилку |

**Перевірка токена.** `verifyIdToken(token, checkRevoked = true)` Firebase Admin SDK (14.5.0) на кожному запиті:
- підпис RS256 ключами Google (кешуються SDK), `exp`, `iat`, `auth_time`;
- `aud` = `FIREBASE_PROJECT_ID`, `iss` = `https://securetoken.google.com/<project>` — токен іншого проєкту (наприклад, staging у production) відхиляється;
- запит до Firebase Auth за записом користувача: заблокований (`disabled`) → `403 ACCOUNT_DISABLED`; токен виданий раніше за відкликання сесій → `401 SESSION_REVOKED`.

Політика: перевірка відкликання на **кожному** автентифікованому запиті (додатковий виклик до Firebase, до сотні мілісекунд). Для навантаження цього застосунку це прийнятно; блокування діє одразу, а не через годину. Якщо Firebase недоступний → `503 AUTH_UNAVAILABLE` (з `Retry-After`), а не пропуск запиту.

Власної криптографії немає: підпис і claims перевіряє SDK, а backend лише валідує потрібні claims Zod-схемою й зіставляє коди помилок SDK.

## 4. Контракт API

Базова адреса staging: `STAGING_API_BASE_URL` (HTTPS API Gateway). Усі відповіді — JSON; `/api/me*` відповідають з `Cache-Control: no-store`.

### Автентифікація

```
Authorization: Bearer <Firebase ID token>
```

Токен — лише в заголовку (не в URL, не в cookie). Backend не створює власних сесій і cookie: єдиний механізм сесії — Firebase.

| Ситуація | Статус | `code` | Що робить frontend |
|---|---|---|---|
| Немає заголовка | 401 | `AUTH_REQUIRED` | Увійти (або створити анонімну сесію) |
| Пошкоджений, підроблений токен, інший проєкт, видалений користувач | 401 | `INVALID_TOKEN` | `getIdToken(true)` і повторити один раз; далі — вийти |
| Прострочений токен | 401 | `TOKEN_EXPIRED` | `getIdToken(true)` і повторити один раз |
| Сесії відкликано | 401 | `SESSION_REVOKED` | `signOut()`, попросити увійти знову |
| Акаунт заблоковано | 403 | `ACCOUNT_DISABLED` | `signOut()`, показати повідомлення; повторні спроби марні |
| Firebase недоступний | 503 | `AUTH_UNAVAILABLE` | Повторити після `Retry-After` |

### `POST /api/me/sync`

Створює профіль, якщо його немає, і оновлює з токена `email`, `emailVerified`, `authState`, `signInProvider`. Ідемпотентний; безпечний при паралельних викликах. Старіший токен не перезаписує дані новішого.

Викликати: після входу, після прив'язки анонімної сесії до Google / email, після підтвердження email (разом із `getIdToken(true)`), після зміни email.

Тіло необов'язкове (`{}` або без тіла). Єдине, що в ньому можна передати, — чекбокс маркетингової підписки при завершенні реєстрації:

| Поле | Значення |
|---|---|
| `marketingOptIn` | `true` — запустити підтвердження підписки (лист із посиланням); відсутнє або `false` — нічого не змінює (не створює згоди й **не відписує** чинного підписника) |
| `marketingConsentTextVersion` | Обов'язкове при `marketingOptIn: true`: версія тексту згоди, показаного біля чекбокса (зараз `2026-10-28.fr.1`) |

`marketingOptIn: true` діє **щонайбільше один раз на адресу**: повторні й паралельні синхронізації не надсилають нових листів, а після відписки (або вже наданої колись згоди) нічого не роблять — для повторної підписки є окрема явна дія. Статус підписки від самого параметра не стає `true`.

```http
POST /api/me/sync
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json

{ "marketingOptIn": true, "marketingConsentTextVersion": "2026-10-28.fr.1" }
```

```json
{
  "profile": {
    "id": "6f0d7c9e-3b8a-4a52-9d55-1f2e3c4b5a69",
    "role": "client",
    "authState": "registered",
    "name": "Léa Martin",
    "email": "lea@example.com",
    "emailVerified": false,
    "phone": null,
    "signInProvider": "password",
    "createdAt": "2026-10-27T10:00:00.000Z",
    "updatedAt": "2026-10-27T10:00:00.000Z"
  },
  "bookingReadiness": {
    "ready": false,
    "blockers": ["email_not_verified", "phone_missing"]
  },
  "marketing": null,
  "marketingOptIn": {
    "outcome": "confirmation_sent",
    "currentConsentTextVersion": "2026-10-28.fr.1"
  }
}
```

`marketingOptIn` є у відповіді лише якщо його передали як `true`. Синхронізація профілю успішна за будь-якого `outcome`:

| `outcome` | Значення |
|---|---|
| `confirmation_sent` | Лист підтвердження передано провайдеру (це не гарантія доставки в скриньку) |
| `delivery_failed` | Лист не вдалося відправити; нічого не змінено, профіль створено; можна повторити (наступний `sync` з чекбоксом або явна дія) |
| `no_action` | Нічого не потрібно або не дозволено: вже підписано, лист уже надсилали, або колись була відписка/згода. Навмисно не розрізняється |
| `unavailable` | Маркетинг вимкнений, або сесія без email (гість — використовує публічну форму) |
| `consent_text_outdated` | Показано іншу версію тексту; нічого не записано; актуальна — у `currentConsentTextVersion` |
| `failed` | Неочікувана помилка сервера (у логах без секретів); нічого не обіцяно |

**`marketing`** — статус підписки email профілю (джерело істини — `MarketingSubscription`). `null`, поки email відсутній або не підтверджений у Firebase (щоб ніхто не дізнався статус чужої адреси, вказавши її без підтвердження):

```json
"marketing": {
  "subscribed": true,
  "pendingConfirmation": false,
  "consentGivenAt": "2026-10-28T10:12:00.000Z",
  "consentSource": "signup_checkbox",
  "consentTextVersion": "2026-10-28.fr.1",
  "unsubscribedAt": null
}
```

`name` нового профілю береться з токена (ім'я Google), якщо воно проходить правила імені; інакше `null`.

### `GET /api/me`

Той самий формат. `404 PROFILE_NOT_FOUND`, якщо `sync` ще не викликали.

### `PATCH /api/me`

Лише власні поля `name` і `phone`; `null` очищає поле.

```json
{ "name": "Léa Martin", "phone": "+33 6 12 34 56 78" }
```

- `name`: 1–80 символів, літери (будь-якої мови), пробіли, `'`, `.`, `-`.
- `phone`: міжнародний формат із `+`; зберігається в E.164 (`+33612345678`) після перевірки повними метаданими libphonenumber. Національний формат без `+` відхиляється (країна не вгадується). **Телефон не підтверджується** (SMS немає), не використовується для входу чи відновлення доступу.
- Будь-яке інше поле (`email`, `role`, `emailVerified`, `id`, `firebaseUid`, `isAnonymous`, ...) → `400 VALIDATION_FAILED`, нічого не змінюється.
- Email змінюється лише через Firebase (`verifyBeforeUpdateEmail`); новий email потрапить у профіль на наступному `sync` після підтвердження.

### `POST /api/me/marketing/subscription` — явна (повторна) підписка

Для зареєстрованого акаунта з email, зокрема **після відписки** (це нова явна дія користувача). Double opt-in: статус стане `true` лише після посилання з листа.

```http
POST /api/me/marketing/subscription
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json

{ "consentTextVersion": "2026-10-28.fr.1" }
```

→ `202 {"outcome":"confirmation_sent"}`; `202 {"outcome":"no_action","retryAfterSeconds":412}` — лист надіслано менше 10 хв тому, кнопку «надіслати ще раз» можна активувати через вказану кількість секунд; `202 {"outcome":"no_action"}` без `retryAfterSeconds` — уже підписано; `503 CONFIRMATION_EMAIL_NOT_SENT` — лист не відправлено, нічого не змінено; `409 CONSENT_TEXT_OUTDATED` (з `currentConsentTextVersion`); `403 REGISTERED_ACCOUNT_REQUIRED` для гостя. Маршрут існує лише при `ENABLE_MARKETING_SUBSCRIPTION=true`.

#### Відновлення незавершеної підписки

Синхронізації (`sync` з чекбоксом) ніколи не надсилають лист повторно. Для відновлення є одна явна операція з обмеженням частоти: `POST /api/me/marketing/subscription` для зареєстрованого користувача, `POST /api/marketing/subscriptions` для гостя. Не більше одного листа на адресу за 10 хв (`CONFIRMATION_COOLDOWN_MS`); новий лист робить попереднє посилання недійсним.

| Що сталося | Що бачить frontend | Що робити |
|---|---|---|
| Лист не вдалося відправити | `marketingOptIn.outcome: "delivery_failed"` або `503 CONFIRMATION_EMAIL_NOT_SENT` (`Retry-After: 60`); `pendingConfirmation: false` | Кнопка «Надіслати ще раз». Невдала спроба нічого не записує й ліміт не витрачає |
| Посилання прострочене (7 днів) або вже замінене | `400 INVALID_ACTION_TOKEN` на сторінці підтвердження; `pendingConfirmation: true` | Запропонувати «Надіслати нове посилання» (явна операція; ліміт до того часу вже минув) |
| Лист загубився | `pendingConfirmation: true` | «Надіслати ще раз»: у межах 10 хв — `no_action` з `retryAfterSeconds`, після — новий лист |

Тести: `test/marketing-account.test.ts` (опис «recovering an unfinished subscription»), `test/marketing.test.ts` (ліміт і заміна посилання у формі), `test/integration/marketing.test.ts` (ті самі правила в PostgreSQL).

### `DELETE /api/me/marketing/subscription` — відписка

Лише для підтвердженого email (`403 EMAIL_NOT_VERIFIED` інакше). Ідемпотентно; працює й при вимкненій розсилці. → `200` з профілем, де `marketing.subscribed: false` і `unsubscribedAt`. Службові листи не зачіпає.

### `POST /api/me/sessions/revoke`

Вихід на всіх пристроях: відкликає refresh-токени користувача у Firebase. → `204`. З наступного запиту всі видані до цього ID-токени отримують `401 SESSION_REVOKED`. Після виклику frontend робить `signOut()`.

### Готовність до бронювання

`bookingReadiness.blockers` (у стабільному порядку):

| Значення | Що означає |
|---|---|
| `not_a_client` | Роль `admin`: адміністратор не бронює для себе |
| `anonymous_session` | Гість: потрібен вхід через Google або email |
| `email_not_verified` | Email не підтверджений у Firebase |
| `name_missing` | Немає імені |
| `phone_missing` | Немає телефону |

Це підказка для інтерфейсу. Майбутні маршрути бронювання перевіряють те саме на сервері (`requireBookingClient`, з синхронізацією профілю з поточного токена) і відповідають `403 BOOKING_NOT_READY` з тим самим списком `blockers`.

### Права для майбутніх маршрутів (`src/modules/access/policies.ts`)

| Дія | Хто може |
|---|---|
| Бронювати для себе | Клієнт без жодного blocker |
| Керувати послугами й графіком | `admin`, не анонімний, з підтвердженим email |
| Отримувати повідомлення про записи | Той самий адміністратор |
| Скасувати запис | Клієнт-власник запису або адміністратор |
| Перенести запис | Лише клієнт-власник, готовий до бронювання. Адміністратор **не** переносить чужі записи |

### Маркетингова підписка (`/api/marketing`, лише при `ENABLE_MARKETING_SUBSCRIPTION=true`)

Публічні маршрути без автентифікації. Нічого не створюють і не змінюють у профілях.

| Запит | Відповідь |
|---|---|
| `POST /api/marketing/subscriptions` `{"email":"a@example.com","consentTextVersion":"2026-10-28.fr.1"}` | `202 {"code":"SUBSCRIPTION_REQUESTED", ...}` — однаково для нової, очікуючої й уже підписаної адреси (повторна підписка після відписки — так само, це явна дія). `503 CONFIRMATION_EMAIL_NOT_SENT`, якщо лист не вдалося відправити (без неправдивого «надіслано»); `409 CONSENT_TEXT_OUTDATED` |
| `POST /api/marketing/subscriptions/confirm` `{"token":"..."}` | `200 SUBSCRIBED` / `ALREADY_SUBSCRIBED`; використане, замінене, прострочене посилання чи посилання після відписки → `400 INVALID_ACTION_TOKEN` |
| `POST /api/marketing/subscriptions/unsubscribe` `{"token":"..."}` | `200 UNSUBSCRIBED` (ідемпотентно, також для невідомої підписки); пошкоджений токен → `400 INVALID_ACTION_TOKEN` |

Посилання в листах: `${FRONTEND_URL}/marketing/confirm?token=...` (7 днів, одноразове) і `${FRONTEND_URL}/unsubscribe?token=...` (1 рік). Frontend бере `token` з URL і надсилає його в тілі POST.

### Модель маркетингової згоди

Одне джерело істини — рядок `MarketingSubscription` на адресу email (не на профіль, тож підписка гостя переживає втрату анонімної сесії й з'являється в профілі після реєстрації з тією самою підтвердженою адресою).

| Поле | Значення |
|---|---|
| `subscribed` | **Авторитетний статус.** `false` за замовчуванням; `true` лише після підтвердження посилання; `false` після відписки |
| `consentGivenAt`, `consentSource`, `consentTextVersion` | Доказ останньої підтвердженої згоди: коли, звідки (`signup_checkbox`, `subscription_form`, `account_request`), яка версія тексту. Лишаються після відписки як історія |
| `unsubscribedAt` | Дата останньої відписки; очищається при новій підтвердженій згоді |
| `confirmationNonce`, `confirmationSentAt`, `confirmationSource`, `confirmationTextVersion` | Незавершений запит на підписку (одноразове посилання й те, на що погодилися) |

Обмеження БД: `subscribed = true` неможливий без дати, джерела й версії згоди; незавершений запит завжди має джерело й версію; email у нижньому регістрі. Legacy `User.marketingConsent` — не статус підписки: код його не читає.

Версія тексту згоди — константа `MARKETING_CONSENT_TEXT_VERSION` у `src/modules/marketing/consent.ts`. Зміна тексту = нова версія одночасно в backend і frontend.

## 5. Інструкція для frontend

Firebase Web SDK **10.6.0 або новіший** (з увімкненим захистом від перелічення email старіші версії не можуть прив'язати email/пароль до анонімного користувача). Конфігурація Firebase для web (`apiKey`, `authDomain`, `projectId`, `appId`) не є секретом; для staging і production вона різна.

1. **Сесія кожного відвідувача.** Анонімна сесія створюється лише тоді, коли сесії немає зовсім, і лише **після** відновлення збереженої сесії (інакше зареєстрований користувач на мить «немає» і отримає анонімну сесію замість своєї):
   ```ts
   await auth.authStateReady();                 // Firebase відновив збережену сесію (Web SDK ≥ 10)
   if (auth.currentUser === null) {
     await signInAnonymously(auth);             // гість
   }
   onAuthStateChanged(auth, async (user) => {
     if (user !== null) {
       await api("POST", "/api/me/sync");       // профіль гостя або клієнта; без тіла
     }
   });
   ```
   - Зареєстрований акаунт ніколи не замінюється анонімним: `signInAnonymously` викликається тільки при `currentUser === null`.
   - Після `signOut()` створюється **новий** гість (інший UID, інший профіль).
   - Публічні сторінки й `/health/*` не потребують токена; backend не перевіряє токен на публічних маршрутах навіть якщо він є. Токен потрібен лише для `/api/me*`.
   - Гість бачить публічну інформацію, може підписатися на розсилку через публічну форму, але бронювати не може (`anonymous_session`).

2. **Кожен запит до API:**
   ```ts
   const token = await auth.currentUser.getIdToken();   // SDK сам оновлює токен за ~5 хв до закінчення
   fetch(url, { headers: { Authorization: `Bearer ${token}` } });
   ```
   На `401 TOKEN_EXPIRED` або `INVALID_TOKEN`: `getIdToken(true)` і один повтор. Лише HTTPS.

3. **Перехід гостя до акаунта** (той самий Firebase UID → той самий профіль, з іменем і телефоном):
   - Google: `linkWithPopup(auth.currentUser, new GoogleAuthProvider())`;
   - email + пароль: `linkWithCredential(auth.currentUser, EmailAuthProvider.credential(email, password))`, **потім одразу** `signInWithEmailAndPassword(auth, email, password)` (той самий UID). Додавання пароля Firebase вважає зміною акаунта й відкликає попередні сесії; токен, повернений прив'язкою, зберігає час анонімного входу, тож backend відхиляє його як `SESSION_REVOKED` (так поводиться Auth Emulator; **поза емулятором не перевірено** — [сценарій](firebase-staging-checklist.md), частина A, рядок `info A2a`; повторний вхід коректний в обох випадках);
   - потім `POST /api/me/sync` (з чекбоксом розсилки, якщо це завершення реєстрації — крок 4).

   Загальне правило: на `401 SESSION_REVOKED` одразу після прив'язки або зміни пароля — повторний вхід (`signInWithEmailAndPassword` / `reauthenticateWithCredential`), а не вихід.

   Якщо Firebase повертає `auth/credential-already-in-use` або `auth/email-already-in-use`, облікові дані належать іншому акаунту. Не зливати автоматично: запропонувати «Увійти в існуючий акаунт» (`signInWithCredential` / `signInWithPopup`) і потім `sync`. Дані гостьового профілю (ім'я, телефон) не переносяться в існуючий акаунт; backend ніколи не об'єднує профілі за email.

4. **Завершення реєстрації з чекбоксом розсилки.** Чекбокс необов'язковий і за замовчуванням вимкнений. Після першого входу (email + пароль: `createUserWithEmailAndPassword` або прив'язка гостя, потім `sendEmailVerification(user)`; Google: `signInWithPopup` / `linkWithPopup`) — один виклик:
   ```ts
   await api("POST", "/api/me/sync", marketingChecked
     ? { marketingOptIn: true, marketingConsentTextVersion: "2026-10-28.fr.1" }
     : {});
   ```
   - `outcome: "confirmation_sent"` → «Перевірте пошту, щоб підтвердити підписку» (не «ви підписані»);
   - `delivery_failed` → «Не вдалося надіслати лист підтвердження підписки; спробуйте пізніше в профілі» (реєстрація при цьому успішна);
   - `consent_text_outdated` → оновити текст і запропонувати знову.

   Подальші `sync` надсилайте **без** `marketingOptIn`. Підписка стане активною лише після посилання з листа, а `profile.marketing` показується після підтвердження email у Firebase.

5. **Підтвердження email** (стандартний лист Firebase): після переходу за посиланням — `await user.reload(); await user.getIdToken(true);` і `POST /api/me/sync`. До цього профіль показує `email_not_verified`.

6. **Відновлення пароля:** `sendPasswordResetEmail(auth, email)` (стандартний лист Firebase). Скидання пароля відкликає сесії: на інших пристроях буде `SESSION_REVOKED`.

7. **Зміна email:** `verifyBeforeUpdateEmail(user, newEmail)`; після підтвердження — повторний вхід, `getIdToken(true)` і `sync`. Поле `email` у `PATCH /api/me` не приймається.

8. **Вихід:**
   - **На цьому пристрої:** `signOut(auth)`. Локальні токени видаляються; вже виданий ID-токен формально діє до закінчення (≤ 1 год), але frontend його більше не використовує.
   - **На всіх пристроях:** `POST /api/me/sessions/revoke`, потім `signOut(auth)`. Усі refresh-токени відкликано; backend одразу відхиляє всі раніше видані ID-токени.
   - Після виходу frontend знову створить анонімну сесію (крок 1) — це вже **інший** гість.

9. **Заблокований користувач** (`403 ACCOUNT_DISABLED`): `signOut(auth)` і повідомлення «Акаунт заблоковано». Firebase також не видасть новий токен.

10. **Підписка в профілі:** показувати `profile.marketing.subscribed`. «Відписатися» — `DELETE /api/me/marketing/subscription`; «Підписатися знову» і «Надіслати лист ще раз» (коли `marketing.pendingConfirmation: true`) — `POST /api/me/marketing/subscription` з `consentTextVersion` (лише явна дія користувача); `retryAfterSeconds` у відповіді — скільки чекати до наступного листа. Сторінка `/marketing/confirm` на `400 INVALID_ACTION_TOKEN` пропонує надіслати нове посилання.

11. **Готовність до бронювання:** показувати форму доповнення профілю за `bookingReadiness.blockers`; телефон просити в міжнародному форматі (`+33 …`). Рішення завжди за сервером.

## 6. Листи

**Обрано стандартні листи Firebase** (підтвердження email, скидання пароля, підтвердження зміни email), які надсилає клієнтський SDK.

Чому зараз так:
- немає власних токенів підтвердження/відновлення — Firebase сам генерує, обмежує й перевіряє посилання;
- обмеження частоти й захист від перелічення email — на боці Firebase;
- backend не потребує прав на генерацію action links;
- наявний Brevo-компонент був прив'язаний до legacy-акаунтів і в поточному вигляді — не сервіс повідомлень.

Обмеження: текст і вигляд листів — шаблони Firebase (налаштовуються в консолі: мова, ім'я відправника, тема; власний домен відправника — через налаштування SMTP/домену у Firebase). Коли з'явиться окремий Notifications-сервіс, можна перейти на `generateEmailVerificationLink` / `generatePasswordResetLink` Admin SDK з доставкою своїм провайдером — ті самі посилання Firebase, без власних токенів. Це окреме завдання (потрібні rate limiting і захист від перелічення на нашому боці).

Brevo використовується лише для листів маркетингової підписки.

## 7. Firebase-проєкти: staging і production

Два **окремі** Firebase-проєкти. Staging — `massage-fr` (створено; Google, Email/Password і Anonymous увімкнено, вхід за посиланням з email вимкнено). Production — окремий проєкт, ще не створено. Окремі проєкти — окремі користувачі, ключі, налаштування. Токен staging відхиляється production-бекендом і навпаки (`aud`/`iss`), а службовий ключ іншого проєкту не пройде перевірку конфігурації (`project_id` ≠ `FIREBASE_PROJECT_ID`).

Кроки для кожного проєкту (робить власник у консолі Firebase):

1. **Створити проєкт** у [console.firebase.google.com](https://console.firebase.google.com) (Google Analytics не потрібен).
2. **Authentication → Get started → Sign-in method:** увімкнути **Email/Password** (без «Email link»), **Google** (вказати support email) і **Anonymous**.
3. **Authentication → Settings:**
   - *User account linking:* «Link accounts that use the same email» (один акаунт на email, значення за замовчуванням);
   - *User actions → Email enumeration protection*: має бути увімкнено (для проєктів, створених після 15.09.2023, — за замовчуванням);
   - *Authorized domains:* лише домени frontend цього середовища (і `localhost` лише у staging);
   - *Password policy* — за бажанням.
4. **Authentication → Templates:** мова (французька), ім'я відправника, тексти листів підтвердження, скидання пароля і зміни email; *Action URL* — сторінка frontend цього середовища, якщо обробляєте дії самі.
5. **Project settings → General → Your apps → Web app:** зареєструвати web-застосунок; конфігурацію передати frontend (не секрет).
6. **Службовий акаунт для backend** (Google Cloud Console того самого проєкту → IAM & Admin → Service Accounts):
   - створити окремий акаунт, наприклад `booking-api@<project>.iam.gserviceaccount.com`;
   - надати роль **Firebase Authentication Admin** (`roles/firebaseauth.admin`) — у ній є `firebaseauth.users.get` (перевірка блокування/відкликання) і `firebaseauth.users.update` (відкликання сесій). Не використовувати автоматичний `firebase-adminsdk-…` з ширшими правами;
   - створити JSON-ключ (Keys → Add key → JSON) і одразу покласти в SSM (розділ 8), не зберігаючи у файлах репозиторію.
7. **Тариф:** Spark (безкоштовний) достатній для цих функцій; Identity Platform не потрібен. Не змінювати тариф без окремого рішення.

## 8. Конфігурація backend

| Змінна | Обов'язково | Опис |
|---|---|---|
| `REQUIRE_FIREBASE_AUTH` | ні (`false`) | Режим обов'язкової авторизації для функціонального деплою: при `true` відсутній `FIREBASE_PROJECT_ID` — помилка запуску (`FIREBASE_PROJECT_ID: required when REQUIRE_FIREBASE_AUTH=true`), а не мовчазний запуск без `/api/me`. Без мережевих викликів |
| `FIREBASE_PROJECT_ID` | для `/api/me` | ID Firebase-проєкту середовища. Без неї (і без `REQUIRE_FIREBASE_AUTH`) маршрутів `/api/me` немає (fail closed) |
| `FIREBASE_CREDENTIALS` | так, разом з project id | `service-account-json` (рекомендовано зараз), `application-default` (ADC / Workload Identity Federation), `none` — лише з емулятором |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | при `service-account-json` | **Секрет.** Вміст JSON-ключа; `project_id` має дорівнювати `FIREBASE_PROJECT_ID`. У логи й помилки не потрапляє |
| `FIREBASE_AUTH_EMULATOR_HOST` | ні | Лише локально й у CI: тільки при `NODE_ENV≠production`, тільки з `demo-` проєктом і без облікових даних. При `NODE_ENV=production` — **помилка запуску** (емулятор приймає непідписані токени) |
| `ENABLE_MARKETING_SUBSCRIPTION` | ні (`false`) | Вмикає `/api/marketing`; тоді обов'язкові `BREVO_API_KEY`, `EMAIL_FROM_NAME`, `EMAIL_FROM_EMAIL`, `ACTION_TOKEN_SECRET` (≥ 32 символи), `FRONTEND_URL` |
| `FRONTEND_URL` | ні | CORS origin і база посилань у листах підписки |

### Admin SDK в AWS (staging), безпечне підключення

**Зараз (рекомендовано): JSON-ключ у SSM, як і рядки підключення до БД.**
1. Покласти JSON-ключ у SSM так, щоб вміст не потрапив у термінал, історію чи Git; локальний файл видаляється лише після підтвердженого запису:
   ```bash
   export AWS_PROFILE=massage AWS_REGION=eu-west-3
   PARAM=/massage-staging/booking/firebase-service-account
   KEY="$(ls -t ~/Downloads/massage-fr-*.json | head -1)"; chmod 600 "$KEY"
   # Перевірка файлу без виводу вмісту.
   jq -e '.type == "service_account" and .project_id == "massage-fr"
          and .client_email == "booking-api-staging@massage-fr.iam.gserviceaccount.com"
          and (.private_key | startswith("-----BEGIN PRIVATE KEY-----"))' "$KEY" >/dev/null && echo "file ok"
   # Запис (без --overwrite: наявний параметр не перезапишеться).
   aws ssm put-parameter --name "$PARAM" --type SecureString --tier Standard \
     --value "file://$KEY" --query Version --output text --no-cli-pager
   # Метадані без розшифрування.
   aws ssm get-parameter --name "$PARAM" --query 'Parameter.{Type:Type,Version:Version,Modified:LastModifiedDate}' --no-cli-pager
   # Звірка вмісту за SHA-256: значення йде лише в pipe, виводиться "match" або "MISMATCH".
   L="$(shasum -a 256 < "$KEY" | cut -c1-64)"
   R="$(aws ssm get-parameter --name "$PARAM" --with-decryption --query Parameter.Value --output text | perl -pe 'chomp if eof' | shasum -a 256 | cut -c1-64)"
   [ "$L" = "$R" ] && echo match || echo MISMATCH
   # Видалення файлу — лише після match.
   [ "$L" = "$R" ] && rm "$KEY" && echo deleted; unset L R KEY
   ```
   Для ротації — `put-parameter` з `--overwrite`. Ключ ~2,4 KB — вміщується в Standard (4 KB).
2. Task definition API: `environment` — `REQUIRE_FIREBASE_AUTH=true`, `FIREBASE_PROJECT_ID=<staging project>`, `FIREBASE_CREDENTIALS=service-account-json`; `secrets` — `FIREBASE_SERVICE_ACCOUNT_JSON` з ARN параметра.
3. Execution role API: `ssm:GetParameters` і на цей параметр.
4. Egress 443 у SG API вже дозволено (`api_https`).
5. Ротація: новий ключ → `put-parameter --overwrite` → новий деплой → видалити старий ключ у Google Cloud.

Ці зміни внесено в Terraform staging (`infra/environments/staging/ecs.tf`, `ecs_iam.tf`, змінна `firebase_project_id`, за замовчуванням `massage-fr`), але **ще не застосовано**. Порядок: спершу SSM-параметр, потім `apply`. Інакше наступна задача API не стартує: ECS не знайде секрет. Ключ отримує лише execution role API; задача міграції його не бачить.

**Пізніше (без довгоживучого ключа): Workload Identity Federation AWS → Google Cloud** з `FIREBASE_CREDENTIALS=application-default` і конфігурацією `external_account` у `GOOGLE_APPLICATION_CREDENTIALS`. Для ECS Fargate облікові дані задачі надходять через container credentials endpoint, а не IMDS; підтримку цього шляху в google-auth-library треба перевірити окремо. Не перевірено в цьому етапі.

## 9. Первинне призначення адміністратора

HTTP-маршруту для зміни ролі немає; профіль не може отримати `admin` через реєстрацію чи `PATCH`. Роль змінює власник командою `src/admin/assign-role.ts` (у образі — `dist/admin/assign-role.js`).

Умови для `admin`: профіль існує, не анонімний, email підтверджений (за останньою синхронізацією), і email збігається з `--email` (захист від помилки в ID). Без `--apply` — сухий прогін.

1. Майбутній адміністратор входить у frontend (Google або email + пароль), підтверджує email і робить `POST /api/me/sync`; повідомляє власнику свій `profile.id` з `GET /api/me`.
2. Власник запускає команду в мережі staging, використовуючи вже наявний секрет БД (рядок підключення не потрапляє в термінал):
   ```sh
   aws ecs run-task --cluster massage-staging \
     --task-definition massage-staging-booking-api \
     --launch-type FARGATE \
     --network-configuration "awsvpcConfiguration={subnets=[<public subnet>],securityGroups=[<sg massage-staging-api>],assignPublicIp=ENABLED}" \
     --overrides '{"containerOverrides":[{"name":"booking-api","command":["node","dist/admin/assign-role.js","--profile-id","<uuid>","--email","<email>","--role","admin"]}]}'
   ```
   Переглянути лог задачі (`/ecs/massage-staging/booking-api`, повідомлення `dry run: nothing changed`), потім повторити з `"--apply"`.
3. Коди виходу: `0` — виконано / сухий прогін, `2` — відмовлено (`profile_not_found`, `email_mismatch`, `anonymous_session`, `email_not_verified`), `1` — помилка конфігурації або БД.
4. Зняти роль: та сама команда з `--role client`.

Лог містить лише `profileId`, стару й нову роль. Альтернатива — запуск локально з тимчасовим env-файлом `DATABASE_URL` (як для перевірки ролей Neon), але ECS-варіант не виводить секрет за межі AWS.

## 10. Застосування міграції та перевірка staging (майбутній порядок)

Нічого з цього в межах етапу не виконано.

1. Злиття PR у `develop`; CI зелений.
2. Firebase-проєкт staging і службовий ключ (розділ 7) — власник.
3. SSM-параметр ключа й зміни Terraform для task definition та execution role (розділ 8) → `terraform plan` → погоджений `apply` (лише нова ревізія task definition і IAM).
4. `ECR publish` для нового коміту.
5. `Staging deploy` з `run_migrations=true`: міграція `20261027120000_firebase_profiles_and_marketing` створює `UserProfile`, `MarketingSubscription`, enum-и й обмеження; раннер видає `booking_app` DML на нові таблиці. Legacy `User` не змінюється.
6. Перевірки через HTTPS — два різні рівні, один не замінює інший:

   | Перевірка | Хто і коли | Що доводить | Чого **не** доводить |
   |---|---|---|---|
   | `GET /api/me` **без токена** → `401 AUTH_REQUIRED` з `WWW-Authenticate: Bearer` | Автоматично, кожен деплой: workflow `Staging deploy`, крок «Check authentication over HTTPS» (вхід `verify_auth`, за замовчуванням `true`; `false` — лише для відкату на образ без автентифікації) | Задеплоєно образ з auth-маршрутами, і вони вимагають токен. Разом із `REQUIRE_FIREBASE_AUTH=true` — що конфігурацію Firebase задано й вона синтаксично коректна (інакше процес не стартує: немає параметра SSM, не JSON, чужий `project_id`) | Що токени Firebase приймаються, що службовий ключ і роль IAM правильні, що профіль створюється і читається. Firebase цим запитом не викликається; health checks теж ніколи не звертаються до Firebase. Тому **відкликаний ключ або відсутня роль IAM не роблять задачу unhealthy і не викликають відкат ECS**: їх видно лише з авторизованого запиту (`503 AUTH_UNAVAILABLE`) |
   | Запит зі **справжнім Firebase ID token** staging-проєкту: `POST /api/me/sync`, потім `GET /api/me` → `200` з профілем | Вручну, після першого деплою з Firebase і після змін ключа/IAM: [сценарій](firebase-staging-checklist.md), частина A (Firebase REST, `curl`, `jq`) — під час інтеграції frontend; **ще не виконано** | Підпис і `aud`/`iss` реального проєкту; доступ Admin SDK до Firebase (перевірка блокування й відкликання викликає `getUser` службовим акаунтом); створення профілю в БД і його читання | — |

   **Інтеграцію Firebase зі справжнім токеном ще не перевірено**: перший короткий запуск staging обмежується автоматичними перевірками деплою. Частина A сценарію перевіряє також email/пароль, прив'язку гостя, профіль і відкликання сесій. **Реальний вхід Google, листи Firebase, маркетинг і права адміністратора ще не перевірено** — частина B, разом з інтеграцією frontend.
7. Пауза staging (`desired_count=0`), як в `infra/staging-deploy.md`.

## 11. Що перевірено і де

| Сценарій | Модульні тести (без мережі) | Auth Emulator + PostgreSQL | Потребує реального Firebase |
|---|---|---|---|
| Відсутній / пошкоджений токен, неправильна схема, завеликий токен | так | так | — |
| Підроблений підпис, непідписаний токен, custom token, інший `aud`/`iss` | так (реальний SDK у production-режимі) | інший проєкт — так | підпис справжнім ключем Google — ні |
| Прострочений токен | мапінг | так | — |
| Заблокований користувач, відкликані сесії, видалений користувач | мапінг | так | — |
| Анонімний гість, прив'язка до email/пароля і Google зі збереженням профілю | — | так (фейковий Google емулятора); після прив'язки пароля — повторний вхід | **реальний вхід Google не перевірено**; поведінку `auth_time` після прив'язки пароля перевірити на staging |
| Облікові дані вже належать іншому акаунту, відсутність злиття | — | так | — |
| Непідтверджений email, оновлення після підтвердження, старий токен не відкочує | так | так | реальні листи Firebase не перевірено |
| Телефон: нормалізація, відмова для некоректного | так | constraint БД | — |
| Чужий профіль, призначення собі `admin`, привілейовані поля | так | так (і через `PATCH`) | — |
| Ідемпотентність і конкурентне створення профілю | in-memory | 25 паралельних запитів, один рядок | — |
| Команда призначення ролі | — | так (усі відмови й `--apply`) | — |
| Підписка: double opt-in, нейтральні відповіді, одноразові посилання, доказ згоди, обмеження БД | так | так | реальні листи Brevo не перевірено |
| Чекбокс при реєстрації (email/пароль і Google), без чекбокса, повторні й паралельні `sync`, відписка й подальший `sync`, повторна підписка лише явною дією, помилка відправки | так | так (email/пароль, Google, паралельні) | — |
| Відновлення: помилка доставки, прострочене й загублене посилання; явне повторне надсилання з лімітом і `retryAfterSeconds` | так | правила ліміту й заміни посилання в PostgreSQL | реальна доставка Brevo — [сценарій](firebase-staging-checklist.md), частина B |
| `emailVerified` не дає згоди; legacy-згоди не переносяться | так | так | — |
| Публічні маршрути й health без токена, без викликів Firebase; `REQUIRE_FIREBASE_AUTH` | так | — | — |
| Перевірка автентифікації в деплої (`check-auth.sh`, без токена) | тести скрипта | — | на staging — при наступному деплої |
| Інтеграція зі справжнім Firebase (токен staging-проєкту, ключ, IAM) | — | — | [сценарій](firebase-staging-checklist.md): частини A і B — під час інтеграції frontend; **ще не перевірено** |
| Секрети й токени не потрапляють у відповіді й логи | так | так | — |

Локально: `npm run emulator:auth -w @massage/booking` (firebase-tools 15.34.1 через `npx`, Java не потрібна), потім `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 npm run test:integration`. CI запускає емулятор у job `integration`.

## 12. Вразливості залежностей (аудит 2026-10-28)

`npm audit` показував 11 записів (1 critical, 9 high, 1 moderate). Усі були й до цього етапу; закрито сумісними оновленнями без `--force` і видаленням невикористаної залежності. Зараз `npm audit`: **0**.

| Пакет | Звідки | У runtime-образі | Застосовність до наших маршрутів | Рішення |
|---|---|---|---|---|
| `axios` 1.19.0 (high) | пряма залежність, у коді **не використовувалась** | так | ні (код не робить запитів через axios) | видалено з залежностей |
| `follow-redirects` (high) | через axios | так | ні | зник разом з axios |
| `body-parser` 2.3.0 (high, DoS через стиснене тіло) | express | так | **так**: `express.json()` розпаковує gzip/deflate тіла на публічних маршрутах | 2.4.0, обов'язково до staging |
| `zod` 4.4.3 (high, пам'ять на великих колекціях) | пряма | так | частково: схем-масивів з вводу немає, тіло ≤ 16 kB | 4.6.7 |
| `proxy-addr` 2.0.7 (critical, IPv4-mapped IPv6 у trust subnet) | express | так | ні: `trust proxy` не налаштовано | 2.0.8 |
| `qs` 6.15.3 (moderate, DoS) | express / body-parser | так | ні: query-парсер Express 5 «simple», urlencoded-тіл немає | 6.17.0 |
| `prisma`, `@prisma/config`, `deepmerge-ts`, `fast-uri`, `mysql2` (high) | Prisma CLI (у migrate-образі й, як peer `@prisma/client`, у runtime-дереві) | так, але лише CLI | ні: CLI працює з довіреною конфігурацією в задачі міграцій; `mysql2` не використовується (PostgreSQL) | `prisma`, `@prisma/client`, `@prisma/adapter-pg` 7.10.1 (узгоджено) |

Перевірка після оновлення: lint, typecheck, unit, інтеграційні (міграції з нуля, перехід зі старих прав, автентифікація, підписка), smoke-тест образів; `prisma migrate diff` — без відмінностей. `qs` 6.17.0 і `body-parser` 2.4.0 опубліковані нещодавно (27 і 22 жовтня) тими самими супровідниками; npm обрав їх як мінімальні сумісні виправлення.

Install-скрипти: дозволено лише `prisma`/`@prisma/engines` 7.10.1, `esbuild`, `fsevents`; `@firebase/util` і `protobufjs` явно заборонено (`allowScripts` у кореневому `package.json`) — для роботи сервера вони не потрібні.

## 13. Відкладені рішення

- **Зображення.** Сервіс зображень, захищене завантаження й підписування запитів обираємо **перед** відповідним завданням. ImageKit — лише кандидат. У цьому етапі нічого з цього не реалізовано і ресурсів не створено.
- CAPTCHA / App Check для публічних форм (підписка, реєстрація).
- Notifications-сервіс (листи про записи адміністратору й клієнтам, брендовані листи Firebase-дій).
- Workload Identity Federation замість JSON-ключа.
- Видалення legacy-таблиці `User` і `passwordHash`.
