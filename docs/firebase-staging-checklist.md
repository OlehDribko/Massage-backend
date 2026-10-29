# Ручна перевірка реального Firebase (staging)

Що перевіряє: те, чого не можуть перевірити ні модульні тести, ні Auth Emulator. Це підписи Google, справжній вхід Google, листи Firebase і Brevo, службовий ключ та IAM. Перевірка виконується вручну після першого деплою з Firebase і після кожної зміни ключа, IAM або налаштувань Firebase. Лише staging-проєкт; production не чіпати.

## Підготовка

- Задеплоєно staging з `REQUIRE_FIREBASE_AUTH=true`. Крок деплою «Check authentication over HTTPS» зелений, тобто `GET /api/me` без токена повертає `401`. Це **лише** доказ наявності auth-маршруту, а не інтеграції.
- Web-клієнт staging: frontend або локальний клієнт `tools/firebase-check` (див. його README). Він працює через локальний проксі, тож CORS staging не змінюється.
- Тестові дані:
  - дві тестові поштові скриньки (A, B);
  - тестовий Google-акаунт;
  - свіже вікно браузера в приватному режимі для кожного сценарію.
- Маркетинг (крок 6) потребує `ENABLE_MARKETING_SUBSCRIPTION=true` і Brevo на staging. Без них очікується `outcome: "unavailable"`.

### Як надсилати запити з токеном

Токен ніде не записується: ні в чат, ні в issue, ні в історію shell.

```bash
API=https://<staging-api>          # STAGING_API_BASE_URL
read -rs TOKEN                     # вставити ID token, отриманий у браузері: await auth.currentUser.getIdToken()
curl -s -X POST "$API/api/me/sync" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
curl -s "$API/api/me" -H "Authorization: Bearer $TOKEN"
unset TOKEN
```

У нотатки перевірки записувати лише HTTP-статус, `code` і потрібні поля профілю. Ніколи не записувати токен чи заголовки.

## Сценарій

Позначення: ☐ — виконати; результат «так/ні» плюс коментар.

