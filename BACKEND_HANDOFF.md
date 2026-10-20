# BACKEND HANDOFF — Massage-backend

> Документ для передачі контексту іншому AI-помічнику.
> Складено 2026-10-19 на основі аналізу коду гілки `main` (коміт `a3cd0ad`).
> Джерела: вихідний код `src/`, `prisma/schema.prisma`, міграції, `package.json`, `tsconfig.json`, `prisma.config.ts`, `.gitignore`, назви змінних у `.env` (без значень), результати локальних перевірок (див. розділ 9).
> README у репозиторії **відсутній**. Секрети, значення змінних середовища та персональні дані сюди не включено.

## Легенда станів

| Позначка | Значення |
|---|---|
| ✅ **Перевірено** | Реалізовано і поведінку фактично перевірено під час цього аналізу (запуск/запит/команда) |
| 🟡 **Не перевірено** | Реалізовано в коді, але роботу ніхто не перевіряв автоматично (тестів немає) і я не запускав цей сценарій |
| 🟠 **Частково** | Реалізовано лише частину сценарію або з відомими дефектами |
| ⚪ **Заплановано / відсутнє** | У коді немає; є лише непрямі ознаки або взагалі нічого |
| ❓ **Невідомо** | Потребує уточнення у власника проєкту |

Важливо: **у проєкті немає жодного автоматизованого тесту**. Тому все, що стосується роботи з БД і відправки листів, має стан 🟡 «не перевірено», навіть якщо код виглядає завершеним.

---

## Коротке резюме

- Це бекенд (Node.js + TypeScript + Express 5 + Prisma 7 + PostgreSQL на Neon) для невеликого масажного кабінету. Транзакційні листи відправляються через **Brevo** (HTTP API, SDK `@getbrevo/brevo`). Мова листів — **французька**.
- Наразі реалізовано **лише модуль користувачів/email**: реєстрація з паролем, підписка на маркетинг лише за email, підтвердження email за посиланням, повторна відправка підтвердження, відновлення та скидання пароля, відписка від маркетингу.
- **Немає входу (login), сесій, JWT-авторизації, ролей, адмін-панелі.** Жоден ендпоінт не захищений авторизацією.
- **Бронювання, послуги, спеціалісти, розклад, записи, нагадування — відсутні повністю** (ні моделей у БД, ні коду).
- Усі листи надсилаються **синхронно в межах HTTP-запиту**; черг, фонових задач, журналу відправлень, вебхуків Brevo немає.
- Тестів немає (`npm test` завершується помилкою-заглушкою). `tsc --noEmit` проходить, схема Prisma валідна, міграції в БД застосовані.
- Знайдено кілька підтверджених у коді проблем безпеки/коректності (розділ 10): зокрема можливість встановити пароль на чужий підписаний email, відсутність cooldown на `/resend-verification` і `/forgot-password`, неекранований `name` у HTML-листах, 500 замість 400 на зламаний JSON.

---

## 1. Призначення та поточний стан

### Які задачі має вирішувати сервіс
За словами власника: бронювання, запис на прийом і комунікація з клієнтами невеликого масажного кабінету. **У коді наразі реалізовано лише комунікаційно-обліковий фундамент**: облік контактів (користувачів), підтвердження email, маркетингова згода та пов’язані листи.

### Ролі користувачів
- У БД немає поля ролі. Є лише `User.status` (enum `UserStatus`) — це **тип облікового запису, а не роль доступу**:
  - `subscribed` — контакт, що залишив лише email для маркетингових розсилок (без імені й пароля);
  - `registered` — користувач з ім’ям і паролем.
- Ролей «адміністратор», «спеціаліст», «клієнт» у коді **немає** ⚪. Як власниця кабінету має керувати системою — ❓.

### Що вже можна зробити через бекенд (на рівні коду)
1. Зареєструватися (ім’я, email, пароль, згода на маркетинг) → отримати лист підтвердження.
2. Підписатися на маркетинг лише за email → отримати лист підтвердження email, після підтвердження — лист «підписку підтверджено» з посиланням на відписку.
3. Підтвердити email токеном з листа.
4. Повторно запросити лист підтвердження.
5. Запросити скидання пароля і встановити новий пароль токеном з листа.
6. Відписатися від маркетингу токеном з листа.

### Основні обмеження
- Немає входу/сесій → пароль зберігається, але **ніде не використовується для автентифікації** ⚪.
- Немає жодного читального ендпоінта (GET) для даних користувачів чи адміністрування.
- Немає функціоналу бронювання ⚪.
- Немає тестів, логування — лише `console.*`.
- Порт захардкоджено (`3001`, `src/server.ts`), немає production-скрипту запуску.

---

## 2. Технології та архітектура

### Стек (з `package.json`)
| Категорія | Технологія |
|---|---|
| Мова | TypeScript (`typescript ^6.0.3`), ESM (`"type": "module"`, `module: NodeNext`) |
| Рантайм | Node.js (локально перевірено v24.21.0; вимога до версії в `package.json` не задана ❓) |
| HTTP-фреймворк | Express 5 (`express ^5.2.1`), `cors` |
| Валідація | Zod 4 (`zod ^4.4.3`) |
| БД | PostgreSQL, хостинг — **Neon** (є `@prisma/adapter-neon`, файл `.neon`) |
| ORM | Prisma 7.9.1 (`@prisma/client`, `prisma`), драйвер-адаптер `PrismaNeon` |
| Хешування паролів | `bcrypt`, 12 раундів (`src/shared/security/password.ts`) |
| Токени дій | `jsonwebtoken` (HS-підпис секретом `ACTION_TOKEN_SECRET`) |
| Email | Brevo SDK `@getbrevo/brevo ^6.0.3` (транзакційні листи) |
| Інше | `dotenv`, `axios` (**у коді не використовується**), `tsx` (dev-запуск) |

