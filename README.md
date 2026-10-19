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
  services/
    booking/            # @massage/booking
      src/              # код сервісу (server.ts — точка входу)
      test/             # Vitest-тести та test fixtures (не потрапляють у dist)
      prisma/           # schema.prisma, migrations/
      tsconfig.json         # typecheck/lint: src + test + конфіги
      tsconfig.build.json   # збірка лише src → dist
```

Зараз існує лише сервіс `booking`. Його інфраструктурна основа (конфігурація, health-check, логи, graceful shutdown) увімкнена завжди. Старий користувацький функціонал (`/api/users/*`: паролі, підтвердження email, відновлення пароля, маркетингова підписка, листи через Brevo) вмикається лише прапорцем `ENABLE_LEGACY_USER_ROUTES` і буде перебудований.

Правила типізації та lint — у [AGENTS.md](AGENTS.md).

## Вимоги та встановлення

Node.js **24** (`engines: ^24.0.0`, `.nvmrc`).

```sh
npm ci                        # з кореня репозиторію
npm run prisma -- generate    # Prisma Client (потрібен DATABASE_URL у середовищі або .env)
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
| `DATABASE_URL` | — (обов'язково) | `postgres://` або `postgresql://` |
| `APP_VERSION` | — | Повертається в `/health/ready` |
| `FRONTEND_URL` | — | CORS origin; без нього CORS-заголовки не додаються |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Граничний час graceful shutdown |
| `READINESS_TIMEOUT_MS` | `2000` | Граничний час перевірки БД у `/health/ready` |
| `ENABLE_LEGACY_USER_ROUTES` | `false` | Лише `true`/`false` (без урахування регістру); інші значення — помилка |

Коли `ENABLE_LEGACY_USER_ROUTES=true`, додатково обов'язкові `BREVO_API_KEY`, `EMAIL_FROM_NAME`, `EMAIL_FROM_EMAIL`, `ACTION_TOKEN_SECRET` і `FRONTEND_URL`. Коли прапорець вимкнений, `/api/users/*` не підключаються, а Brevo-клієнт і сервіс токенів не створюються. Сам імпорт модулів не читає `process.env` і не вимагає секретів.

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
4. Якщо пункт 2 не вклався в `SHUTDOWN_TIMEOUT_MS`, з'єднання закриваються примусово, ресурси звільняються, вихід з кодом `1`. Помилка під час закриття також дає код `1`.

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

## Ще не налаштовано

Docker, CI/CD, інфраструктура AWS, `trust proxy` для роботи за балансувальником, повне мапування помилок Prisma. Бізнес-функціонал користувачів буде перебудований (Firebase, Notifications).
