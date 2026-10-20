# ARCHITECTURE_READINESS — Massage-backend → AWS (ECS Fargate)

> Аналітичний звіт першого етапу. Код, залежності, міграції, Git-гілки й хмарні ресурси **не змінювались**.
> Дата: 2026-10-19. Гілка `main`, commit `a3cd0ad944fd3de8ee62575de88c6ed1aa9ed3cd`.
> Незакомічені зміни: лише неперевірений (untracked) `BACKEND_HANDOFF.md` (попередній звіт). Код з моменту handoff не змінювався: SHA той самий, `git status` чистий щодо `src/`, `prisma/` і конфігурацій.
> Звіт самодостатній і призначений для узгодження плану з іншим AI-помічником.

## Позначки достовірності

| Позначка | Значення |
|---|---|
| **[К]** | Підтверджено читанням коду/конфігурації |
| **[В]** | Перевірено виконанням локально (команди в розділі 6) |
| **[Р]** | Рекомендація |
| **[?]** | Невідомо / потребує уточнення або перевірки |
| **[Д]** | Загальновідома поведінка інструменту/платформи з документації; у цьому репозиторії не перевірялась |

---

## 1. Короткий висновок

1. **Поточний код — це лише модуль «користувачі + email»** (реєстрація з паролем, підписка на маркетинг, verify/reset за JWT-посиланнями, Brevo). Бронювання, ролей, входу, черг, outbox немає [К]. Майже вся бізнес-логіка, що існує, **замінюється на Firebase Authentication**. Тому її не варто «доводити до production»: достатньо прибрати її з інтернет-доступу й перенести придатні частини (Brevo-клієнт, мапінг помилок, шаблони, атомарний «claim»-патерн, Zod-валідацію, `AppError`).
2. **Як контейнер проєкт поки не готовий, але блокери невеликі й локальні** [В]:
   - порт захардкоджено (`3001`, `PORT` ігнорується);
   - немає health-check;
   - на `SIGTERM` процес завершується миттєво, без дочікування запитів;
   - немає production-скриптів `build`/`start`;
   - невідомі помилки не логуються;
   - немає `.dockerignore`, тож `.env` потрапить в образ при `COPY . .` [К];
   - `prisma.config.ts` не завантажується без `DATABASE_URL` — це заважає `prisma generate` під час збірки образу без секретів [В].
   Збірка `tsc` і запуск скомпільованого коду звичайним `node` працюють [В]. Стану в пам'яті, який заважав би кільком реплікам, немає [К].
3. **Знайдено дві конкретні технічні невідповідності погодженій архітектурі. Вибір технологій вони не змінюють:**
   - **Neon-адаптер і локальний PostgreSQL.** Runtime використовує `@prisma/adapter-neon` (`src/shared/database/prisma.ts`) [К]. Він працює через serverless-драйвер Neon по WebSocket і не підключається до звичайного PostgreSQL у Docker без додаткового проксі [Д]. **[Р]** Перейти на `@prisma/adapter-pg` (TCP) і для Neon, і локально: для довготривалих Fargate-задач це природніше.
   - **Prisma-генератор у workspace.** Генератор `prisma-client-js` пише клієнт у спільний `node_modules/.prisma/client` [В]. У npm workspaces зі спільно встановленим (hoisted) `@prisma/client` два сервіси перезапишуть клієнти один одного [Д]. **[Р]** Новий генератор `prisma-client` з окремим `output` у кожному сервісі.
4. **Регіон Neon — `aws eu-west-2` (Лондон)**, з'єднання йде через pooler-endpoint [В; визначено з імені хоста локально, без мережевих запитів]. AWS-регіон обрано `eu-west-3` (Париж). Це не блокер, але означає міжрегіональну затримку, дані у Великій Британії, а не в ЄС, і необхідність окремого direct-endpoint для міграцій [Д]. Оскільки БД порожня, регіон Neon-проєктів для staging/production варто вирішити **до** їх створення [?].
5. **Neon не можна обмежити на мережевому рівні через Terraform.** Fargate-задачі з публічними IP отримують динамічні адреси, тож IP-allowlist у Neon не застосовний [Д]. Захист БД забезпечуватимуть TLS, окремі облікові дані та права ролей. Це наслідок погодженого рішення «без NAT»: варто прийняти його свідомо.
6. **Рекомендований порядок трохи відрізняється від початкового:** мінімальні runtime-виправлення → **перенесення в npm workspace `services/booking`** (зараз це дешево, і від структури залежать шляхи Dockerfile та CI) → Docker/Compose → CI → Terraform bootstrap + staging + CD → Firebase/User → Notifications. Обґрунтування — у розділі 4.

---

## 2. Таблиця компонентів

Пріоритет: **P0** — до інтернет-доступного staging; **P1** — до першого корисного функціоналу; **P2** — пізніше.

