# Massage-backend

Бекенд сервісу бронювання для масажного кабінету.

## Структура

Репозиторій організовано як **npm workspaces**: кожен сервіс лежить у `services/<name>` і має власні `package.json`, TypeScript-конфігурацію, Prisma-схему та міграції. Залежності встановлюються один раз із кореня, і для всіх сервісів є один `package-lock.json`.

```
Massage-backend/
  package.json          # workspaces + команди, що делегують у сервіси
  package-lock.json     # єдиний lock-файл
  eslint.config.mjs     # ESLint (typescript-eslint, type-aware)
  .env.example          # перелік змінних середовища (без значень секретів)
  compose.yaml          # локальний стек: PostgreSQL + міграції + Booking API
  .dockerignore
  docker/postgres/init/ # створення локальних ролей БД (лише для нового volume)
  services/
    booking/            # @massage/booking
      src/              # код сервісу (server.ts — точка входу)
      test/             # Vitest-тести та test fixtures (не потрапляють у dist)
      prisma/           # schema.prisma, migrations/
      src/generated/    # Prisma Client (prisma generate; не в Git)
      Dockerfile        # цілі runtime (API) і migrate
      tsconfig.json         # typecheck/lint: src + test + конфіги
      tsconfig.build.json   # збірка лише src → dist
```

Зараз існує лише сервіс `booking`. Його інфраструктурна основа (конфігурація, health-check, логи, graceful shutdown) увімкнена завжди. Старий користувацький функціонал (`/api/users/*`: паролі, підтвердження email, відновлення пароля, маркетингова підписка, листи через Brevo) вмикається лише прапорцем `ENABLE_LEGACY_USER_ROUTES` і буде перебудований.

Правила типізації та lint — у [AGENTS.md](AGENTS.md).

## Вимоги та встановлення

Node.js **24** (`engines: ^24.0.0`, `.nvmrc`).

```sh
npm ci                        # з кореня репозиторію
npm run prisma -- generate    # Prisma Client у services/booking/src/generated (БД не потрібна)
```

## Команди (з кореня)

| Команда | Що робить |
|---|---|
| `npm run dev` | Розробка: `tsx watch`, підхоплює кореневий `.env`, якщо він є |
| `npm run build` | Очищення `services/booking/dist` і компіляція `src` |
| `npm start` | Запуск зібраного коду: `node dist/server.js` (лише змінні середовища, `.env` не читається) |
| `npm test` | Vitest, один прогін |
| `npm run lint` | ESLint для всіх workspace |
| `npm run typecheck` | `tsc --noEmit` (код, тести, конфіги) |
| `npm run prisma -- <args>` | Prisma CLI у контексті booking |

Будь-яку команду можна запустити й безпосередньо у workspace: `npm run <script> -w @massage/booking`.

## Конфігурація

Конфігурація зчитується один раз при старті та перевіряється Zod-схемою (`services/booking/src/config/config.ts`). При помилці процес пише лог `invalid configuration` і завершується з кодом 1. У повідомленні є назви змінних і порушені правила, але не їхні значення.