### Структура модулів
```
src/
  server.ts                     # точка входу: app.listen(3001)
  app.ts                        # Express: CORS, json, POST /api (debug), /api/users, errorHandler
  middleware/error.middleware.ts# глобальний обробник помилок (AppError → JSON)
  shared/
    database/prisma.ts          # PrismaClient з адаптером Neon
    errors/app-error.ts         # клас AppError(statusCode, message, {code, details})
    security/password.ts        # hashPassword / verifyPassword (verifyPassword ніде не викликається)
  modules/
    users/
      user.route.ts             # усі маршрути /api/users/*
      controller/               # тонкі контролери → сервіс → response-хелпери
      service/user.service.ts   # уся бізнес-логіка користувачів
      repository/               # доступ до Prisma (userRepository)
      email-verification/       # логіка відправки підтвердження + cooldown
      middleware/               # Zod-валідація тіла запиту
      schema/                   # Zod-схеми
      responses/                # формування HTTP-відповідей
      types/                    # DbUser, PublicUser, result-типи
    email/
      service/email.service.ts  # Brevo-клієнт, побудова посилань, відправка
      templates/                # HTML-шаблони (французькою)
      tokens/                   # actionTokenService (JWT для посилань у листах)
      errors/                   # EmailServiceError, mapBrevoError
      middleware/ schema/ types/
```
Шари: `route → validation middleware → controller → service → repository / emailService → response helper`. Глобальний DI немає, модулі — об’єкти/функції з прямими імпортами.

### Локальний запуск (за кодом)
1. `npm install` (у `package.json` є `allowScripts` для prisma/bcrypt/esbuild).
2. Створити `.env` з такими змінними (значення — ❓ у власника):
   - `DATABASE_URL` — рядок підключення PostgreSQL (Neon);
   - `BREVO_API_KEY` — ключ Brevo;
   - `EMAIL_FROM_NAME`, `EMAIL_FROM_EMAIL` — відправник;
   - `ACTION_TOKEN_SECRET` — секрет підпису токенів у листах;
   - `FRONTEND_URL` — база посилань у листах і дозволений CORS origin (має бути валідним URL).
3. `npx prisma migrate deploy` (або `migrate dev`) і `npx prisma generate`.
4. `npm start` → `tsx watch src/server.ts`, сервер на `http://localhost:3001`.
5. `npm run typecheck` → `tsc --noEmit`.

Примітки:
- Якщо будь-яка з email-змінних або `ACTION_TOKEN_SECRET` відсутня, **процес падає під час імпорту модулів** (`throw new Error(...)` на верхньому рівні `email.service.ts`, `action-token.service.ts`, `prisma.ts`). ✅ (видно з коду; запуск з повним `.env` перевірено).
- Немає `build`/`start:prod` скриптів; тека `dist/` містить застарілий `server.js` з ранньої версії (у `.gitignore`).
- Docker, docker-compose, CI — відсутні ⚪.
- Окремого тестового/локального середовища (наприклад, локальної Postgres або sandbox-пошти) немає — локальний запуск працює з тією самою Neon-БД і реальним Brevo, що вказані в `.env` ❓ (чи це окрема dev-гілка Neon — невідомо).

### Зовнішні сервіси та фонові процеси
| Сервіс | Як використовується | Стан |
|---|---|---|
| Neon PostgreSQL | Основна БД через `PrismaNeon` | ✅ підключення працює (`prisma migrate status`) |
| Brevo | `brevo.transactionalEmails.sendTransacEmail` | 🟡 код є, відправку не перевіряв (щоб не слати реальні листи) |
| Фонові процеси / черги / cron | — | ⚪ відсутні |

---

## 3. Дані та бізнес-правила

### Схема БД (`prisma/schema.prisma`)
Є **одна модель** і **один enum**:

```prisma
enum UserStatus { subscribed  registered }

model User {
  id                      String     @id @default(uuid())
  name                    String?
  email                   String     @unique
  passwordHash            String?
  status                  UserStatus
  marketingConsent        Boolean    @default(false)
  emailVerified           Boolean    @default(false)
  emailVerificationSentAt DateTime?
  createdAt               DateTime   @default(now())
  updatedAt               DateTime   @updatedAt
}
```

Міграції (`prisma/migrations/`):
1. `20260807131531_init` — `User`, `UserStatus`, унікальний індекс по `email`.
2. `20260830181500_add_marketing_consent_pending` — додано `marketingConsentPending`.
3. `20260830201500_rename_pending_to_email_verified` — додано `emailVerified`, видалено `marketingConsentPending`.
4. `20260907191500_add_email_verification_sent_at` — додано `emailVerificationSentAt`.

Підсумкова структура міграцій відповідає `schema.prisma` (перевірено вручну); `prisma migrate status` → «Database schema is up to date» ✅.

### Сутності за запитаними темами
| Сутність | Стан |
|---|---|
| **Клієнти** | Частково: роль клієнта фактично виконує `User`. Немає телефону, нотаток, історії візитів, мови, часового поясу 🟠 |
| **Послуги** (тип масажу, тривалість, ціна) | ⚪ відсутні |
| **Спеціалісти** | ⚪ відсутні (ім’я власниці лише захардкоджене в підписі листів) |
| **Розклад / робочі години / винятки** | ⚪ відсутні |
| **Записи на прийом** | ⚪ відсутні |
| **Маркетингові підписки** | 🟠 лише булеве поле `User.marketingConsent` (+ `emailVerified` як фактичне підтвердження) |