| Компонент | Поточний стан | Файл/функція | Необхідна зміна | Пріоритет |
|---|---|---|---|---|
| Порт і адреса прослуховування | `const port = 3001`; `PORT` ігнорується [В]; слухає всі інтерфейси (`*:3001`, IPv6 dual-stack) [В] | `src/server.ts` | `PORT` з конфігурації (за замовчуванням 3000/3001); залишити прослуховування на всіх інтерфейсах | P0 |
| Health-check | Відсутній; `GET /health` → 404 [В] | `src/app.ts` | `GET /health/live` без БД (для ALB) і `GET /health/ready` з легким `SELECT 1` (для smoke-тесту); у відповіді — версія/git SHA | P0 |
| Graceful shutdown | Немає обробника; `SIGTERM` → миттєвий вихід, код 143 [В]. Якщо Node працює як PID 1 без обробника, `SIGTERM` ігнорується, і ECS вб'є задачу лише після `stopTimeout` [Д] | `src/server.ts` | Обробник `SIGTERM/SIGINT`: `server.close()`, тайм-аут, `prisma.$disconnect()`; у task definition — `initProcessEnabled: true`; узгодити з deregistration delay ALB | P0 |
| Обробка помилок | Невідомі помилки → 500 без логування [В]; зламаний JSON → 500 замість 400 [В]; Prisma-помилки (`P2002`/`P2025`) не мапляться [К] | `src/middleware/error.middleware.ts: errorHandler` | Логувати невідомі помилки; враховувати `err.status`/`type` від body-parser; мапити `P2002`→409, `P2025`→404/400 | P0 |
| Логування | Лише `console.*`; налагоджувальні `console.log` у сервісі пошти [К] | `email.service.ts`, `helpers.ts`, `user.service.ts` | Структурований JSON-логер у stdout (наприклад, pino) → CloudWatch Logs; request-id; без PII та тіл запитів | P0 |
| Налагоджувальний маршрут | `POST /api` логує довільне тіло запиту [К] | `src/app.ts` | Видалити | P0 |
| Конфігурація | `process.env` читається в 4 модулях; fail-fast під час імпорту [В]; `import "dotenv/config"` у runtime-коді [К] | `server.ts`, `prisma.ts`, `email.service.ts`, `action-token.service.ts`, `app.ts` | Один модуль конфігурації з Zod-схемою, що валідується на старті; dotenv лише для локальної розробки | P0 |
| Збірка | Скрипти лише `start` (`tsx watch`) і `typecheck`; `tsc` збирає в `dist/` [В]; скомпільований код працює під `node` [В]; у `dist/` лежить застаріла збірка (у `.gitignore`) [К] | `package.json`, `tsconfig.json` | Скрипти `build`, `start` (`node dist/server.js`), `dev`, `test`, `lint`; `engines.node` | P0 |
| `.dockerignore` | Відсутній [К]; поряд лежать `.env`, `.neon`, `.agents`, `.claude`, `node_modules`, `dist` | — | Створити (на етапі Docker) | P0 |
| Prisma config без секретів | `env("DATABASE_URL")` кидає `PrismaConfigEnvError`, якщо змінну не задано [В на `prisma validate`; для `generate` — [Д]] | `prisma.config.ts` | Для `generate` не вимагати URL (fallback або окремий конфіг), або передавати фіктивний URL у build-стадії | P0 |
| Prisma-генератор | `prisma-client-js`, вихід у `node_modules/.prisma/client`, Prisma 7.9.1, query compiler (WASM) без Rust-рушія запитів [В] | `prisma/schema.prisma` | `provider = "prisma-client"` з `output` усередині сервісу | P1 (разом із workspace) |
| Драйвер БД | `PrismaNeon` (`@neondatabase/serverless` 1.1.0, WebSocket) [К/В] | `src/shared/database/prisma.ts` | `@prisma/adapter-pg` + `pg` для Neon і локального Postgres; TLS; ліміт пулу | P0 (до Compose) |
| Схеми БД | Усе в `public` (схеми не вказані) [К]; 4 міграції для `User` [К] | `prisma/schema.prisma`, `prisma/migrations/*` | Схема `booking`; окремі ролі migrator/runtime; рішення щодо історії міграцій — питання до власника | P1 |
| Модель `User` | email обов'язковий і унікальний; `passwordHash`; `status: subscribed/registered` змішує тип акаунта й маркетинг [К] | `schema.prisma` | Нова модель: `User`, `AuthIdentity` (Firebase UID), `role`, `accountType`, окремо `Profile` і `MarketingSubscription` (розділ 3.3) | P1 |
| Паролі / verify / reset | bcrypt, JWT action-токени, ендпоінти `/`, `/forgot-password`, `/reset-password`, `/verify-email`, `/resend-verification` [К] | `user.service.ts`, `password.ts`, `action-token.service.ts` | Замінити на Firebase; до заміни — **не відкривати в інтернет-staging** | P0 (вимкнути) / P1 (замінити) |
| Підписка на маркетинг | Булеве `marketingConsent` у `User`; double opt-in через verify email [К] | `subscribedToMarketingService`, `unsubscribeFromMarketingService` | Окрема сутність з доказами згоди; токен відписки залишити | P1 |
| Brevo-клієнт | `BrevoClient` (timeout 30 с, maxRetries 3), `mapBrevoError`, повертається `messageId`, але не зберігається [К] | `email/service/email.service.ts`, `email/errors/email.errors.ts` | Перенести в Notifications як адаптер провайдера; зберігати `messageId` | P1 |
| Шаблони листів | 3 HTML-шаблони французькою; `user.name` без екранування [К]; залежність від типу `User` з Prisma [К] | `email/templates/email.templates.ts` | Екранування; вхід — DTO контракту, а не `User` | P1 |
| Генерація auth-посилань | Усередині email-модуля (`buildActionUrl` → `actionTokenService.createToken`) [К] | `email.service.ts` | Межа: посилання генерує власник (Booking/Firebase), Notifications лише доставляє | P1 |
| Синхронна відправка | Лист надсилається всередині HTTP-запиту; збій дає 502 після запису в БД [К] | `helpers.ts: sendEmailVerification`, `forgotPasswordService` | Outbox → SQS → worker | P1 |
| Rate limiting | Немає; `/resend-verification` і `/forgot-password` без обмежень [К]; `trust proxy` не налаштовано [К] | `helpers.ts: resendEmailVerificationMail` | Якщо legacy-ендпоінти залишаються відкритими — обмеження частоти + `trust proxy` за ALB; інакше вимкнути їх | P0 |
| Стан у пам'яті | Немає; cooldown зберігається в БД [К] | `user.repository.ts: claimEmailVerificationSend` | — (патерн атомарного claim придатний для повторного використання) | — |
| Тести | Немає; `npm test` = заглушка з exit 1 [В] | `package.json` | Vitest + supertest; інтеграційні тести на тимчасовому Postgres | P0 (для CI) |
| Lint | Не налаштовано [К] | — | ESLint (flat config) + typescript-eslint | P0 (для CI) |
| Невикористане | `axios`, `createSubscriberSchema`, `getAllUsers`, `verifyPassword`, застарілі аліаси [К] | різні | Прибрати під час перебудови | P2 |
| Docker / Compose / CI / Terraform | Відсутні [К] | — | Розділи 4–5 | P0 |

---

## 3. Детальний аналіз

### 3.1 Поточний репозиторій