| Змінна | Default | Опис |
|---|---|---|
| `NODE_ENV` | `production` | `development` / `test` / `production` |
| `PORT` | `3001` | Ціле число 1–65535; сервер слухає `0.0.0.0` |
| `LOG_LEVEL` | `info` | Рівень pino |
| `DATABASE_URL` | — (обов'язково) | `postgres://` або `postgresql://`; runtime-роль (лише DML) |
| `DATABASE_SSL_MODE` | `verify-full` | TLS з перевіркою ланцюжка сертифікатів і імені хоста; `disable` — лише для локальної БД |
| `DATABASE_POOL_MAX` | `5` | Розмір пулу `pg` (1–50), один пул на процес |
| `DATABASE_CONNECT_TIMEOUT_MS` | `5000` | Таймаут встановлення з'єднання |
| `APP_VERSION` | — | Повертається в `/health/ready` |
| `FRONTEND_URL` | — | CORS origin; без нього CORS-заголовки не додаються |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Граничний час graceful shutdown |
| `READINESS_TIMEOUT_MS` | `2000` | Граничний час перевірки БД у `/health/ready` |
| `ENABLE_LEGACY_USER_ROUTES` | `false` | Лише `true`/`false` (без урахування регістру); інші значення — помилка |

Коли `ENABLE_LEGACY_USER_ROUTES=true`, додатково обов'язкові `BREVO_API_KEY`, `EMAIL_FROM_NAME`, `EMAIL_FROM_EMAIL`, `ACTION_TOKEN_SECRET` і `FRONTEND_URL`. Коли прапорець вимкнений, `/api/users/*` не підключаються, а Brevo-клієнт і сервіс токенів не створюються. Сам імпорт модулів не читає `process.env` і не вимагає секретів.

**Формат `DATABASE_URL`** (`src/shared/database/database-url.ts`). URL розбирається самим сервісом і не передається в `pg` як `connectionString`:
- спецсимволи в імені користувача, паролі та назві БД мають бути percent-encoded (`@` → `%40` тощо); `+` лишається плюсом;
- IPv6-хост вказується у квадратних дужках (`[::1]`); unix-сокети не підтримуються;
- дозволені параметри:
  - `sslmode` — лише якщо не слабший за `DATABASE_SSL_MODE`: для `verify-full` це `require`, `verify-ca` або `verify-full` (перевірка все одно повна); для `disable` — лише `disable`;
  - `channel_binding=prefer|disable`.
- `channel_binding=require` **відхиляється**: node-postgres використовує SCRAM-SHA-256-PLUS лише тоді, коли сервер його пропонує, і не вміє відмовити серверу, що його не пропонує. Для Neon-URL замініть `require` на `prefer`.
- будь-який інший параметр (`sslrootcert`, `sslcert`, `options`, `schema`, ...) дає помилку запуску, а не мовчки ігнорується.

У повідомленнях про помилки є назва параметра, але не значення.

**`DATABASE_URL` і `MIGRATION_DATABASE_URL`.** `DATABASE_URL` використовує лише застосунок, під runtime-роллю без DDL. `MIGRATION_DATABASE_URL` читає лише `prisma.config.ts` для `prisma migrate`, під роллю migrator. Якщо `MIGRATION_DATABASE_URL` не задано, datasource не налаштовується: `prisma generate` і `validate` працюють, а `migrate deploy` і `migrate status` завершуються помилкою. Fallback на `DATABASE_URL` чи фіктивний URL немає, тож реальний `DATABASE_URL` з `.env` випадково не стане цільовою БД для міграцій.

**`.env`:**
- `npm run dev` передає кореневий `.env` через Node-прапорець `--env-file-if-exists`;
- `npm run prisma` передає його через `DOTENV_CONFIG_PATH` (за замовчуванням `../../.env` відносно workspace);
- інший файл можна вказати через `DOTENV_CONFIG_PATH=/path/to/file`, а `DOTENV_CONFIG_PATH=/dev/null` вимикає завантаження;
- змінні, вже задані в середовищі процесу, мають пріоритет;
- `npm start` і тести `.env` не читають.

## Health-check

| Endpoint | Поведінка |
|---|---|
| `GET /health/live` | `200 {"status":"ok"}`, якщо процес обслуговує HTTP. Без звернень до БД чи пошти |
| `GET /health/ready` | `200 {"status":"ready","version"?}`, якщо процес не завершується і БД відповідає на `SELECT 1` за `READINESS_TIMEOUT_MS`. Інакше `503 {"status":"unavailable","reason":"shutting_down" \| "database_unavailable"}` |

Таймаут readiness обмежує лише час очікування HTTP-відповіді. **Сам запит до БД не скасовується**, бо драйвер не підтримує скасування. Щоб завислі перевірки не накопичувалися, одночасно виконується не більше однієї: паралельні та наступні запити `/health/ready` повторно використовують її, доки вона не завершиться.

Успішні health-запити логуються лише на рівні `debug`.

## Логи

Структуровані JSON-логи (pino) пишуться в stdout:
- старт і зупинка процесу;
- HTTP-запити: `requestId`, `method`, `path` без query, `status`, `durationMs`;
- непередбачені помилки.

Не логуються заголовки (зокрема `Authorization` і cookies), тіла запитів, query-параметри, конфігурація та тексти повідомлень помилок провайдерів. Для помилок пишуться лише тип, безпечний код (наприклад, `EADDRINUSE`, `P2002`) і рядки стеку.

`requestId` генерує сервер (UUID), повертає в заголовку `X-Request-Id` і не бере з запиту.

## Завершення роботи (SIGTERM / SIGINT)

1. Процес позначається як такий, що завершується, і `/health/ready` починає повертати 503.
2. Сервер перестає приймати нові з'єднання; активні запити завершуються; keep-alive з'єднання, що звільнилися, закриваються.
3. Закривається Prisma-з'єднання; процес виходить з кодом `0`.
4. `SHUTDOWN_TIMEOUT_MS` — один дедлайн на пункти 2–3 разом, зокрема на закриття БД. Коли він минає, з'єднання закриваються примусово і процес виходить з кодом `1`, навіть якщо `server.close()` чи закриття пулу ще не завершилися. Ці операції не скасовуються, процес просто перестає їх чекати. Помилка під час закриття також дає код `1`.

Повторний сигнал лише логується, процедура не запускається вдруге. Помилка запуску (наприклад, зайнятий порт) дає лог `failed to start HTTP server` і код виходу `1`.

## Навмисні зміни HTTP-відповідей (порівняно з попередньою версією)

- Видалено налагоджувальний `POST /api`, який логував тіло запиту.
- `/api/users/*` вимкнені за замовчуванням: без прапорця вони повертають 404.
- Невідомий маршрут → `404 {"message":"Not found","code":"NOT_FOUND"}` (раніше HTML-сторінка Express).
- Некоректний JSON → `400 {"message":"Malformed JSON request body","code":"INVALID_JSON"}` (раніше 500).
- Тіло понад 16 kB → `413 {"message":"Request body too large","code":"PAYLOAD_TOO_LARGE"}` (раніше ліміт 100 kB і відповідь 500).
- Непідтримуване кодування чи charset → 415.
- Помилка відправки листа (legacy) → `502` з фіксованим повідомленням (`Failed to send verification email` / `Failed to send password reset email`) замість тексту внутрішньої помилки.
- Прибрано заголовок `X-Powered-By`; додано заголовок `X-Request-Id`.
- CORS-заголовки додаються лише при заданому `FRONTEND_URL` (раніше без нього дозволялися будь-які origin, але без цієї змінної сервер тоді не стартував).

Відповіді валідації (`400 Validation failed`) і `AppError` не змінилися.

## Локальний запуск через Docker Compose

Стек складається з трьох сервісів:
- `postgres` — офіційний образ, за замовчуванням закріплений `postgres:17.11-bookworm`, змінюється через `POSTGRES_IMAGE`. Версію Postgres у Neon ще не з'ясовано, після цього її треба узгодити;
- `booking-migrate` — одноразовий `prisma migrate deploy`;
- `booking-api` — скомпільований API.

API стартує лише після того, як PostgreSQL пройшов health-check, а міграції завершилися успішно.

Compose автоматично читає `.env` з кореня для підстановки змінних. `compose.yaml` не використовує змінних із секретами (лише `POSTGRES_IMAGE` і `BOOKING_API_PORT` з defaults), а `--env-file /dev/null` нижче вимикає це читання повністю.

```sh
# запуск (збирає образи; API на http://127.0.0.1:3001)
docker compose --env-file /dev/null up --build -d

# стан і логи
docker compose --env-file /dev/null ps
docker compose --env-file /dev/null logs -f booking-api
docker compose --env-file /dev/null logs booking-migrate

# повторно застосувати міграції (ідемпотентно: "No pending migrations")
docker compose --env-file /dev/null run --rm booking-migrate

# перезбірка після змін коду
docker compose --env-file /dev/null build
docker compose --env-file /dev/null up -d

# зупинка; дані в volume зберігаються
docker compose --env-file /dev/null down
```

Інший порт API: `BOOKING_API_PORT=3002 docker compose --env-file /dev/null up -d`. Порт PostgreSQL назовні не публікується; доступ до БД — через `docker compose --env-file /dev/null exec postgres psql -U booking_admin -d booking`.

**Тестові локальні credentials** (лише для цього стеку, задані в `compose.yaml`):

| Роль | Пароль | Хто використовує | Права |
|---|---|---|---|
| `booking_admin` | `local-admin-password` | Лише контейнер `postgres` (ініціалізація) | Суперкористувач |
| `booking_migrator` | `local-migrator-password` | `booking-migrate` (`MIGRATION_DATABASE_URL`) | `CREATE` у `public`, власник таблиць |
| `booking_app` | `local-app-password` | `booking-api` (`DATABASE_URL`) | `SELECT/INSERT/UPDATE/DELETE` на таблиці migrator, `USAGE/SELECT` на послідовності; без `CREATE`, `DROP`, `ALTER`, `TRUNCATE`, тимчасових таблиць |

Права runtime-ролі на майбутні таблиці migrator видаються через `ALTER DEFAULT PRIVILEGES`.

**Volume.** Дані зберігаються в named volume `massage-booking-local_booking-postgres-data`. Звичайне `docker compose down` його не видаляє. Init-скрипти з `docker/postgres/init/` офіційний образ виконує **лише для нового (порожнього) volume**, тож зміни ролей не застосуються до наявного. Щоб навмисно почати з чистої БД, видаліть volume явно (дані буде втрачено): `docker compose --env-file /dev/null down -v`.

**Схема `public` тимчасова.** Поточні таблиці та міграції лишаються в `public`. Перехід на окрему схему `booking` — окреме завдання.

**Службова таблиця `_prisma_migrations`.** Default privileges видали б runtime-ролі DML і на неї, бо таблицю створює migrator під час першого `migrate deploy`. Тому migrate-задача після кожного `migrate deploy` виконує від імені migrator (власника таблиці) `prisma/privileges/after-migrate.sql`: це ідемпотентний `REVOKE ALL ... FROM booking_app`. SQL чинних міграцій не змінювався. Для локального CLI той самий ланцюжок запускає `npm run migrate:deploy -w @massage/booking`. Звичайний `prisma migrate deploy` без цього кроку права не прибирає.

### Docker-образ

`services/booking/Dockerfile`, build context — корінь репозиторію:
- `runtime` (default) — Node 24 bookworm-slim, `npm ci --omit=dev --omit=optional`, лише `dist` і production-залежності. Запускається від користувача `node` командою `node dist/server.js`; tsx немає.
  - `--omit=optional` потрібен, бо `prisma` і `typescript` позначені як `devOptional` (необов'язкові peer-залежності `@prisma/client`) і без нього потрапили б у образ.
- `migrate` — Prisma CLI, `prisma.config.ts`, `schema.prisma` і міграції, без коду застосунку. Команда: `prisma migrate deploy`.

Збірка не потребує секретів і не звертається до БД: `prisma generate` виконується без `MIGRATION_DATABASE_URL`. Під час `npm ci` postinstall Prisma завантажує schema engine з CDN Prisma, тож для збірки потрібен доступ до мережі.

## Ще не налаштовано

CI/CD, інфраструктура AWS, `trust proxy` для роботи за балансувальником, повне мапування помилок Prisma. Бізнес-функціонал користувачів буде перебудований (Firebase, Notifications).