### Бізнес-правила для `User` (з `user.service.ts`)
- Email нормалізується до нижнього регістру й обрізаються пробіли (Zod `toLowerCase().trim()`), унікальний на рівні БД.
- `subscribed`: `name = null`, `passwordHash = null`, `marketingConsent = true`, `emailVerified = false` при створенні.
- `registered`: обов’язкові `name` (3–40), пароль (8–25 символів), `marketingConsent` (boolean).
- Перехід `subscribed → registered` можливий через реєстрацію з тим самим email (`upgradeSubscriberToRegistered`). Маркетингова згода при цьому **ніколи не знімається** (`existing || input`).
- Зворотного переходу немає; видалення користувача немає.
- «Підтверджена маркетингова підписка» в коді явно не виділена; фактично це `marketingConsent = true AND emailVerified = true` (саме тоді надсилається лист «підписку підтверджено»).
- Cooldown на відправку листа підтвердження: 60 с (`EMAIL_VERIFICATION_RESEND_COOLDOWN_MS`, `email-verification/constants.ts`) — **застосовується лише до автоматичної відправки**, не до `/resend-verification` (див. розділ 10).

---

## 4. Наявний API

Базовий URL: `http://localhost:3001`. Формат — JSON. **Авторизації немає на жодному ендпоінті.** OpenAPI/Swagger — **відсутній** ⚪.

Загальні відповіді на помилки:
- Помилка валідації Zod → `400 {"message":"Validation failed","errors":[{field, message}]}` ✅
- `AppError` → `{statusCode} {"message", "code"?, ...details}`; якщо в `details` є `retryAfterSeconds`, ставиться заголовок `Retry-After`.
- Будь-яка інша помилка (Prisma, зламаний JSON тощо) → `500 {"message":"internal server error"}` **без логування** ✅ (перевірено на зламаному JSON).
- Невідомий маршрут → стандартний 404 Express ✅.

### Службовий
| Метод і шлях | Призначення | Авторизація | Побічні дії |
|---|---|---|---|
| `POST /api` | Налагоджувальний «ехо»: логує тіло в консоль, повертає `200 {"message":"Data received"}` | Немає | `console.log(req.body)` — **може писати персональні дані в лог**. Схоже на залишок розробки |

### Реєстрація та підтвердження email
| Метод і шлях | Тіло | Призначення | Побічні дії | Стан |
|---|---|---|---|---|
| `POST /api/users` | `{name, email, password, marketingConsent}` | Реєстрація / апгрейд підписника | Створення або оновлення `User`; встановлення `emailVerificationSentAt`; лист підтвердження (синхронно) | 🟡 (валідація ✅) |
| `POST /api/users/resend-verification` | `{email}` (strict) | Повторна відправка листа підтвердження | Оновлення `emailVerificationSentAt`; лист підтвердження | 🟡 |
| `POST /api/users/verify-email` | `{token}` (strict) | Підтвердження email | `emailVerified = true`; якщо `marketingConsent` — лист «підписку підтверджено» | 🟡 (невалідний токен → 400 ✅) |

Коди/статуси відповіді `POST /api/users` (`responses/register.response.ts`):
- `201` + `code: EMAIL_VERIFICATION_SENT` — новий акаунт, лист надіслано;
- `200` + `code: EMAIL_VERIFICATION_SENT` — існуючий (апгрейд або незавершена реєстрація), лист надіслано;
- `200` + `code: EMAIL_VERIFICATION_PENDING` (+`retryAfterSeconds`) — лист уже надсилався раніше;
- `200` `"User created successfully"` — апгрейд підписника з уже підтвердженим email;
- `409` — зареєстрований і підтверджений email;
- `502` — помилка відправки листа (користувач **уже створений** у БД).
- У `data` повертається `PublicUser`: `id, name, email, status, marketingConsent, emailVerified`.

### Відновлення пароля
| Метод і шлях | Тіло | Призначення | Побічні дії | Стан |
|---|---|---|---|---|
| `POST /api/users/forgot-password` | `{email}` (strict) | Запит на скидання | Лист з посиланням (токен 15 хв). Відповіді: `200 PASSWORD_RESET_SENT`, `404 ACCOUNT_NOT_FOUND`, `400 PASSWORD_RESET_UNAVAILABLE`, `502` при збої пошти | 🟡 (strict-валідація ✅) |
| `POST /api/users/reset-password` | `{token, password}` (strict) | Встановлення нового пароля | Оновлення `passwordHash`; якщо email не підтверджений — `emailVerified = true` і, за наявності згоди, лист «підписку підтверджено» | 🟡 (невалідний токен → 400 ✅) |

### Маркетинг
| Метод і шлях | Тіло | Призначення | Побічні дії | Стан |
|---|---|---|---|---|
| `POST /api/users/subscribe` | `{email}` (strict) | Підписка на маркетинг | Новий email → створення `subscribed`-користувача + лист підтвердження email; підтверджений без згоди → `marketingConsent = true` + лист «підписку підтверджено»; `409`, якщо вже підписаний | 🟡 (валідація ✅) |
| `POST /api/users/unsubscribe` | `{token}` (strict) | Відписка | `marketingConsent = false`, лист не надсилається; відповідь `200` | 🟡 (невалідний токен → 400 ✅) |

---

## 5. Реєстрація та авторизація