- **Інструкції репозиторію:** `README`, `CLAUDE.md`, `AGENTS.md` і `.github/` відсутні [К]. У `.agents/skills/` лежать довідкові Prisma-skills (у `.gitignore`), правил проєкту там немає [К].
- **Пакетний менеджер:** npm, `package-lock.json` lockfileVersion 3 [В]. `npm ls` без помилок, prod-дерево цілісне [В].
- **Node.js:** локально v24.21.0 [В]. `engines` у `package.json` не задано [К]. Prisma 7.9.1 вимагає `^20.19 || ^22.12 || >=24.0` [В]. **[Р]** Node 24 LTS в образі та `engines`.
- **TypeScript/ESM:** `"type": "module"`, `module/moduleResolution: NodeNext`, `verbatimModuleSyntax`, strict-режим [К]. Імпорти з суфіксом `.js` [К]. `tsc --noEmit` і повна збірка проходять [В].
- **Нативні модулі:** лише `bcrypt` з prebuild-збірками для linux-x64/arm64, glibc і musl [В]. Після переходу на Firebase bcrypt не потрібен [Р]. `esbuild` і `fsevents` — лише для dev.
- **Реально реалізовані модулі:** `users` (7 POST-ендпоінтів) і `email` (Brevo, 3 шаблони, JWT action-токени) [К]. Детальний опис — у `BACKEND_HANDOFF.md`, розділи 4–7.
- **Відмінності від handoff:** у коді змін немає (той самий commit). Нові факти цього звіту:
  - регіон Neon і pooler-endpoint;
  - поведінка `PORT` і `SIGTERM`;
  - запуск скомпільованої збірки;
  - Prisma config без `DATABASE_URL`;
  - відсутність `.dockerignore`;
  - тип генератора та шлях виводу Prisma-клієнта;
  - 500 без логування при недоступній БД.

### 3.2 Готовність до контейнеризації

**Факти:**
- Скомпільований `dist/server.js` працює під звичайним `node` (без `tsx`) [В]. Named-імпорти з CommonJS-пакета `@prisma/client` (`PrismaClient`, `UserStatus`) у runtime ESM працюють [В].
- Prisma 7 генерує WASM-компілятор запитів (`query_compiler_fast_bg.wasm`) без нативного рушія запитів [В]. Тому для runtime-образу не потрібні специфічні для ОС бінарні рушії. **Міграціям потрібен `prisma` CLI (devDependency) і його schema engine** [Д] — це враховано в стратегії образів нижче.
- Стан між запитами в пам'яті не зберігається [К]. Cooldown, статуси й токени зберігаються в БД або токени не мають стану [К]. Кілька реплік — безпечно.
- Процес падає на старті, якщо немає `BREVO_API_KEY`, `EMAIL_FROM_*`, `ACTION_TOKEN_SECRET`, `FRONTEND_URL` чи `DATABASE_URL` [В]. Для ECS це прийнятно: задача не пройде health-check, і спрацює deployment circuit breaker [Д].
- Звернення до недоступної БД → 500 приблизно за 0,13 с, у лог нічого не потрапляє [В].
- Змінні середовища, які зараз читає код [К]: `DATABASE_URL`, `BREVO_API_KEY`, `EMAIL_FROM_NAME`, `EMAIL_FROM_EMAIL`, `ACTION_TOKEN_SECRET`, `FRONTEND_URL`.
- Express не налаштовано на `trust proxy` [К]. За ALB `req.ip` буде адресою балансувальника, що важливо для rate limiting і логів [Д].
- **Потреби в CPU/RAM не вимірювались.** [Р] Почати з мінімальних розмірів Fargate-задачі та скоригувати за метриками CloudWatch після навантажувальної перевірки.

**[Р] Стратегія Docker-збірки** (реалізація — на етапі 3):
- Базовий образ `node:24-bookworm-slim` (glibc; менше несподіванок, ніж з musl). Запуск від користувача `node`.
- Багатоетапна збірка (multi-stage) з одного `Dockerfile` для кожного сервісу:
  1. `deps` — `npm ci` за спільним `package-lock.json` (workspaces) з кешуванням;
  2. `build` — `prisma generate` (з фіктивним `DATABASE_URL` або конфігом, що не вимагає URL) + `tsc`;
  3. `runtime` — лише production-залежності, `dist/`, згенерований клієнт; `CMD ["node","dist/server.js"]`;
  4. `migrate` — окрема ціль (target) з `prisma` CLI, `schema.prisma` і `migrations/`; команда `prisma migrate deploy`.
- Обидві цілі збираються один раз на commit. Їхні digest передаються в staging, а потім у production без повторної збірки.
- Секретів під час збірки немає; `.dockerignore` виключає `.env*`, `.neon`, `.agents`, `.claude`, `.windsurf`, `node_modules`, `dist`, `.git`.
- `HEALTHCHECK` в образі не потрібен: перевірку виконує ALB [Р].

**[Р] Docker Compose (локально):**
- `postgres` (офіційний образ, версію узгодити з Neon — [?] версія Postgres у Neon невідома без запиту);
- init-скрипт, що створює схеми `booking`/`notifications` і ролі `*_migrator`/`*_app`, як у хмарі;
- `booking-api`; пізніше — `notifications-worker`;
- для SQS — LocalStack або ElasticMQ ([Р] ElasticMQ легший, якщо потрібен лише SQS);
- пошта — адаптер-заглушка (лог або Mailpit), **без реального Brevo**.

### 3.3 Prisma та PostgreSQL

**Поточний стан [К/В]:** одна модель `User`, enum `UserStatus`, 4 міграції в схемі `public`. Генератор `prisma-client-js`, Prisma 7.9.1, `prisma.config.ts` з `env("DATABASE_URL")`, runtime-адаптер `PrismaNeon`.

**Neon без зовнішніх запитів [В]:** з імені хоста в `DATABASE_URL`, розібраного локально, визначено:
- хмара/регіон: `aws eu-west-2`;
- використовується pooler-endpoint (`-pooler`);
- параметри рядка підключення: `sslmode`, `channel_binding` (лише назви, без значень).

Невідомо [?]:
- версія Postgres і тарифний план;
- autosuspend і ліміти compute;
- чи є гілки (branches) та окремі ролі.

`.neon` — локальний файл ініціалізації Neon CLI; його вміст не розкривається.

**[Д] Застереження:** `prisma migrate deploy` використовує advisory lock. Neon рекомендує виконувати міграції через **direct (не pooler) endpoint**. Отже, migrate-задача і runtime матимуть різні рядки підключення.

