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
  .github/workflows/ci.yml  # GitHub Actions CI (див. «CI»)
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
| `npm test` | Vitest, один прогін (unit- і процесні тести; Docker не потрібен; TLS-тести потребують `openssl`) |
| `npm run test:integration` | Інтеграційні тести міграцій і прав у PostgreSQL-контейнерах; **потрібен запущений Docker**, без нього тести падають, а не пропускаються |
| `npm run test:smoke` | Smoke-тест зібраних Docker-образів (migrate + runtime + PostgreSQL); потрібні Docker і змінні `BOOKING_RUNTIME_IMAGE`, `BOOKING_MIGRATE_IMAGE` (див. «CI») |
| `npm run lint` | ESLint для всіх workspace |
| `npm run typecheck` | `tsc --noEmit` (код, тести, конфіги) |
| `npm run migrate:deploy` | Штатний ланцюжок міграцій (підготовка прав → `prisma migrate deploy` → права runtime-ролі); потрібні `MIGRATION_DATABASE_URL` і `BOOKING_RUNTIME_ROLE` |
| `npm run prisma -- <args>` | Prisma CLI у контексті booking. **Не** використовуйте для `migrate deploy`: він не керує правами runtime-ролі, через що нові таблиці лишаться для неї недоступними |

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
| `DATABASE_QUERY_TIMEOUT_MS` | `30000` | Клієнтський таймаут `pg` для кожного запиту застосунку (зокрема через Prisma); після нього з'єднання знищується. Readiness має власний коротший ліміт |
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
- `channel_binding=require` **відхиляється**. У встановленому `pg` (8.23) прапорець `enableChannelBinding` означає лише «використати SCRAM-SHA-256-PLUS, якщо сервер його пропонує»; драйвер не відмовляє серверу без channel binding і не відмовляється від автентифікації без SCRAM. Тому вимогу `require` в libpq-сенсі забезпечити неможливо. `prefer` — інша, слабша гарантія: його можна обрати лише свідомо, з урахуванням ризику, а не як спосіб прибрати помилку запуску;
- будь-який інший параметр (`sslrootcert`, `sslcert`, `options`, `schema`, ...) дає помилку запуску, а не мовчки ігнорується;
- символ `#` відхиляється (у credentials його треба кодувати як `%23`): фрагмент URL більше не відкидається мовчки.

Повідомлення про помилки — фіксовані рядки: вони називають лише заздалегідь визначені поля та правила (`sslmode`, `channel_binding`, «unsupported query parameter») і **ніколи** не містять частин URL. Це важливо, бо з незакодованими `@`, `?` або `#` у паролі «хост» чи «назва параметра» можуть бути шматком секрету.

**`DATABASE_URL` і `MIGRATION_DATABASE_URL`.** `DATABASE_URL` використовує лише застосунок, під runtime-роллю без DDL. `MIGRATION_DATABASE_URL` використовують migrate-раннер і `prisma.config.ts`, під роллю migrator. Раннер перевіряє його тим самим парсером і застосовує TLS згідно з `MIGRATION_DATABASE_SSL_MODE` (default `verify-full`). Як ці самі параметри трактує schema engine Prisma CLI — див. «Відкриті пункти». Якщо `MIGRATION_DATABASE_URL` не задано, datasource не налаштовується: `prisma generate` і `validate` працюють, а `migrate deploy` і `migrate status` завершуються помилкою. Fallback на `DATABASE_URL` чи фіктивний URL немає, тож реальний `DATABASE_URL` з `.env` випадково не стане цільовою БД для міграцій.

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

`READINESS_TIMEOUT_MS` діє на трьох рівнях:
- **(a) HTTP:** `/health/ready` відповідає не пізніше ніж через цей час (`Promise.race`).
- **(b) драйвер:** сам запит `SELECT 1` виконується з власним `query_timeout` `pg` (той самий ліміт). Після нього драйвер завершує запит з помилкою; на сервері запит не скасовується.
- **(c) з'єднання:** пул отримує помилку й знищує це з'єднання (`client.end()` для клієнта із завислим запитом закриває сокет). Наступна перевірка відкриває нове з'єднання.

Одночасно виконується не більше однієї перевірки; паралельні запити `/health/ready` чекають на неї, тож запити не накопичуються. Пул також має TCP keepalive. Бізнес-запити мають окремий, довший `DATABASE_QUERY_TIMEOUT_MS`.

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
3. Закривається Prisma-клієнт, а потім пул `pg` (пул закривається навіть тоді, коли `$disconnect()` завершився помилкою); процес виходить з кодом `0`.
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
- `booking-migrate` — одноразовий штатний ланцюжок міграцій (див. нижче);
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