### Що існує
Реєстрація, підтвердження email, повторна відправка, forgot/reset password. **Вхід (login), видача access/refresh-токенів, cookie-сесії, logout, зміна пароля залогіненим користувачем — відсутні** ⚪. Функція `verifyPassword` (`shared/security/password.ts`) написана, але ніде не викликається.

### Токени дій у листах (`modules/email/tokens/action-token.service.ts`)
- JWT `{userId, purpose}`, `issuer: "massage-backend"`, секрет `ACTION_TOKEN_SECRET`.
- `purpose` і термін дії: `email_verify` — 7 днів, `password_reset` — 15 хв, `marketing_unsubscribe` — 1 рік.
- `verifyToken` перевіряє підпис, issuer, термін і `purpose`; будь-яка помилка → `AppError(400, "Invalid action token")`.
- Токени **без стану**: не зберігаються в БД, **не одноразові**, не відкликаються (у т.ч. після зміни пароля).
- Посилання будуються як `${FRONTEND_URL}/verify-email?token=…`, `/reset-password?token=…`, `/unsubscribe?token=…` — тобто фронтенд має прийняти токен із URL і зробити `POST` на бекенд.

### Сценарій A: реєстрація нового email (`registerUser` → `createPendingUser`)
1. **Запит** `POST /api/users`.
2. **Перевірки**: Zod `createUserSchema` (зайві поля відкидаються, не strict); `findUser({email})` → не знайдено.
3. **БД**: `hashPassword` (bcrypt 12) → `prisma.user.create` зі `status=registered`, `emailVerified=false`.
4. **Побічні дії**: `ensureEmailVerificationSent` → атомарний `updateMany` «claim» (встановлює `emailVerificationSentAt=now`, якщо поле null або старше 60 с) → `emailService.sendEmailVerificationRequest` (Brevo, синхронно).
5. **Відповідь**: `201 EMAIL_VERIFICATION_SENT` + `PublicUser`.
   При збої Brevo → `502`, але користувач і `emailVerificationSentAt` **вже збережені**; повторна реєстрація поверне `200 EMAIL_VERIFICATION_PENDING` без нового листа — відновитися можна лише через `/resend-verification`.

### Сценарій B: реєстрація email, який уже є
- `registered` + `emailVerified=true` → `409`.
- `registered` + не підтверджений → **новий пароль/ім’я ігноруються**; якщо лист ще не надсилався — надсилається, інакше `200 PENDING`. Відповідь містить `PublicUser` (id, ім’я, статус) існуючого акаунта.
- `subscribed` (будь-який стан підтвердження) → `upgradeSubscriberToRegistered`: встановлюються ім’я, пароль, `status=registered`, згода OR-иться. Далі: якщо email не підтверджений і лист ще не надсилався — надсилається; якщо надсилався — `PENDING`; **якщо email уже підтверджений — акаунт одразу стає зареєстрованим з підтвердженим email без жодної перевірки власника** (див. ризик №1 у розділі 10).

### Сценарій C: підтвердження email (`verifyEmailService`)
1. `POST /api/users/verify-email {token}` → strict-валідація.
2. `verifyToken(token, "email_verify")` → `findUser({id})`; немає користувача → 400.
3. Якщо вже підтверджено — нічого не змінюється, `200`.
4. Інакше `emailVerified=true`; якщо `marketingConsent` → `sendSubscriptionConfirmedSafely` (помилка пошти лише логується).
5. `200 {"message":"Email verified successfully"}`.

### Сценарій D: повторна відправка (`resendEmailVerificationService`)
1. `POST /api/users/resend-verification {email}`.
2. Користувача немає або вже підтверджений → `200` з нейтральним повідомленням, `sent:false` (не розкриває існування акаунта).
3. Інакше `markEmailVerificationSendAttempt` (оновлює `emailVerificationSentAt` **без перевірки cooldown**) → лист → `200 {sent:true}`; збій пошти → `502`.
4. Гілка `skipped_cooldown` у сервісі та заголовок `Retry-After` у контролері **недосяжні** — `resendEmailVerificationMail` ніколи не повертає цю причину.

### Сценарій E: відновлення пароля
1. `POST /forgot-password {email}` → немає акаунта → `404 ACCOUNT_NOT_FOUND` (розкриває існування email); `subscribed` або без пароля → `400 PASSWORD_RESET_UNAVAILABLE`; інакше синхронна відправка листа (лімітів частоти немає) → `200 PASSWORD_RESET_SENT`; збій → `502`.
2. `POST /reset-password {token, password}` → `verifyToken(..., "password_reset")` → перевірка `registered` і наявності `passwordHash` → новий хеш → якщо email не підтверджений, він стає підтвердженим (+ лист про підписку, якщо є згода) → `200 {message, emailVerified:true, emailJustVerified}`.
3. Інші сесії не інвалідуються (їх і немає); той самий токен можна використати повторно протягом 15 хв.

### Керування сесіями
⚪ Відсутнє.

---

## 6. Email і комунікації (детально)

### Провайдер і механізм
- **Brevo**, транзакційний API, SDK `@getbrevo/brevo` (`BrevoClient`), `src/modules/email/service/email.service.ts`.
- Конфігурація клієнта: `timeoutInSeconds: 30`, `maxRetries: 3` (повтори — вбудовані в SDK; на які саме помилки SDK робить повтори — ❓, за документацією SDK зазвичай 408/429/5xx).
- Відправник: `EMAIL_FROM_NAME` / `EMAIL_FROM_EMAIL` з env. SMTP, nodemailer, інші провайдери — не використовуються.
- Метод `sendTransactionalEmail` повертає `messageId` Brevo, але **ніхто його не зберігає**.