**[Р] Ізоляція сервісів у одній БД на середовище:**

| Рівень | Механізм |
|---|---|
| Схема | `booking`, `notifications` (пізніше `ai`, `payments`). Схеми створюються bootstrap-скриптом адміністратора, а не міграціями сервісів |
| Ролі | Для кожного сервісу: `<svc>_migrator` — власник своєї схеми, має право DDL лише в ній; `<svc>_app` — `USAGE` на схему і DML на таблиці (через `ALTER DEFAULT PRIVILEGES`). Прав на чужі схеми немає. `REVOKE CREATE ON SCHEMA public FROM PUBLIC` |
| Prisma-клієнт | Окремий `schema.prisma` і `prisma.config.ts` у кожному сервісі; генератор `prisma-client` з `output` всередині сервісу; спільного Prisma-пакета немає |
| Таблиця історії міграцій | `_prisma_migrations` у власній схемі сервісу. Конкретний механізм прив'язки до схеми в Prisma 7 + driver adapter (параметр `schema` у URL, опція адаптера `schema`, `search_path` ролі) **потрібно перевірити на першому етапі** [?] |
| Захист від зміни чужої схеми | Основний — права ролі migrator у БД: міграція, що чіпає чужу схему, впаде. Додатково — CI-перевірка, що SQL міграцій сервісу не згадує інших схем |
| Міжсервісні посилання | `userId` — звичайна колонка `uuid` без FK; дані — через API або події |

**Локальний PostgreSQL:** потрібні `@prisma/adapter-pg`, рядок підключення через змінну середовища і init-скрипт зі схемами та ролями. У CI — той самий init-скрипт для service-контейнера Postgres.

**Історія міграцій.** Чотири наявні міграції створюють `public."User"` з парольною моделлю, яка повністю змінюється. **[Р]** Почати історію `services/booking/prisma/migrations` з нової базової міграції в схемі `booking`, а старі міграції зберегти в Git-історії (або в архівній теці, не підключеній до Prisma). Це рішення **потребує явного погодження власника**. Порожня БД не є підставою робити це автоматично.

### 3.4 User та Firebase

**Замінюється [К → Р]:**
- `passwordHash`, `src/shared/security/password.ts`, залежність `bcrypt`;
- `registerUser`, `createPendingUser`, `upgradeSubscriberToRegistered` (парольна частина);
- `forgotPasswordService`, `resetPasswordService` та ендпоінти `/forgot-password`, `/reset-password`;
- `verifyEmailService`, `resendEmailVerificationService`, `/verify-email`, `/resend-verification` для акаунтів: підтвердження email бере на себе Firebase, а джерелом істини стає claim `email_verified` у перевіреному ID-токені;
- action-токени `email_verify`, `password_reset`;
- поля `emailVerified` і `emailVerificationSentAt` у `User` (як джерело істини).

**Залишається / переноситься:**
- шар валідації Zod, `AppError` і `errorHandler` (після виправлень), структура route → controller → service → repository;
- атомарний claim через `updateMany` з умовою — як патерн для outbox і доставки;
- токен `marketing_unsubscribe` і логіка double opt-in — у новій сутності підписки;
- Brevo-адаптер і шаблони — переходять у Notifications.

**[Р] Модель (Booking, схема `booking`):**

| Сутність | Призначення | Ключові поля |
|---|---|---|
| `User` | Внутрішній суб'єкт; існує й для анонімного відвідувача | `id (uuid)`, `accountType: guest\|customer`, `role: client\|admin` (розширюється), `mergedIntoUserId?`, `createdAt` |
| `AuthIdentity` | Перевірений зв'язок із Firebase | `firebaseUid UNIQUE`, `userId`, `provider` (anonymous, password, google…), `email?`, `emailVerified`, `linkedAt`, `lastSeenAt` |
| `Profile` | Дані клієнта, потрібні для бронювання | `userId PK`, `displayName`, `phone?`, `locale`, `timezone?` |
| `MarketingSubscription` | Окремо від акаунта входу | `email` (нормалізований, UNIQUE), `userId?`, `status: pending\|confirmed\|unsubscribed`, `consentAt`, `consentSource`, `consentTextVersion`, `confirmedAt`, `unsubscribedAt` |

Принципи:
- email у `User` більше не обов'язковий і не унікальний: у гостя email немає;
- роль і тип акаунта — окремі поля;
- роль визначає лише сервер, ніколи не клієнт.

**[Р] Сценарії автентифікації:**
1. **Кожен запит:** `firebase-admin.verifyIdToken` → `uid` → пошук `AuthIdentity` → внутрішній `User`. `userId`, роль і статус із тіла запиту ігноруються.
2. **Перший візит гостя:** клієнт входить анонімно у Firebase → `POST /me/session` (ідемпотентно) створює `User(guest)` і `AuthIdentity(anonymous)`.
3. **Прив'язка способу входу до гостя** (`linkWithCredential` у Firebase): UID **не змінюється** [Д] → Booking оновлює `AuthIdentity` (provider, email) і `accountType = customer`. `User.id` залишається тим самим, тому облік AI не скидається.
4. **Вхід гостя в уже наявний акаунт:** Firebase видає **інший UID** [Д] → це два різних `User`. Потрібна явна політика злиття: `mergedIntoUserId`, перенесення або агрегування AI-обліку за правилом власника. Окремий ендпоінт і окреме рішення [?].
5. **Бронювання** дозволене лише `accountType = customer` з перевіреним входом. Гість отримує 403.

**[Р] Порядок переходу:**
1. Вимкнути legacy-ендпоінти на публічному staging (або не монтувати їх).
2. Нова схема `booking` і модель (`User`, `AuthIdentity`, `Profile`).
3. Middleware перевірки Firebase-токена + `POST /me/session`, `GET /me`.
4. `MarketingSubscription` з підпискою, підтвердженням і відпискою (листи — тимчасово через наявний синхронний адаптер або одразу через Notifications).
5. Видалити парольний код.
6. Окремий дизайн-документ: Firebase auth-листи через Brevo.

### 3.5 Brevo та Notifications