# повторно запустити ланцюжок міграцій (ідемпотентно: "No pending migrations")
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
| `booking_app` | `local-app-password` | `booking-api` (`DATABASE_URL`) | `SELECT/INSERT/UPDATE/DELETE` на бізнес-таблиці migrator, `USAGE/SELECT` на послідовності; жодного доступу до `_prisma_migrations`; без `CREATE`, `DROP`, `ALTER`, `TRUNCATE`, тимчасових таблиць |

Компоненти Compose підключаються до Postgres мережею з паролем (`scram-sha-256`). Офіційний образ дозволяє `trust` лише для з'єднань зсередини самого контейнера `postgres` (наприклад, `docker compose exec postgres psql`).

**Volume.** Дані зберігаються в named volume `massage-booking-local_booking-postgres-data`. Звичайне `docker compose down` його не видаляє. Init-скрипти з `docker/postgres/init/` офіційний образ виконує **лише для нового (порожнього) volume**, тож зміни ролей не застосуються до наявного. Щоб навмисно почати з чистої БД, видаліть volume явно (дані буде втрачено): `docker compose --env-file /dev/null down -v`.

**Схема `public` тимчасова.** Поточні таблиці та міграції лишаються в `public`. Перехід на окрему схему `booking` — окреме завдання.

**Права runtime-ролі: закрито за замовчуванням.** Default privileges для runtime-ролі немає, тож таблиця, створена міграцією, для неї недоступна, доки права не видано явно. Штатний ланцюжок `services/booking/src/migrate/run-migrations.ts` (Docker-ціль `migrate`, `npm run migrate:deploy`) виконує від імені migrator три кроки:
1. **Підготовка.** Перевіряє, що `BOOKING_RUNTIME_ROLE` існує і не є migrator чи суперкористувачем; інакше завершується помилкою **до** міграцій. Далі ідемпотентно прибирає старі default privileges для цієї ролі (стан після попередньої версії init-скрипту) і доступ до наявної `_prisma_migrations`.
2. **`prisma migrate deploy`.** Якщо він завершився помилкою, код виходу Prisma повертається без змін, а права не видаються. Нові таблиці та `_prisma_migrations` лишаються закритими, тож додаткові дії після збою не потрібні.
3. **Права після успіху.** `SELECT/INSERT/UPDATE/DELETE` на таблиці migrator у `public` (крім `_prisma_migrations`) і `USAGE/SELECT` на послідовності.

Ім'я ролі передається bind-параметром і в SQL підставляється лише через `format('%I')`, тож ін'єкція через нього неможлива. Чужі схеми та чужі об'єкти раннер не чіпає. Дані не видаляються. SQL чинних міграцій не змінювався.

**Наявні локальні volumes** (ініціалізовані попереднім init-скриптом із default privileges) окремих дій не потребують: перший же запуск ланцюжка виконує крок 1 і переводить їх на нову модель без втрати даних. Це покрито інтеграційним тестом.

### Docker-образ