### Події → листи
| Подія | Функція | Тема (FR) | Шаблон | Помилка відправки |
|---|---|---|---|---|
| Реєстрація / апгрейд / підписка нового email / resend (неверифікований) | `sendEmailVerificationRequest` | «Confirmez votre adresse e-mail» | `emailTemplates.emailVerificationRequest(user, verifyUrl)` | **Блокує**: `AppError 502` (запис у БД уже зроблено) |
| Підтвердження email, якщо `marketingConsent`; reset-password, що підтверджує email, якщо `marketingConsent`; підписка вже підтвердженого користувача | `sendOffersSubscriptionConfirmation` | «Votre inscription aux offres est confirmée» | `emailTemplates.offersSubscriptionConfirmation(user, unsubscribeUrl)` | **Не блокує**: `console.error`, операція успішна (`sendSubscriptionConfirmedSafely`) |
| `forgot-password` | `sendPasswordResetRequest` | «Réinitialisation de votre mot de passe» | `emailTemplates.passwordResetRequest(user, resetUrl)` | **Блокує**: `AppError 502` (змін у БД немає) |

Не існує листів: привітання після реєстрації, підтвердження зміни пароля, підтвердження відписки, будь-які листи бронювання/нагадування, власне маркетингові розсилки ⚪.

### Шаблони (`src/modules/email/templates/email.templates.ts`)
- Три інлайн-HTML-рядки (template literals), мова — французька, табличний макет з інлайн-стилями, підпис спеціалістки та «Massage bien-être» захардкоджені.
- Дані: `user.name` (необов’язково, для «Bonjour {name}») і одне посилання (`verifyUrl` / `unsubscribeUrl` / `resetUrl`).
- **`user.name` вставляється без HTML-екранування** (ризик HTML-ін’єкції у листах, див. розділ 10).
- Немає текстової (plain-text) версії, локалізації, шаблонів Brevo (template ID) чи шаблонізатора.
- Текст шаблону reset згадує «валідний 15 хвилин» — узгоджено з `expiryByPurpose.password_reset = "15m"`.

### Синхронність
Усе **синхронно** всередині HTTP-запиту (з `await`). З урахуванням таймауту 30 с і до 3 повторів запит теоретично може тривати хвилини ❓ (не вимірювалось).

### Помилки, повтори, дублювання
- Помилки Brevo мапляться в `EmailServiceError` (`mapBrevoError`: Unauthorized, TooManyRequests, інші `BrevoError`, невідомі).
- У 502-відповідь потрапляє `error.message` з `EmailServiceError` (наприклад, «Brevo authorization failed. Check BREVO_API_KEY.») — **внутрішня деталь конфігурації віддається клієнту**.
- Власних повторів, outbox-таблиці, черги немає.
- Захист від дублювання:
  - лист підтвердження при автоматичній відправці — атомарний claim у БД + cooldown 60 с (`userRepository.claimEmailVerificationSend`) 🟡;
  - `/resend-verification` — **без обмежень**;
  - `/forgot-password` — **без обмежень**;
  - лист «підписку підтверджено» — може надійтися повторно (напр., verify після reset або паралельні запити) — явного захисту немає.
- Ідемпотентність запитів, rate limiting на рівні HTTP — відсутні ⚪.

### Журнали, вебхуки, статуси доставки
⚪ Відсутні: немає таблиці відправлень, не зберігається `messageId`, немає вебхуків Brevo (bounce, spam complaint, unsubscribe, delivered), немає обробки hard bounce. Логи — лише `console.log("sendTransactionalEmail")`, `console.log("sendEmailVerificationRequest")` і `console.error` при збоях.

### Середовища
У коді **немає розрізнення середовищ** (`NODE_ENV` не використовується). У будь-якому середовищі, де задано `BREVO_API_KEY`, надсилаються реальні листи. Sandbox-режиму, mock-транспорту, перехоплювача (Mailpit/Ethereal) немає ⚪. Як влаштовано production (хостинг, окремі ключі/домен відправника, SPF/DKIM) — ❓.

---

## 7. Маркетингові підписки

### Підписка
- **Без акаунта**: `POST /api/users/subscribe {email}` → створюється `User{status: subscribed, marketingConsent: true, emailVerified: false}` → лист підтвердження email. Після `verify-email` → лист «підписку підтверджено» з посиланням на відписку. Тобто фактично реалізовано **double opt-in** 🟡, але згода записується в `marketingConsent=true` ще **до** підтвердження.
- **Під час реєстрації**: поле `marketingConsent` у тілі `POST /api/users`; лист-підтвердження підписки — після верифікації email.
- **Для вже підтвердженого email без згоди**: той самий `/subscribe` → `marketingConsent=true` одразу + лист «підписку підтверджено». Оскільки автентифікації немає, будь-хто може ввімкнути згоду для чужого підтвердженого email (лист прийде власнику з посиланням на відписку).

### Відписка
- Лише за токеном з листа: `POST /api/users/unsubscribe {token}` → `marketingConsent=false`. Токен дійсний 1 рік, без стану.
- Посилання на відписку є **лише в листі «підписку підтверджено»**. Заголовків `List-Unsubscribe`/`List-Unsubscribe-Post` немає.
- Якщо користувача з `userId` з токена вже немає → `prisma.update` кине помилку → `500` (не 400) 🟡 (з коду).

### Де зберігається статус і докази згоди
- Лише `User.marketingConsent` (boolean) і `User.emailVerified`.
- **Не зберігаються**: час надання/відкликання згоди, джерело (форма підписки чи реєстрація), IP/user-agent, версія тексту згоди, історія змін. Для ЄС/Франції (листи французькою) це може бути важливо для GDPR — ❓ чи потрібно власнику.