**Повторно використовується [К]:**
- конфігурація `BrevoClient` (`timeoutInSeconds`, `maxRetries`);
- `sendTransactionalEmail` (повертає `messageId`);
- `mapBrevoError` і `EmailServiceError` (розширити класифікацією: тимчасова / постійна помилка);
- HTML-шаблони (після екранування та переходу на DTO).

**Залежності, які потрібно розірвати [К]:**
- шаблони й `emailService.*` приймають Prisma-тип `User` (`import type { User } from "@prisma/client"`);
- `buildActionUrl` усередині email-модуля створює JWT-посилання через `actionTokenService`, тобто генерує бізнес-посилання замість того, щоб лише доставляти лист;
- модуль читає `FRONTEND_URL` і падає на старті без нього;
- виклики з `users/email-verification/helpers.ts` та `user.service.ts` синхронні.

**[Р] Межа відповідальності:**
- **Сервіс-власник** (Booking; пізніше Payments) вирішує, *що* і *кому* надіслати. Він генерує посилання (Firebase Admin `generate*Link` або власний токен відписки) і записує в **outbox** у тій самій транзакції повідомлення: тип, отримувач, дані шаблону, `idempotencyKey`, `expiresAt`.
- **Relay** публікує outbox у SQS. Для старту — фоновий цикл у процесі `booking-api` з `FOR UPDATE SKIP LOCKED`, безпечний для кількох реплік. Пізніше — за потреби окрема задача.
- **Notifications worker:**
  1. читає SQS (long polling);
  2. `INSERT` у `notifications.delivery` з `UNIQUE(idempotency_key)` — захист від дублів;
  3. перевіряє актуальність: `expiresAt`, suppression list, для маркетингу — актуальність згоди;
  4. рендерить шаблон і надсилає;
  5. зберігає `brevoMessageId` і статус `sent`/`failed`/`suppressed`.
  Постійні помилки (4xx, крім 429) — без повторів; тимчасові — повтор через visibility timeout; після `maxReceiveCount` повідомлення йде в DLQ.
- **Webhook Brevo** — окремий HTTP-обробник у Notifications. Він потрібен лише для статусів доставки, bounce і скарг на спам, тож **на першому етапі Notifications може бути лише worker без вхідних правил**.

**Де потрібні ідемпотентність і повторна перевірка:**

| Місце | Чому |
|---|---|
| Створення outbox-запису | Унікальний ключ бізнес-події (наприклад, `subscription-confirm:<subscriptionId>`) — повтори HTTP-запиту не створюють дублікат |
| Relay → SQS | Доставка at-least-once; дублікати очікувані й відсікаються на рівні worker |
| Worker | `UNIQUE(idempotency_key)` + атомарна зміна статусу. Падіння між успіхом Brevo і записом статусу може дати дублікат — ризик прийнятний, але його треба задокументувати [Д] |
| Перед відправкою | `expiresAt` для auth-посилань; актуальна згода для маркетингу. Notifications не читає таблиці Booking, тому згода передається в повідомленні (з версією) або перевіряється через Booking API [?] |
| Webhook | Дедуплікація подій Brevo, перевірка автентичності запиту (механізм підпису/автентифікації webhook у Brevo потрібно уточнити [?]) |

**Чутливі дані.** Auth-посилання в outbox, SQS і журналі фактично є облікові дані. **[Р]**
- Не логувати payload.
- У журналі доставки зберігати посилання лише в редагованому вигляді.
- Шифрування SQS (SSE) увімкнене.
- Короткий `expiresAt`.

**Відомі проблеми поточного коду, що блокують публічний запуск [К]:**
1. Немає rate limit на `/resend-verification` і `/forgot-password`: через публічний staging з реальним ключем Brevo можна розсилати спам.
2. Неекранований `user.name` у HTML-листах.
3. Внутрішні повідомлення помилок Brevo повертаються клієнту в 502 (`helpers.ts: sendEmailVerification`, `forgotPasswordService`).
4. Захоплення акаунта підписника через `upgradeSubscriberToRegistered`.
5. Перелічення акаунтів (user enumeration) у `/forgot-password` і реєстрації.
6. Синхронна відправка: збій Brevo лишає частково виконану операцію.

Пункти 1, 4 і 5 зникають, якщо legacy-ендпоінти не публікуються, а потім замінюються на Firebase.

---

## 4. Запропонована структура репозиторію

**[Р]** npm workspaces (без Nx/Turborepo — на цьому розмірі вони не потрібні):

```
Massage-backend/
├─ package.json              # "workspaces": ["services/*", "packages/*"], спільні dev-скрипти
├─ package-lock.json         # один lock-файл
├─ tsconfig.base.json
├─ eslint.config.js
├─ docker-compose.yml
├─ docker/postgres/init/     # створення схем і ролей (як у хмарі)
├─ services/
│  ├─ booking/
│  │  ├─ package.json        # залежить від @massage/config, @massage/logger, @massage/contracts
│  │  ├─ Dockerfile          # цілі: runtime, migrate
│  │  ├─ prisma.config.ts
│  │  ├─ prisma/schema.prisma            # лише схема booking
│  │  ├─ prisma/migrations/
│  │  └─ src/
│  │     ├─ server.ts, app.ts
│  │     ├─ generated/prisma/            # output генератора prisma-client (у .gitignore)
│  │     ├─ modules/{identity,users,marketing,catalog,schedule,availability,bookings}/
│  │     └─ outbox/                      # запис і relay у SQS
│  └─ notifications/                     # з'являється на етапі Notifications
│     ├─ package.json, Dockerfile, prisma/…  # лише схема notifications
│     └─ src/
│        ├─ worker.ts                    # SQS consumer (окремий ECS service без вхідних правил)
│        ├─ http.ts                      # health + webhook Brevo (коли знадобиться)
│        ├─ providers/brevo/             # перенесений адаптер
│        └─ templates/
├─ packages/
│  ├─ config/        # завантаження та Zod-валідація env; без доступу до БД
│  ├─ logger/        # pino + request-id
│  ├─ http-kit/      # errorHandler, health-роути, graceful shutdown
│  └─ contracts/     # версіоновані Zod-схеми повідомлень (NotificationRequest v1 тощо)
├─ infra/
│  ├─ bootstrap/     # state backend, GitHub OIDC provider, ECR-репозиторії (спільні для акаунта)
│  ├─ modules/       # network, alb, ecs-service, sqs-queue, …
│  └─ envs/
│     ├─ staging/    # окремий state, ролі, секрети
│     └─ production/
└─ .github/workflows/  # ci.yml, deploy-staging.yml, promote-production.yml, terraform-*.yml
```