`services/booking/Dockerfile`, build context — корінь репозиторію:
- `runtime` (default) — Node 24 bookworm-slim, `npm ci --omit=dev --omit=optional`, лише `dist` і production-залежності. Запускається від користувача `node` командою `node dist/server.js`; tsx немає.
  - `--omit=optional` потрібен, бо `prisma` і `typescript` позначені як `devOptional` (необов'язкові peer-залежності `@prisma/client`) і без нього потрапили б у образ.
- `migrate` — Prisma CLI, `prisma.config.ts`, `schema.prisma`, міграції та скомпільований раннер (`dist/migrate`, логер і модулі розбору URL), без коду API. Команда: `node dist/migrate/run-migrations.js` (ланцюжок вище). Змінні: `MIGRATION_DATABASE_URL`, `MIGRATION_DATABASE_SSL_MODE` (default `verify-full`), `BOOKING_RUNTIME_ROLE`.

Збірка не потребує секретів і не звертається до БД: `prisma generate` виконується без `MIGRATION_DATABASE_URL`. Під час `npm ci` postinstall Prisma завантажує schema engine з CDN Prisma, тож для збірки потрібен доступ до мережі.

**Платформа:** вручну образи перевірено на **linux/arm64** (Docker Desktop на Apple Silicon). CI збирає й запускає їх для **linux/amd64** на x64-runner (див. «CI»). Остаточну архітектуру для AWS ще не обрано.

## Тести

- `npm test` — unit- і процесні тести без Docker. TLS-тести (`test/tls-verification.test.ts`) генерують тимчасовий CA через CLI **`openssl`**; без нього вони завершуються помилкою «openssl is required…», а не пропускаються.
- `npm run test:integration` — міграції та права в контейнерах `postgres:17.11-bookworm` (змінюється через `INTEGRATION_POSTGRES_IMAGE`). Потрібен запущений Docker. Кожен сценарій отримує окремий контейнер із випадковими паролями й міткою `massage-booking.integration-test=1`; після тесту контейнер видаляється. Підключення йдуть через опублікований порт із паролем, а не через `trust`.
- `npm run test:smoke` — перевірка вже зібраних образів, а не вихідного коду. Тест створює окрему Docker-мережу з PostgreSQL, двічі запускає migrate-образ і перевіряє права runtime-ролі та відмову з неправильним паролем через `psql` у тій самій мережі. Потім запускає runtime-образ і перевіряє live/ready/legacy, користувача не-root і SIGTERM. Ресурси отримують мітку `massage-booking.smoke-test=1` і видаляються навіть при збої; при збої тест виводить логи контейнерів.
- `test/postgres-image.test.ts` (частина `npm test`) перевіряє, що `compose.yaml`, тестовий helper і CI використовують той самий образ PostgreSQL.

## CI (GitHub Actions)

Workflow `.github/workflows/ci.yml` запускається на pull request у `main`, на push у `main` і вручну (`workflow_dispatch`). Фільтрів шляхів немає, тож перевірки йдуть на кожну зміну.

Не використовує секретів, не звертається до Neon, Brevo, Firebase чи AWS, не публікує образи й **не виконує деплой в AWS** (CD ще не налаштовано). Права — лише `contents: read`; застарілий запуск для того самого PR чи гілки скасовується.

| Job | Що перевіряє |
|---|---|
| `code` | `npm ci`, `prisma generate` без БД, lint, typecheck, `npm test` (unit, процесні, TLS через `openssl`), build |
| `integration` | `npm run test:integration` на `postgres:17.11-bookworm`: перші й повторні міграції, невдала міграція, перехід зі старих прав, відсутність доступу до `_prisma_migrations`, DML на бізнес-таблицях, відмова з неправильним паролем |
| `docker` | Збірка `runtime` і `migrate` для **linux/amd64**, перевірка платформи, `npm run test:smoke` |
| `required` | Підсумковий статус: успішний лише тоді, коли всі три jobs вище мають результат `success` (failure, cancelled або skipped дають помилку) |

Runner — `ubuntu-24.04` (x64), Node 24. Actions закріплено за повними SHA комітів.

**Платформа.** CI перевіряє `linux/amd64` на x64-runner; вручну перевірено `linux/arm64`. Це не визначає архітектуру для AWS.

**Branch protection** налаштовується окремо в GitHub після першого успішного запуску: позначте як обов'язкову перевірку `required` (у списку перевірок PR вона показується як «CI / required»).

### Повторити локально

```sh
# code
export DOTENV_CONFIG_PATH=/dev/null   # не читати кореневий .env
npm ci
npm run prisma -- generate
npm run lint && npm run typecheck && npm test && npm run build

# integration (потрібен Docker)
npm run test:integration

# docker (на Apple Silicon --platform linux/amd64 працює через емуляцію; без нього — нативний arm64)
docker build --platform linux/amd64 -f services/booking/Dockerfile --target runtime -t massage-booking-api:smoke .
docker build --platform linux/amd64 -f services/booking/Dockerfile --target migrate -t massage-booking-migrate:smoke .
BOOKING_RUNTIME_IMAGE=massage-booking-api:smoke BOOKING_MIGRATE_IMAGE=massage-booking-migrate:smoke npm run test:smoke
docker image rm massage-booking-api:smoke massage-booking-migrate:smoke
```

Синтаксис workflow перевіряється через [actionlint](https://github.com/rhysd/actionlint), наприклад так: `docker run --rm -v "$PWD/.github/workflows/ci.yml:/repo/ci.yml:ro" -w /repo rhysd/actionlint:1.7.12 ci.yml`.

## Відкриті пункти (до відповідних етапів)

- **Схема `booking`.** URL-параметр `schema` зараз заборонений. Для окремих схем знадобиться явна змінна, наприклад опція `schema` адаптера `PrismaPg`, узгоджена з налаштуванням Prisma CLI. Права раннера також прив'язані до `public`.
- **Повна політика `MIGRATION_DATABASE_URL`.** Раннер перевіряє URL і TLS для власного з'єднання, але Prisma CLI (schema engine) трактує `sslmode` та інші параметри по-своєму; ця поведінка не перевірена.
- **Архітектура AWS.** Перевірено arm64 вручну і amd64 у CI (amd64 підтверджується лише після першого запуску в GitHub). Остаточну архітектуру для ECS ще не обрано.

## Ще не налаштовано

CD (публікація образів і деплой), інфраструктура AWS, branch protection у GitHub, `trust proxy` для роботи за балансувальником, повне мапування помилок Prisma. Бізнес-функціонал користувачів буде перебудований (Firebase, Notifications).