| # | Дія | Очікування |
|---|---|---|
| **1** | **Інтеграція (справжній токен).** Гостьовий вхід у клієнті, потім `POST /api/me/sync` і `GET /api/me` з його токеном | ☐ `200` для обох. Профіль створено, `isAnonymous: true`, `bookingReadiness.blockers` містить `anonymous_session`. Це доводить: підпис реального проєкту, доступ Admin SDK (`getUser` службовим акаунтом), запис і читання в БД. `401 INVALID_TOKEN` означає не той проєкт (`FIREBASE_PROJECT_ID`); `503 AUTH_UNAVAILABLE` означає ключ або IAM |
| 1a | Оновити сторінку, повторити `sync` | ☐ Той самий `profile.id`, нового гостя не створено (`authStateReady` до `signInAnonymously`) |
| **2** | **Гість → email/пароль (скринька A).** У гостьовій сесії з кроку 1 зробити `linkWithCredential(EmailAuthProvider.credential(...))` | ☐ Firebase прийняв прив'язку, UID не змінився |
| 2a | ⚠️ **Перевірено лише на емуляторі.** Одразу після прив'язки надіслати `sync` з токеном, **поверненим прив'язкою** (до повторного входу) | ☐ Записати фактичний результат: `200` чи `401 SESSION_REVOKED`. В Auth Emulator це `SESSION_REVOKED`, бо додавання пароля відкликає сесії, а токен зберігає анонімний `auth_time`. Як поводиться реальний Firebase, невідомо. Frontend у будь-якому разі робить повторний вхід (2b), тому цей крок лише уточнює документацію |
| 2b | `signInWithEmailAndPassword` (A), потім `sync` | ☐ `200`, **той самий** `profile.id`, `isAnonymous: false`, `emailVerified: false`, blocker `email_not_verified` |
| 2c | `sendEmailVerification`; перейти за посиланням із листа; `getIdToken(true)`, потім `sync` | ☐ Лист Firebase прийшов (мова, відправник і шаблон правильні). Після переходу `emailVerified: true` |
| **3** | **Google.** Нова гостьова сесія, `linkWithPopup(GoogleAuthProvider)`, потім `sync` | ☐ Той самий `profile.id`, що в гостя; `emailVerified: true`; email Google-акаунта. Повторний вхід не потрібен |
| 3a | Чисте вікно: одразу `signInWithPopup(Google)` тим самим акаунтом | ☐ Той самий профіль, що в 3 (новий не створено) |
| 3b | Гостьова сесія; прив'язати облікові дані, що вже належать акаунту з 2 або 3 | ☐ Помилка Firebase `credential-already-in-use` / `email-already-in-use`. Профілі не злиті, гостьовий профіль окремий |
| **4** | **Відновлення пароля.** Перед кроком зберегти токен сесії A (у змінній shell, як вище). Потім `sendPasswordResetEmail(A)`, перейти за посиланням, задати новий пароль | ☐ Лист Firebase прийшов |
| 4a | Запит зі старим токеном A | ☐ Очікувано `401 SESSION_REVOKED` (зміна пароля відкликає сесії; на реальному Firebase не перевірено) |
| 4b | Вхід з новим паролем, потім `sync` | ☐ Той самий `profile.id`, дані профілю збережено |
| 4c | `sendPasswordResetEmail` для неіснуючої адреси | ☐ Інтерфейс показує те саме повідомлення, що й для існуючої (захист від перелічення) |
| **5** | **Профіль клієнта.** `PATCH /api/me` з `{"name":"…","phone":"+33…"}` для акаунта A | ☐ `200`, телефон у форматі E.164, `bookingReadiness.ready: true`, `blockers: []` |
| 5a | `PATCH /api/me` з `{"role":"admin"}` або `{"email":"…"}` | ☐ `400 VALIDATION_FAILED`, нічого не змінено |
| **6** | **Маркетинг.** Реєстрація скриньки B (email/пароль) з чекбоксом: `sync` з `{"marketingOptIn":true,"marketingConsentTextVersion":"<поточна>"}` | ☐ `marketingOptIn.outcome: "confirmation_sent"`. Лист Brevo прийшов. Поки email B не підтверджено у Firebase, `marketing: null` (статус чужої адреси не показується) |
| 6' | Підтвердити email B у Firebase (як 2c), потім `sync` без тіла | ☐ `marketing: {"subscribed": false, "pendingConfirmation": true, …}` |
| 6a | Повторити `sync` з чекбоксом двічі | ☐ `outcome: "no_action"`, другого листа немає |
| 6b | `POST /api/me/marketing/subscription` («надіслати ще раз») у межах 10 хв | ☐ `202 {"outcome":"no_action","retryAfterSeconds":…}`, листа немає |
| 6c | Перейти за посиланням підтвердження | ☐ `subscribed: true`, `consentSource: "signup_checkbox"`, є `consentGivenAt` і `consentTextVersion`. Прийшов лист «підписку підтверджено» з посиланням відписки |
| 6d | Відписка за посиланням з листа (або `DELETE /api/me/marketing/subscription`) | ☐ `subscribed: false`, є `unsubscribedAt`. Службові листи Firebase і далі приходять |
| 6e | `sync` з чекбоксом | ☐ `no_action`, статус лишається `false` |
| 6f | Явна повторна підписка `POST /api/me/marketing/subscription`, потім підтвердження | ☐ Новий лист; після підтвердження `subscribed: true`, `consentSource: "account_request"`, `unsubscribedAt: null` |
| **7** | **Права адміністратора.** Призначити акаунт A адміністратором командою з `docs/auth-and-profiles.md`, розділ 9 (спершу dry-run) | ☐ Dry-run показує зміну. `--apply` призначає роль. Для гостя або непідтвердженого email команда відмовляє (код виходу `2`) |
| 7a | `GET /api/me` акаунтом A | ☐ `role: "admin"`, blocker `not_a_client` (адміністратор не бронює для себе) |
| 7b | Акаунт B (клієнт) | ☐ `role: "client"`; змінити собі роль через API неможливо (5a) |
| **8** | **Блокування й вихід.** Вимкнути акаунт B у консолі Firebase (Authentication → Users → Disable), потім запит з його токеном | ☐ `403 ACCOUNT_DISABLED`. Після ввімкнення знову працює |
| 8a | `POST /api/me/sessions/revoke` акаунтом A, потім запит зі старим токеном | ☐ `204`, далі `401 SESSION_REVOKED` |
| **9** | **Чужий проєкт.** Токен з Auth Emulator або іншого Firebase-проєкту | ☐ `401 INVALID_TOKEN` |

Бізнес-маршрути з правами клієнта й адміністратора (бронювання, послуги, графік) ще не існують. Їхні політики перевірено модульними тестами. Ручна перевірка цих прав з'явиться разом із самими маршрутами.

## Після перевірки

- Результати (так/ні, коди відповідей, без токенів) додати в PR або нотатку релізу.
- Результат кроку 2a перенести в `docs/auth-and-profiles.md`, розділ 5, крок про прив'язку пароля. Повторний вхід лишається в контракті.
- Тестових користувачів видалити в консолі Firebase staging. Профілі в БД staging залишаються; це тестові дані.
- Призупинити staging (`infra/staging-deploy.md`, «Пауза»).