**Майбутнє розміщення (не створювати зараз):**
- `services/ai/` — власна схема `ai`; доступ до бронювання лише через Booking API;
- `services/payments/` — власна схема `payments`; webhook Stripe; запити на листи через `contracts` → outbox → SQS;
- `services/mcp-adapter/` — адаптер до Booking API для каналу ChatGPT.

Правило: пакети в `packages/` **не імпортують Prisma і не мають доступу до БД**. `contracts` містить лише схеми повідомлень і API.

---

## 5. Послідовність реалізаційних етапів

Чому порядок змінено:
- перенесення в `services/booking` поставлено **до** Docker/CI, бо шляхи в Dockerfile, Compose і workflow залежать від структури, а зараз код малий і перенесення дешеве;
- заміну Neon-адаптера на `adapter-pg` поставлено **до** Compose, бо інакше локальний Postgres не запрацює;
- Firebase-перебудову поставлено **після** першого деплою, щоб інфраструктура перевірялась на простому сервісі.

| # | Етап | Залежить від | Обсяг | Критерії завершення |
|---|---|---|---|---|
| 1 | **Runtime-готовність** | — | `PORT`/конфіг-модуль (Zod); `/health/live`, `/health/ready`; graceful shutdown; виправлення `errorHandler` (400 для JSON, логування, мапінг Prisma); pino-логер; видалення `POST /api`; скрипти `build/start/dev/test/lint`; `engines`; Vitest + supertest; ESLint | — | `npm run build && node dist/server.js` слухає `PORT`; тести на health, 400 для зламаного JSON, `SIGTERM` (завершення з дочікуванням запиту) зелені; lint і typecheck зелені; бізнес-логіка не змінена |
| 2 | **Workspace і перенесення** | 1 | Root `package.json` з workspaces; `services/booking` (перенесення `src/`, `prisma/`); `packages/config`, `logger`, `http-kit`; `tsconfig.base.json`; генератор `prisma-client` з `output` | 1 | `npm ci && npm run build -w services/booking` проходить; тести зелені; `git diff` показує переміщення без змін логіки (крім імпортів) |
| 3 | **Docker і локальне середовище** | 2 | `@prisma/adapter-pg`; Dockerfile (runtime + migrate); `.dockerignore`; Compose (Postgres + init схем/ролей + booking-api); заглушка пошти; рішення щодо історії міграцій і схеми `booking` (після погодження власника) | 2, відповідь на питання про міграції | `docker compose up` → API здоровий; migrate-задача застосовує міграції від ролі migrator; runtime-роль не може виконати DDL; секретів в образі немає (перевірка `docker history` / вмісту) |
| 4 | **CI** | 3 | Workflow для PR: `npm ci`, typecheck, lint, тести, міграції на service-контейнері Postgres (з init-скриптом), `docker build` обох цілей без push; заборона мережевого доступу до Brevo (заглушка); concurrency | 3 | PR зелений; червоний PR блокує злиття (branch protection); жодного секрету, крім фіктивних |
| 5 | **Terraform bootstrap** | — (паралельно з 1–4) | S3 state (окремі ключі або бакети на staging/prod) з блокуванням; GitHub OIDC provider; ECR-репозиторії (спільні, щоб просувати digest); IAM-ролі: plan (read-only), apply-staging, apply-production, deploy-staging, deploy-production | Відповіді щодо GitHub-плану й погоджувачів | `terraform plan` з GitHub Actions через OIDC; у GitHub немає AWS-ключів; production-роль приймає лише environment `production` |
| 6 | **AWS staging + CD** | 4, 5, домен/DNS, Neon staging | VPC (2 публічні підмережі, IGW, без NAT); ALB + ACM + HTTPS (HTTP→HTTPS); SG: ALB 443 з інтернету, задачі — лише від SG ALB; ECS cluster, service `booking-api` (public IP, circuit breaker + rollback, `initProcessEnabled`); task definition `booking-migrate`; секрети в Secrets Manager або SSM Parameter Store; CloudWatch Logs + базові аларми; workflow після злиття: build → push → migrate task (concurrency group) → deploy → smoke (`/health/ready`, перевірка версії) | 5 | Staging доступний за HTTPS; health зелений; повторний деплой без простою; невдалий деплой відкочується автоматично; міграція виконується один раз за реліз |
| 7 | **Production-просування** | 6 | Workflow з `workflow_dispatch` / environment approval: той самий digest, migrate → deploy → smoke; ручний відкат на попередній digest; правило «міграції лише expand/contract» | 6 | Реліз у production без перезбірки (digest збігається); відкат застосунку не чіпає БД |
| 8 | **Firebase і нова модель User** | 6 (або 3 — модель можна робити паралельно) | Розділ 3.4 | 3 | Гість створюється, прив'язка входу зберігає `User.id`, бронювання гостем → 403; legacy-парольний код видалено |
| 9 | **Notifications** | 8 | Outbox у Booking, SQS + DLQ (Terraform), `notifications-worker` як окремий ECS service без вхідних правил, журнал доставки, перенесений Brevo-адаптер; згодом webhook | 8 | Повтор повідомлення не дає другого листа; помилка Brevo не ламає бізнес-операцію; DLQ з алармом |
| 10 | **Бронювання** (каталог, розклад, винятки, доступність, створення з захистом від конкурентного й повторного створення) | 8 | Окреме проєктування | — | — |

**Незалежний деплой API та worker:** окремі ECR-репозиторії, окремі ECS services і task definitions, окремі workflow-задачі. Тригер — зміни в `services/<svc>/**`, у будь-якому `packages/**`, від якого сервіс залежить (на старті достатньо правила «будь-яка зміна `packages/**` або `package-lock.json` перезбирає всі сервіси»), чи в кореневих `tsconfig.base.json`/`eslint.config.js`. **[Р]** Пізніше можна додати визначення змінених сервісів через `npm query`.