### Розділення сервісних і маркетингових листів
- У коді всі листи — «транзакційні» через один метод Brevo; категорій/тегів немає.
- Справжніх маркетингових розсилок **немає взагалі** — є лише лист-підтвердження підписки.
- Синхронізації контактів з Brevo Contacts/списками, кампаній, сегментації — ⚪ відсутні.
- Як планується розсилати акції (Brevo Campaigns з імпортом контактів чи власна логіка) — ❓.

---

## 8. Бронювання та запис на прийом

**Не реалізовано.** ⚪ У схемі БД немає моделей послуг, спеціалістів, розкладу, слотів чи записів; у коді немає відповідних маршрутів, сервісів чи фонових задач. Пошук за ключовими словами (`appointment`, `booking`, `schedule`, `cron`, `queue`) по `src/` нічого не знайшов.

Отже відсутні: обчислення доступності, тривалість послуг, часові пояси (усі `DateTime` у Prisma зберігаються як `TIMESTAMP(3)` без зони), створення/перенесення/скасування записів, захист від подвійного бронювання, нагадування, календарні інтеграції.

---

## 9. Тести та спостережуваність

### Тести
- Автоматизованих тестів **немає**: немає тестового фреймворку в залежностях, немає файлів `*.test.ts`/`*.spec.ts`; `npm test` = `echo "Error: no test specified" && exit 1`.
- Отже **жоден сценарій з БД або поштою не покритий тестами**.

### Перевірки, виконані під час аналізу
Запускались лише дії без запису в БД і без відправки листів.

| Команда / дія | Результат |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | ✅ без помилок |
| `npx prisma validate` | ✅ «The schema … is valid» |
| `npx prisma migrate status` (тільки читання) | ✅ 4 міграції, «Database schema is up to date!»; Prisma повідомляє про доступну 8.0.0-rc |
| `npm test` | ❌ заглушка, exit 1 |
| Локальний запуск `npx tsx src/server.ts` | ✅ стартує на 3001 |
| `POST /api/users/subscribe` зі зламаним JSON | ⚠️ `500 internal server error` (очікувано 400), в лог нічого не записано |
| `POST /api/users/subscribe {"email":"nope"}` | ✅ `400 Validation failed` |
| `POST /api/users/forgot-password` із зайвим полем | ✅ `400` (strict-схема) |
| `POST /api/users` з невалідними полями | ✅ `400` з переліком усіх помилок полів |
| `POST /verify-email`, `/unsubscribe`, `/reset-password` з невалідним токеном | ✅ `400 Invalid action token` |
| `GET /api/users/login`, `GET /api/users` | ✅ `404` (маршрутів немає) |

**Не перевірено** (бо потребує запису в БД та/або реальних листів): успішні сценарії реєстрації, підписки, verify, resend, forgot/reset, unsubscribe; поведінка cooldown; обробка збоїв Brevo; конкурентні запити.

### Логування та обробка помилок
- Логування: лише `console.log`/`console.error`, без рівнів, кореляційних ID, структури. Логера (pino/winston), access-логів (morgan), APM, Sentry — немає ⚪.
- `errorHandler` (`src/middleware/error.middleware.ts`): обробляє `AppError`; усе інше → 500 **без запису в лог** і без урахування `error.status` (через це зламаний JSON дає 500).
- Помилки Prisma (`P2002` унікальність при гонці реєстрацій, `P2025` «запис не знайдено») не мапляться → 500.
- Health-check ендпоінта немає. Graceful shutdown (закриття Prisma) немає.

---

## 10. Прогалини та наступні кроки

### 10.1 Підтверджені проблеми (факти з коду; ✅ — додатково відтворено)

1. **Захоплення облікового запису підписника.** `registerUser` → `upgradeSubscriberToRegistered` (`user.service.ts`) встановлює ім’я й пароль для будь-якого `subscribed`-email без доказу володіння поштою. Якщо email підписника вже підтверджений, акаунт одразу стає `registered` + `emailVerified=true`. Зараз шкода обмежена (входу немає), але після додавання login це пряме захоплення акаунта.
2. **Немає cooldown на `/resend-verification`.** `resendEmailVerificationMail` використовує `markEmailVerificationSendAttempt` без перевірки часу; гілка `skipped_cooldown` у `resendEmailVerificationService` недосяжна. Можна безлімітно слати листи на будь-який незареєстрований email (витрата квоти Brevo, репутація домену).
3. **Немає обмеження частоти на `/forgot-password`** — та сама проблема.
4. **Перелічення акаунтів (user enumeration):** `forgot-password` повертає `404 ACCOUNT_NOT_FOUND` / `400 PASSWORD_RESET_UNAVAILABLE`; `POST /api/users` для існуючого непідтвердженого email повертає `PublicUser` з `id`, ім’ям і статусом; `/subscribe` повертає `409` для вже підписаних.
5. **HTML-ін’єкція в листах:** `user.name` інтерполюється в HTML шаблонів без екранування (`email.templates.ts`).
6. **Зламаний JSON → 500 замість 400** ✅; невідомі помилки не логуються ✅.
7. **Внутрішні повідомлення про помилки пошти віддаються клієнту** (`AppError(502, error.message)` у `helpers.ts` і `forgotPasswordService`).
8. **Токени дій без стану**: reset-токен можна використати повторно протягом 15 хв і він не інвалідується після зміни пароля; verify — 7 днів, unsubscribe — 1 рік.
9. **Повторна реєстрація непідтвердженого `registered`-акаунта ігнорує новий пароль** — якщо користувач забув перший пароль, а лист не дійшов, допомагає лише forgot-password.
10. **Часткова операція при збої пошти**: користувач створюється, `emailVerificationSentAt` встановлюється до відправки; при 502 наступна реєстрація відповідає «PENDING», хоча лист не дійшов.
11. **Гонки**: `findUser` → `create` не атомарні; паралельна реєстрація/підписка одного email → `P2002` → 500.
12. **`/unsubscribe` для видаленого/неіснуючого userId → 500** (`P2025`), а не 400.
13. **Налагоджувальний `POST /api`** логує довільне тіло запиту.
14. **CORS**: якщо `FRONTEND_URL` не задано, `origin: true` (будь-яке джерело) — але без цієї змінної сервер все одно не стартує через `email.service.ts`, тож на практиці CORS обмежено одним origin.