**Міграції та відкат:**
- окремий one-off ECS task з роллю migrator і direct-endpoint;
- `concurrency` групи в GitHub Actions на кожне середовище плюс advisory lock Prisma [Д];
- міграції сумісні з попередньою версією застосунку (expand → deploy → contract);
- відкат = повторний деплой попереднього digest, без автоматичного відкату БД.

**Що виправити до інтернет-доступного staging (P0):**
1. Health-ендпоінти, `PORT`, graceful shutdown.
2. Логування помилок, 400 для JSON, відсутність внутрішніх деталей у відповідях.
3. Прибрати `POST /api`.
4. `.dockerignore`, секрети поза образом.
5. **Не публікувати legacy-ендпоінти `/api/users/*`.** Альтернатива — rate limit, `trust proxy`, екранування шаблонів і заглушка пошти в staging. Перший варіант дешевший, бо код замінюється.

**Мінімальний перший деплой [Р]:** лише `booking-api` з `/health/live` і `/health/ready` (БД staging), без legacy-маршрутів користувачів, без Brevo-ключа в staging (або із заглушкою пошти) і без worker/SQS. Migrate-задача виконує базову міграцію схеми `booking`. Так перевіряється весь ланцюжок (OIDC → ECR → migrate → ECS → ALB → smoke → просування за digest), і при цьому нічого незавершеного не виставляється в інтернет.

---

## 6. Перевірки

### Виконано

Усі runtime-перевірки виконувались із **фіктивними** змінними середовища (`DOTENV_CONFIG_PATH=/dev/null`, `DATABASE_URL` → `127.0.0.1:5`, фіктивний ключ Brevo). Підключень до Neon і Brevo не було. Збірка виводилась у тимчасовий каталог сесії поза репозиторієм.

| Перевірка | Команда (скорочено) | Результат |
|---|---|---|
| Стан Git | `git branch`, `git rev-parse HEAD`, `git status --porcelain -uall` | `main`, `a3cd0ad…`; untracked лише `BACKEND_HANDOFF.md` |
| Версії та двигуни | читання `node_modules/*/package.json` | Prisma 7.9.1 (Node `^20.19 \|\| ^22.12 \|\| >=24`), adapter-neon 7.9.1, `@neondatabase/serverless` 1.1.0, Express 5.2.1, Brevo SDK 6.0.3; локально Node 24.21.0 |
| Згенерований клієнт | `ls node_modules/.prisma/client` | `prisma-client-js` у `node_modules/.prisma/client`, WASM query compiler |
| Нативні модулі | `find node_modules -name "*.node"` | Лише bcrypt (prebuilds linux glibc/musl x64/arm64) |
| Дерево залежностей | `npm ls --depth=0`, `npm ls --omit=dev` | Без помилок |
| Typecheck і збірка | `npx tsc --outDir <tmp>` | exit 0 |
| Запуск збірки під node | `node <tmp>/dist/server.js` з `PORT=4555` | Слухає `*:3001`; на 4555 з'єднання немає → `PORT` ігнорується |
| Health | `GET /health` | 404 |
| Зламаний JSON | `POST /api/users/subscribe '{bad'` | 500, в лог нічого |
| Недоступна БД | валідний `POST /subscribe` при фіктивній БД | 500 приблизно за 0,13 с, в лог нічого; лист не надсилався (помилка БД раніше) |
| SIGTERM | `kill -TERM` | Миттєвий вихід, код 143, без обробника |
| Fail-fast конфігурації | запуск без `BREVO_API_KEY` | `Error: BREVO_API_KEY is not set` |
| Prisma schema | `npx prisma validate` (фіктивний URL) | valid |
| Prisma config без URL | `env -u DATABASE_URL npx prisma validate` | `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL` |
| Регіон Neon | локальний розбір hostname з `.env` (виведено лише регіон, ознаку pooler і назви параметрів) | `aws eu-west-2`, pooler = true, параметри `sslmode`, `channel_binding` |
| Пошук runtime-деталей | `grep` у `src` | Немає `trust proxy`, обробників сигналів, `$disconnect`, лімітів тіла запиту |

### Не перевірялось

- Будь-які сценарії з реальною БД або листами (заборонено правилами етапу).
- `npm audit`: виконує мережевий запит.
- Що `@prisma/adapter-neon` не підключається до звичайного Postgres [Д] і що `adapter-pg` працює з Neon pooler/direct [Д]. Перевірити на етапі 3.
- Поведінка `prisma generate` без `DATABASE_URL` (перевірено лише `validate`, бо `generate` переписує файли в `node_modules`).
- Механізм прив'язки `_prisma_migrations` і запитів до конкретної схеми в Prisma 7 з driver adapter.
- Поведінка Node як PID 1 у контейнері [Д].
- Споживання CPU/RAM, затримка Fargate (eu-west-3) → Neon (eu-west-2).
- Наявність регіону Neon у Парижі (за моїми даними його немає — уточнити в документації Neon) [?].
- Механізм автентифікації webhook Brevo і функція «authorized IPs» для API-ключів (якщо вона ввімкнена, динамічні IP Fargate будуть заблоковані) [?].

---

## 7. Що потрібно до AWS-деплою

### Домен і DNS
- Домен, реєстратор і де розміщено DNS (Route 53 або зовнішній) [?].
- Піддомени, наприклад `api.staging.<домен>` і `api.<домен>` [Р].
- ACM-сертифікат з DNS-валідацією (потрібен доступ до DNS).
- Для Brevo: автентифікація домену відправника (SPF, DKIM, DMARC).
- Для Firebase: authorized domains і домен для action-посилань.

### Організація середовищ Neon
- **[Р]** Окремі Neon-проєкти для staging і production: незалежні облікові дані, ролі, регіон і ліміти. Варіант із гілками (branches) одного проєкту дешевший, але ізоляція облікових даних між гілками потребує перевірки [?].
- Регіон: залишити `eu-west-2` чи створити нові проєкти в ЄС (наприклад, `eu-central-1`) — рішення власника з урахуванням GDPR і затримки [?].
- Для кожного середовища: pooled endpoint (runtime) + direct endpoint (міграції); ролі `booking_migrator`, `booking_app`, пізніше `notifications_*`; bootstrap-скрипт схем і ролей.
- Автопризупинення (autosuspend) Neon. Liveness-перевірка ALB **не повинна звертатися до БД**, інакше вона не даватиме compute засинати.

### Початкові ресурси та режим staging
- 1 ECS service `booking-api` (1 задача, мінімальний розмір Fargate, публічний IP), 1 one-off migrate task.
- ALB (вимагає щонайменше дві AZ — дві публічні підмережі).
- CloudWatch Logs з обмеженим терміном зберігання.
- Секрети: Secrets Manager або SSM Parameter Store SecureString.
- SQS/DLQ і worker — лише з етапу Notifications.
- Режим staging [?]: працює постійно чи з плановим `desiredCount = 0`. ALB тарифікується погодинно навіть без задач.

### Кошторис — перелік оплачуваних компонентів (без тарифів)

Актуальні ціни потрібно взяти з AWS Pricing Calculator для `eu-west-3` на дату розрахунку.

| Компонент | Від чого залежить вартість | Припущення для розрахунку |
|---|---|---|
| Application Load Balancer | Години роботи + LCU | По одному на staging і production, працюють постійно (staging — [?]) |
| Fargate | vCPU-години та GB-години | Кількість задач × розмір × години; migrate-задачі короткі |
| Публічні IPv4-адреси | Погодинна плата за кожну публічну IPv4 | IP кожної Fargate-задачі + IP ALB (щонайменше по одному на AZ) |
| Передача даних назовні | ГБ трафіку в інтернет (Neon, Brevo, Firebase) | Невеликий обсяг; міжрегіональний трафік до Neon |
| ECR | Зберігання образів | Lifecycle policy (наприклад, останні N образів) |
| CloudWatch | Ingestion і зберігання логів, метрики, аларми | Невеликий обсяг логів, коротке зберігання |
| Secrets Manager / SSM | Кількість секретів і API-виклики (Parameter Store standard — безкоштовний рівень) | Кількість секретів × середовища |
| SQS | Кількість запитів (є безкоштовний рівень) | З етапу Notifications |
| S3 (Terraform state) | Мізерне зберігання | — |
| Route 53 | Hosted zone + запити | Якщо DNS у Route 53 |
| ACM | Публічні сертифікати безкоштовні | — |
| KMS | Лише якщо використовуються власні ключі (CMK) | За замовчуванням — AWS managed |
| **Поза AWS:** Neon | План, compute-години, зберігання, кількість проєктів | Два проєкти або гілки |
| **Поза AWS:** Brevo | План і обсяг листів | Невеликий обсяг транзакційних листів |
| **Поза AWS:** Firebase Auth | Анонімна та email-автентифікація зазвичай у межах безкоштовного рівня; SMS платні | Без SMS на старті [?] |
| **Поза AWS:** GitHub Actions | Хвилини для приватних репозиторіїв; правила захисту environment | Залежить від плану GitHub [?] |

**[Р]** Налаштувати AWS Budgets з алармами ще до першого `apply`.

---

## 8. Питання до власника

Лише ті, на які немає відповіді в коді чи погодженій архітектурі.

1. **Домен:** який домен використовуватиметься, і де зараз керується DNS?
2. **Регіон Neon:** залишити Лондон (`eu-west-2`) чи створити staging/production-проєкти в регіоні ЄС? Чи є вимоги до розміщення даних клієнтів?
3. **Середовища Neon:** окремі проєкти (рекомендовано) чи гілки одного проєкту?
4. **Історія міграцій:** чи погоджуєте нову базову міграцію в схемі `booking` зі збереженням старих міграцій лише в Git-історії/архіві?
5. **Legacy-ендпоінти** `/api/users/*`: вимкнути їх на публічному staging до заміни на Firebase (рекомендовано) чи захищати й залишити?
6. **Firebase:** окремі Firebase-проєкти для staging і production? Які способи входу на старті (email/пароль, email-посилання, Google, Apple, телефон)?
7. **Brevo:** окремі акаунти або ключі для staging і production? Чи мають листи зі staging надходити лише на дозволені адреси?
8. **Staging:** працює постійно чи за розкладом? Який місячний бюджет і пороги алармів AWS Budgets?
9. **GitHub:** репозиторій приватний? Який план (від нього залежать правила захисту environment і хвилини Actions)? Хто погоджує production-релізи?
10. **Ролі:** чи достатньо на старті `client` і `admin` (власниця)? Чи потрібна роль спеціаліста?
11. **Злиття акаунтів:** що робити з AI-обліком і даними гостя, якщо він входить в уже наявний акаунт — переносити, підсумовувати чи залишати окремо?

---

## 9. Рекомендований обсяг першого реалізаційного завдання

**Етап 1 — «Runtime-готовність без зміни бізнес-логіки»**, у поточній кореневій структурі, окремою гілкою з PR:

1. Модуль конфігурації (Zod) з `PORT` (за замовчуванням 3001), `NODE_ENV`, `LOG_LEVEL`; наявні змінні залишаються обов'язковими.
2. `GET /health/live` (без БД) і `GET /health/ready` (`SELECT 1` з тайм-аутом); у відповіді — версія з `APP_VERSION`/`GIT_SHA`, якщо задано.
3. Graceful shutdown: `SIGTERM`/`SIGINT` → `server.close()` → `prisma.$disconnect()` → вихід; жорсткий тайм-аут.
4. `errorHandler`: 400 для помилок парсингу JSON, логування невідомих помилок, мапінг `P2002`/`P2025`, жодних внутрішніх повідомлень Brevo у відповідях.
5. Структурований логер (pino) замість `console.*` у змінених місцях; видалити `POST /api`.
6. Скрипти `build`, `start` (`node dist/server.js`), `dev` (`tsx watch`), `test`, `lint`; `engines.node`.
7. Vitest + supertest (тести без БД і пошти: health/live, 400 для JSON, 404, shutdown) і ESLint.

**Поза межами першого завдання:** workspaces, Docker, заміна Prisma-адаптера, нова схема, Firebase, Notifications, Terraform.

**Критерії приймання:**
- `npm ci && npm run lint && npm run typecheck && npm test && npm run build` проходять локально;
- `PORT=4000 node dist/server.js` слухає 4000;
- `SIGTERM` дочікується активного запиту;
- жодних мережевих викликів до Neon/Brevo у тестах;
- поведінка `/api/users/*` не змінена.