### 10.2 Незавершені сценарії
- Вхід, сесії/токени доступу, logout, зміна пароля, профіль, видалення акаунта (право на забуття).
- Ролі (адміністратор/власниця) і будь-які адмін-ендпоінти.
- Уся доменна частина бронювання.
- Журнал листів, вебхуки Brevo, обробка bounce/complaint.
- Аудит згоди на маркетинг; реальні маркетингові розсилки або синхронізація з Brevo Contacts.
- Тести, CI, production-збірка, health-check, структуроване логування, rate limiting, `helmet`.

### 10.3 Технічні ризики та невеликі зауваження
- Prisma 7 використовує генератор `prisma-client-js`; оновлення до Prisma 8 (доступна RC) може вимагати міграції на `prisma-client` ❓ — потрібно перевірити при оновленні.
- Невикористані залежності/код: `axios`, `createSubscriberSchema`, `userRepository.getAllUsers`, `verifyPassword`, `buildPendingVerificationMeta(user)` (параметр не використовується), застарілі аліаси `EMAIL_VERIFICATION_COOLDOWN_MS`, `unsubscribeTokenSchema`.
- Опечатка в типі `EmailResipient` (`email.types.ts`).
- Застаріла тека `dist/` може ввести в оману.
- Багато `as unknown as Prisma.…`-кастів у `user.repository.ts` приховують помилки типів.

### 10.4 Рекомендовані найближчі кроки для бекенду (рекомендації, не факти)

1. **Тестовий фундамент + безпечний email-транспорт (найвищий пріоритет).**
   Додати тестовий раннер (наприклад, Vitest) і HTTP-тести (supertest) для всіх наявних сценаріїв; винести відправку пошти за інтерфейс із mock/лог-транспортом для dev/test (керування через `NODE_ENV` або окрему змінну). Окрема тестова БД (Neon branch або локальна Postgres). *Чому першим:* зараз жоден сценарій не перевірено, а будь-яка ручна перевірка шле реальні листи.

2. **Виправити підтверджені вади безпеки в наявних потоках.**
   Апгрейд `subscribed → registered` лише після підтвердження поштою (або обнуляти `emailVerified` і вимагати verify); cooldown/rate limit для `/resend-verification` та `/forgot-password` (і загальний `express-rate-limit`); нейтральні відповіді проти enumeration; екранування HTML у шаблонах; одноразові/відкликані reset-токени (наприклад, `passwordChangedAt` або хеш токена в БД); коректні 400 для JSON-помилок, мапінг `P2002/P2025`, логування невідомих помилок. *Чому:* дешево зараз, дорого після появи login і реальних клієнтів.

3. **Автентифікація та ролі.**
   Login, сесії (httpOnly cookie або access+refresh JWT), logout, middleware авторизації, роль адміністратора (власниця) як мінімум. *Чому:* без цього неможливо побудувати жоден захищений ендпоінт бронювання чи адмін-керування.

4. **Доменна модель бронювання (MVP).**
   Моделі `Service` (тривалість, ціна, активність), робочі години/винятки, `Appointment` (статуси, `startsAt/endsAt` в UTC + часовий пояс кабінету), захист від подвійного бронювання на рівні БД (наприклад, exclusion constraint у PostgreSQL або транзакція з блокуванням), ендпоінти доступності/створення/скасування. *Чому:* це головна цінність продукту; вимагає відповідей з розділу «Питання».

5. **Надійна доставка листів.**
   Таблиця журналу відправлень (тип, отримувач, `messageId`, статус), outbox/черга з повторами (наприклад, pg-boss на тій самій Postgres), вебхуки Brevo для bounce/complaint/unsubscribe, `List-Unsubscribe`, аудит згоди (`consentAt`, `source`, `revokedAt`). *Чому:* потрібно до запуску нагадувань про записи та маркетингу; зараз збій Brevo ламає реєстрацію.

---

## Зведена таблиця

| Функціонал | Стан | Де реалізовано | Що не перевірено або відсутнє |
|---|---|---|---|
| Запуск сервера, CORS, JSON-парсинг | ✅ Перевірено | `src/server.ts`, `src/app.ts` | Немає prod-збірки, health-check, порт захардкоджено; зламаний JSON → 500 |
| Валідація вхідних даних (Zod) | ✅ Перевірено | `users/schema/user.schema.ts`, `users/middleware/user.middlewares.ts`, `email/schema`, `email/middleware` | `createUserSchema` не strict (зайві поля мовчки відкидаються) |
| Глобальна обробка помилок | 🟠 Частково | `src/middleware/error.middleware.ts`, `shared/errors/app-error.ts` | Невідомі помилки не логуються; Prisma-помилки й JSON-помилки → 500 |
| Схема БД і міграції | ✅ Перевірено | `prisma/schema.prisma`, `prisma/migrations/*` | Лише модель `User` |
| Реєстрація з паролем | 🟡 Не перевірено | `user.service.ts: registerUser, createPendingUser` | Успішний сценарій, гонки, збій пошти; ризик enumeration |
| Апгрейд підписника до зареєстрованого | 🟠 Частково | `user.service.ts: upgradeSubscriberToRegistered` | Немає доказу володіння email (ризик захоплення) |
| Підтвердження email | 🟡 Не перевірено (невалідний токен ✅) | `user.service.ts: verifyEmailService`, `action-token.service.ts` | Токен багаторазовий, 7 днів |
| Повторна відправка підтвердження | 🟠 Частково | `email-verification/helpers.ts: resendEmailVerificationMail`, `user.service.ts: resendEmailVerificationService` | Cooldown не застосовується; гілка `Retry-After` недосяжна |
| Cooldown автоматичної відправки (60 с) | 🟡 Не перевірено | `user.repository.ts: claimEmailVerificationSend`, `email-verification/constants.ts` | Поведінка під навантаженням |
| Forgot password | 🟡 Не перевірено | `user.service.ts: forgotPasswordService` | Немає rate limit; розкриває існування акаунта |
| Reset password | 🟡 Не перевірено (невалідний токен ✅) | `user.service.ts: resetPasswordService` | Токен не одноразовий, не інвалідується |
| Вхід / сесії / logout | ⚪ Відсутнє | — (`verifyPassword` не використовується) | Усе |
| Ролі та авторизація ендпоінтів | ⚪ Відсутнє | — | Усе |
| Підписка на маркетинг (double opt-in) | 🟡 Не перевірено | `user.service.ts: subscribedToMarketingService, createPendingSubscriber, subscribeVerifiedUserToMarketing` | Аудит згоди відсутній; згода `true` до підтвердження |
| Відписка від маркетингу | 🟡 Не перевірено (невалідний токен ✅) | `user.service.ts: unsubscribeFromMarketingService` | Неіснуючий користувач → 500; немає `List-Unsubscribe` |
| Маркетингові розсилки / Brevo Contacts | ⚪ Відсутнє | — | Усе |
| Відправка листів через Brevo | 🟡 Не перевірено | `email/service/email.service.ts`, `email/errors/email.errors.ts` | Реальна відправка, повтори SDK, таймаути |
| HTML-шаблони листів (FR) | 🟠 Частково | `email/templates/email.templates.ts` | Немає екранування `name`, plain-text версії, локалізації |
| Журнал листів, вебхуки, bounce | ⚪ Відсутнє | — | Усе |
| Розділення середовищ (dev/test/prod) для пошти | ⚪ Відсутнє | — | Усе |
| Послуги, спеціалісти, розклад | ⚪ Відсутнє | — | Усе |
| Записи на прийом, подвійне бронювання, нагадування | ⚪ Відсутнє | — | Усе |
| Фонові задачі / черги / cron | ⚪ Відсутнє | — | Усе |
| OpenAPI / Swagger | ⚪ Відсутнє | — | Усе |
| Автотести | ⚪ Відсутнє | `package.json` (заглушка `test`) | Усе |
| Логування / моніторинг | 🟠 Частково | `console.*` у сервісах | Структурований логер, Sentry, access-логи |
| Rate limiting / helmet | ⚪ Відсутнє | — | Усе |
| Налагоджувальний `POST /api` | ✅ Існує (видно з коду) | `src/app.ts` | Логує тіло запиту; ймовірно, слід видалити |

---

## Питання до власника (відповідей у коді немає)

**Бізнес і ролі**
1. Скільки спеціалістів працює зараз і чи планується більше одного? Чи потрібна модель «спеціаліст» окремо від адміністратора?
2. Хто керує системою (розклад, послуги, клієнти) — лише власниця? Чи потрібні інші ролі?
3. Чи можна бронювати без реєстрації (гостьовий запис лише з email/телефоном), чи обов’язковий акаунт?
4. Чи потрібен телефон клієнта, SMS або WhatsApp-нагадування?

**Бронювання**
5. Перелік послуг: тривалість, ціни, перерви між сеансами, чи бувають варіанти тривалості для однієї послуги?
6. Робочі години, вихідні, відпустки; мінімальний час до запису; горизонт бронювання наперед?
7. Політика скасування/перенесення (дедлайни, штрафи)? Чи потрібна передоплата/онлайн-оплата?
8. Часовий пояс кабінету (ймовірно, Франція — `Europe/Paris`?) і чи бувають клієнти з інших поясів?
9. Чи потрібна синхронізація з Google Calendar або іншим календарем?

**Email і маркетинг**
10. Чи є окремі ключі Brevo / домен відправника для dev і production? Чи налаштовані SPF/DKIM/DMARC?
11. Як планується розсилати маркетинг: через Brevo Campaigns (потрібна синхронізація контактів) чи власними засобами?
12. Чи потрібно зберігати докази згоди (дата, джерело, текст згоди) для GDPR?
13. Чи потрібні листи інтерфейсу лише французькою чи кількома мовами?
14. Чи потрібні нагадування про візит і за скільки часу?

**Інфраструктура**
15. Де планується хостинг бекенду (Vercel, Render, Fly, VPS…)? Від цього залежить вибір черг/cron.
16. Чи є окрема Neon-гілка для розробки, чи локально використовується production-БД?
17. Чи є вже реальні користувачі/підписники в БД (важливо для міграцій і виправлення ризику №1)?
18. Чи прийнятне рішення з JWT у cookie для фронтенду, і чи фронтенд буде на тому ж домені (SameSite/CORS)?
