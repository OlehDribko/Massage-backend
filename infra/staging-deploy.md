# Staging-деплой booking (ECS Fargate + API Gateway)

Комплект для першого керованого деплою booking у AWS staging (`eu-west-3`, акаунт `849110175854`).

## Стан

| Що | Стан |
|---|---|
| Образи коміту `0e93e68ff7f2418eefe8c762b55588973034b32a` у ECR | **опубліковано й перевірено** (run 39656783947) |
| Terraform: ECS, API Gateway, Cloud Map, ролі, лог-групи, SG (`infra/environments/staging`) | **створено** 2026-10-26 (`apply`: 38 added); виправлення Cloud Map застосовано 2026-10-27, контрольний `plan` — `No changes` (див. «Cloud Map: health check») |
| Workflow `.github/workflows/staging-deploy.yml` | **перший запуск успішний** 2026-10-26 (run 40400135052): 4 міграції, ревізія API `massage-staging-booking-api:2`, readiness через HTTPS з версією `0e93e68` |
| SSM-параметри з рядками підключення | **створено власником** 2026-10-24: обидва `SecureString`, `alias/aws/ssm`, Standard, версія 1 (перевірено лише метадані) |
| Staging-БД у Neon | **підготовлено власником**: проєкт `massage-staging`, БД `neondb`, ролі `booking_migrator`/`booking_app`, таблиць і `_prisma_migrations` немає; міграції ще не запускались |
| GitHub environment `staging` | **створено**: лише гілка `develop`, без тегів і reviewer |
| Repository variables деплою (9) | **задано** з `terraform output deploy_workflow_variables` |
| Staging | **на паузі** з 2026-10-27 (після короткої перевірки): `desired_count = 0`, running/pending 0, задач і екземплярів Cloud Map немає |

### Опубліковані образи

Обидва — single-platform manifest `linux/amd64` (перевірено за config blob в ECR), тег = SHA коміту, теги `IMMUTABLE`.

| Образ | URI за digest |
|---|---|
| API (`runtime`) | `849110175854.dkr.ecr.eu-west-3.amazonaws.com/massage/booking-api@sha256:be7349ff2c5dbecd1d0964830647f97646da57851cae607438d5cd0c4882c79e` |
| Міграції (`migrate`) | `849110175854.dkr.ecr.eu-west-3.amazonaws.com/massage/booking-migrate@sha256:9c9c4c3cbd4cd279c09985d16cfb35700970923083027348b43404f490f86282` |

Basic scan (ECR): у кожному образі 7 HIGH, 2 MEDIUM, 2 LOW, усі в пакетах базового Debian bookworm (`util-linux`, `zlib`), а не в коді застосунку. Для staging не блокер; оновлення базового образу — окрема задача.

API-образ локально перевірено в режимі, близькому до task definition: `--read-only` root filesystem, `--init`, без доступної БД. `/health/live` → 200, `/health/ready` → 503 `database_unavailable`, команда health check з task definition → код 0, SIGTERM → коректне завершення з кодом 0.

## Схема і чому без ALB

```
клієнт ──HTTPS (TLS 1.2+, сертифікат AWS для *.execute-api)──▶ API Gateway HTTP API, stage $default
                                                                  │ throttling 2 rps / burst 10
                                                                  │ private integration, VPC link V2
                                                                  ▼ HTTP усередині VPC, SG vpc-link → SG api:3001
                                       Cloud Map (SRV: IP + порт) ─▶ ECS Fargate task booking-api
                                                                      (public subnet, public IPv4 лише для виходу:
                                                                       ECR, CloudWatch Logs, SSM, Neon)
задача міграцій: той самий VPC, SG migrate без ingress; вихід лише TCP 443 і 5432
```

- **HTTPS без власного домену.** Адреса — `https://<api-id>.execute-api.eu-west-3.amazonaws.com` (output `api_base_url`). Сертифікат належить AWS. ALB такої адреси не дає: для HTTPS на ALB потрібен сертифікат ACM на власний домен, а `*.elb.amazonaws.com` сертифікувати не можна.
- **Ділянка до origin** не виходить в інтернет: VPC link відкриває з'єднання зі своїх ENI у VPC на приватну IP задачі. SG api приймає порт 3001 лише від SG vpc-link (і від SG alb, у якого немає учасників).
- **Authorization** — зарезервований заголовок HTTP API: передається без змін, змінити чи прибрати його mapping-ом не можна. **Кешування немає**: HTTP API не має кешу відповідей, кожен запит доходить до сервісу.
- **Legacy `/api/users` видалено з коду** (task definition ще передає `ENABLE_LEGACY_USER_ROUTES=false`, яке приймається й ігнорується); ключів Brevo і токенів у task definition немає.
- **Firebase Authentication (`/api/me`) у task definition ще не налаштовано:** без `FIREBASE_PROJECT_ID` маршрутів `/api/me` немає. Потрібні зміни (SSM-параметр службового ключа, змінні й secret, права execution role) описано в [docs/auth-and-profiles.md](../docs/auth-and-profiles.md#8-конфігурація-backend); їх не внесено в Terraform і не застосовано.

**Обмеження цієї схеми:**
- VPC links V2 у Парижі підтримуються лише в AZ `euw3-az1` і `euw3-az3`. Наші subnets — `euw3-az1` (3a) і `euw3-az2` (3b), тож VPC link має ENI лише в 3a. Задачі можуть працювати в обох subnets. Якщо зона 3a недоступна, API недоступний. Для production варто додати subnet в `eu-west-3c` (`euw3-az3`).
- Після 60 днів без трафіку VPC link переходить в `INACTIVE`. Перший запит після цього падає, поки API Gateway кілька хвилин відновлює ENI.
- Максимальний timeout інтеграції — 30 с. Він збігається з `DATABASE_QUERY_TIMEOUT_MS` за замовчуванням.
- AWS WAF до HTTP API не підключається. Захист від зловживань — throttling на `$default` (2 rps, burst 10). Для більшого навантаження ліміт треба підняти.
- Під час rolling deploy старий task знімається з Cloud Map і завершується через SIGTERM. Поодинокі 5xx у ці секунди можливі.
- Адреса `execute-api` зміниться, якщо API буде перестворено (наприклад, через `destroy`).
- IP клієнта застосунок бачить як IP ENI VPC link. Справжній IP є в access-логах API Gateway.

## Кошторис

### Тарифи (`eu-west-3`, on-demand, USD)

Джерело — **AWS Price List API** (`aws pricing get-products`, endpoint `us-east-1`), запит від 2026-10-21. Кредити й Free Tier у розрахунку **не враховано**: це фактична вартість, з якої списуватимуться кредити.

| Компонент | Usage type | Ціна |
|---|---|---|
| Fargate Linux x86, vCPU | `EUW3-Fargate-vCPU-Hours:perCPU` | $0.0486 / vCPU-год |
| Fargate Linux x86, пам'ять | `EUW3-Fargate-GB-Hours` | $0.0053 / GB-год |
| Fargate ephemeral storage понад 20 GB | `EUW3-Fargate-EphemeralStorage-GB-Hours` | $0.000129 / GB-год (не використовується) |
| Public IPv4 (task, ENI ALB) | `EUW3-PublicIPv4:InUseAddress` | $0.005 / год за адресу |
| ALB | `EUW3-LoadBalancerUsage` | $0.02646 / год |
| ALB LCU | `EUW3-LCUUsage` | $0.0084 / LCU-год |
| API Gateway HTTP API | `EUW3-ApiGatewayHttpRequest` | $1.17 / млн запитів |
| Cloud Map: зареєстрований ресурс / API-виклики | `EUW3-Cloud-Map-Resources` / `…-API-Calls` | $0.10 / ресурс-міс.; $1.00 / млн викликів |
| Route 53 hosted zone (private DNS namespace Cloud Map) | `HostedZone` | $0.50 / міс. |
| CloudWatch Logs: ingestion / зберігання | `EUW3-DataProcessing-Bytes` / `EUW3-TimedStorage-ByteHrs` | $0.5985 / GB; $0.0315 / GB-міс. |
| Secrets Manager (для порівняння) | `EUW3-AWSSecretsManager-Secrets` | $0.40 / секрет-міс. |
| SSM Parameter Store, standard | — | окремої ціни для standard-параметрів у прайсі немає (є лише advanced: $0.05/міс.) |
| ECR, зберігання | `EUW3-TimedStorage-ByteHrs` | $0.10 / GB-міс. |
| S3 Standard (state) | запити `Tier1`/`Tier2` | $0.0053 / 1000 PUT/LIST; $0.0042 / 10 000 GET |
| Трафік в інтернет | `EUW3-DataTransfer-Out-Bytes` | $0.09 / GB (перші 10 TB) |
| CloudFront, Європа (для порівняння) | `EU-Requests-Tier2-HTTPS` | $0.012 / 10 000 HTTPS-запитів |

### Припущення
- API: 1 task 0.25 vCPU / 0.5 GB x86, `desired_count = 1`. Образи зібрано для `linux/amd64`; ARM на 20 % дешевший, але потребує окремої збірки.
- Трафік: до 30 000 запитів і 0.5 GB вихідного трафіку на місяць, з запасом на «десятки користувачів». Сюди входить міжрегіональний трафік до Neon (`eu-central-1`), який для AWS є трафіком в інтернет.
- 1 деплой на день: задача міграцій ~3 хв і другий API-task ~5 хв під час rolling update. Fargate тарифікується посекундно, мінімум 1 хв.
- Логи до 0.1 GB на місяць; ECR ~3 GB після 10–15 публікацій. Tagged образи не видаляються, тож обсяг росте приблизно на 0.3 GB за публікацію без урахування спільних шарів.
- Секрети в SSM Parameter Store (standard, ключ `aws/ssm`) — $0. У Secrets Manager два секрети коштували б ≈ $0.027 на день.

### Добова вартість

| Стаття | A. API Gateway (обрано) | B. ALB, лише HTTP | C. CloudFront + внутрішній ALB (VPC origin) |
|---|---|---|---|
| Fargate API, 24 год | 0.355 | 0.355 | 0.355 |
| Public IPv4 task, 24 год | 0.120 | 0.120 | 0.120 |
| ALB, година + LCU (оцінка 0.1 LCU) | — | 0.655 | 0.655 |
| Public IPv4 ALB (2 AZ) | — | 0.240 | — |
| API Gateway, Cloud Map, hosted zone | 0.026 | — | — |
| CloudFront | — | — | ≈0.003 |
| Міграції та перекриття під час деплою | 0.003 | 0.003 | 0.003 |
| Логи, ECR, S3 state, трафік | 0.015 | 0.015 | 0.015 |
| **Разом, API 24 год/добу** | **≈ $0.52** | **≈ $1.39** (понад ліміт) | **≈ $1.15** |
| **Разом, API до 8 год/добу** | **≈ $0.20** | **≈ $1.07** | **≈ $0.83** |

- Ліміт $1.30 на день стосується **усіх** сервісів акаунта. Поточні витрати, крім цього проєкту, мізерні (див. нижче).
- **ALB тарифікується, навіть коли API зупинено** (`desired_count = 0`): у варіантах B і C від ~$0.65–0.90 на день не втекти. У варіанті A зупинка API зменшує вартість до ≈ $0.02 на день без запитів (див. «Пауза staging»).
- **Рекомендація: варіант A, API 24 год/добу**, ≈ $0.52 на день (40 % ліміту). Режим «до 8 годин» потребує розкладу (EventBridge Scheduler або ручної зупинки) і для A дає лише ~$0.32 економії на день, тож поки не реалізований.
- **Оцінка при постійному навантаженні, ≈ $0.89 на день.** Це розрахунок за припущеннями, а не гарантована верхня межа.
  - Припущення: throttling пропускає в середньому 2 rps, тобто 172 800 запитів на добу. Кожен запит тарифікується як запит HTTP API ($1.17/млн → ≈ $0.20) і робить один виклик discovery Cloud Map ($1/млн → ≈ $0.17). Разом із базовими $0.52 — ≈ $0.89.
  - **Не враховано:** вихідний трафік відповідей понад 0.5 GB на місяць ($0.09/GB), логи понад 0.1 GB ($0.5985/GB), кілька деплоїв на день, ріст ECR, ручні запити до Cost Explorer ($0.01) і CloudWatch Logs Insights.
  - При 10 rps лише HTTP API коштував би ≈ $1 на день, тому ліміт знижено. Сам застосунок кількість запитів не обмежує.
- **Жорсткого ліміту витрат немає.**
  - **Throttling API Gateway** обмежує швидкість запитів за принципом best effort і не є лімітом витрат. Він не обмежує ні розмір відповідей, ні обсяг логів, ні інші сервіси акаунта.
  - **AWS Budgets** надсилає сповіщення (за налаштування — виконує дії) із запізненням: дані про витрати оновлюються лише кілька разів на добу. Витрат він не зупиняє.
  - Витрати реально зупиняє лише `desired_count = 0` або видалення ресурсів.

### Поточний стан акаунта
- **Тариф:** AWS **Free plan**, `ACTIVE`, діє до **2027-03-06**, залишок кредитів **$199.90** (`freetier get-account-plan-state`). Усі сервіси схеми A (ECS, API Gateway, Cloud Map, Route 53, Systems Manager, CloudWatch Logs, ECR) є в [списку сервісів Free plan](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html). CloudFront там теж є (без Lambda@Edge), ELB також.
- **Витрати з 1 по 21 жовтня 2026** (Cost Explorer, `RECORD_TYPE = Usage`, до кредитів): разом **$0.0357**, усе — Amazon RDS. На 2026-10-21 RDS-інстансів, кластерів, ручних знімків і секретів Secrets Manager у жодному регіоні немає. Це було разове використання, постійних витрат не видно. Сам запит до Cost Explorer коштує $0.01.

## CloudFront (варіант C) — якщо власник віддасть перевагу ALB

CloudFront дає HTTPS на `*.cloudfront.net` без власного домену. Але:
- **Захист origin.** ALB має бути внутрішнім і доступним лише через CloudFront VPC origin. Для VPC origin потрібні приватні subnets, а в нашій VPC є лише public, тож це додаткова зміна мережі. Варіант з публічним ALB, обмеженим managed prefix list CloudFront і секретним заголовком, лишає ділянку CloudFront → ALB на HTTP через інтернет (сертифіката для ALB немає) і коштує ще $0.24 на день за IPv4.
- **Authorization.** За замовчуванням CloudFront не передає `Authorization` на origin для GET/HEAD. Потрібна cache policy, що включає цей заголовок, або origin request policy, що його передає; конкретну комбінацію треба перевірити до запуску.
- **Кешування приватних відповідей** вимикається cache policy `CachingDisabled` (або TTL 0) для всіх шляхів API. Інакше відповіді одного користувача можуть віддатись іншому.
- **Тариф.** CloudFront є у Free plan (без Lambda@Edge). Flat-rate плани CloudFront — окрема підписка, і їхню сумісність з Free plan не перевірено.
- Вартість ≈ $1.15 на день при роботі 24 год лишає лише ~12 % запасу до ліміту.

## Terraform: що описано

Нові файли в `infra/environments/staging` (state той самий, `envs/staging/terraform.tfstate`):

| Файл | Ресурси |
|---|---|
| `ecs.tf` | кластер `massage-staging` (Container Insights вимкнено); лог-групи `/ecs/massage-staging/booking-{api,migrate}` (retention 14 днів); task definitions `massage-staging-booking-api` і `-migrate`; сервіс `booking-api` |
| `ecs_iam.tf` | execution role для API і для міграцій; task role для API і для міграцій (без прав) |
| `api_gateway.tf` | Cloud Map namespace `massage-staging.internal` і service `booking-api` (SRV); VPC link; HTTP API, integration, route `$default`, stage `$default` з throttling і access-логами (без заголовків і тіл) |
| `security_groups.tf` | SG `vpc-link` (лише вихід на api:3001); ingress api:3001 від vpc-link; SG `migrate` (без ingress; вихід 443, 5432) |
| `deploy_role.tf` | роль `massage-staging-github-deploy` для workflow |

**Task definitions.**
- API: 256 CPU / 512 MiB, `X86_64`, `readonlyRootFilesystem`, `initProcessEnabled`, `stopTimeout` 30 с (застосунок завершується за 10 с).
  - Health check контейнера — `/health/live` через `node -e fetch(...)`, бо curl в образі немає. Liveness навмисно не залежить від БД.
  - Змінні: `NODE_ENV=production`, `DATABASE_SSL_MODE=verify-full`, `ENABLE_LEGACY_USER_ROUTES=false`, `APP_VERSION=<SHA>`.
  - Секрет: `DATABASE_URL`.
- Міграції: `MIGRATION_DATABASE_SSL_MODE=verify-full`, `BOOKING_RUNTIME_ROLE=booking_app`, секрет `MIGRATION_DATABASE_URL`. Root filesystem лишається доступним на запис для Prisma CLI.

**Сервіс.**
- Мережа: `FARGATE`, обидві public subnets, `assign_public_ip = true` (NAT немає), SG api.
- Деплой: rolling update (min 100 %, max 200 %), deployment circuit breaker з rollback.
- Реєстрація в Cloud Map (SRV), ECS Exec вимкнено.
- Створюється з `desired_count = 0`, тож до першого деплою нічого не запускається.

**Ролі з мінімальними правами.**

| Роль | Права |
|---|---|
| `…-booking-api-execution` | `ecr:GetAuthorizationToken` на `*`; pull лише `massage/booking-api`; `CreateLogStream`/`PutLogEvents` лише у своїй лог-групі; `ssm:GetParameters` лише на `/massage-staging/booking/database-url` |
| `…-booking-migrate-execution` | те саме для `massage/booking-migrate`, своєї лог-групи й `/massage-staging/booking/migration-database-url` |
| `…-booking-{api,migrate}-task` | жодних (застосунок не викликає AWS API) |
| `massage-staging-github-deploy` | див. «Workflow» |

- Trust усіх ролей задач: `ecs-tasks.amazonaws.com` з умовами `aws:SourceAccount` і `aws:SourceArn` (`arn:aws:ecs:eu-west-3:<account>:*`).
- Набори політик зафіксовано exclusive-ресурсами.
- `kms:Decrypt` не потрібен: політика AWS managed key `aws/ssm` дозволяє розшифрування через SSM principals цього акаунта.

**Секрети без значень у Git, plan і state.** Terraform знає лише **імена** SSM-параметрів і будує їхні ARN. Ресурсів `aws_ssm_parameter` чи data source, що читали б значення, немає.

### Хто чим керує

| Об'єкт | Terraform | Workflow деплою |
|---|---|---|
| Форма task definition (CPU, пам'ять, ролі, env, секрети, логи, health check) | так | ні; копіює її з останньої ACTIVE ревізії сім'ї |
| Образ і `APP_VERSION` у ревізії | лише початкова ревізія | так, нова ревізія на кожен деплой |
| `task_definition` і `desired_count` сервісу | `ignore_changes` | так (`update-service`, `desired-count 1`) |
| Мережа, SG, circuit breaker, Cloud Map, API Gateway, ролі | так | ні |

- Зміна task definition у Terraform створює нову ревізію. Наступний деплой бере її як основу й підставляє образ. Terraform не повертає задеплоєний образ назад.
- Ревізії, зареєстровані workflow, Terraform не бачить як drift: він відстежує лише власну ревізію.

## Секрети (SSM Parameter Store)

Створюються власником **після** підготовки staging-БД і **до** першого деплою, тип `SecureString`, ключ `alias/aws/ssm` за замовчуванням:

| Параметр | Значення |
|---|---|
| `/massage-staging/booking/database-url` | URL runtime-ролі (`booking_app`) для staging-БД, з TLS (`sslmode=require` або без `sslmode`). Можна pooler-endpoint Neon. |
| `/massage-staging/booking/migration-database-url` | URL ролі migrator, **direct (не pooler) endpoint** Neon: Prisma migrate використовує advisory lock |

Значення не має з'являтися в історії shell, аргументах процесів, Git, чаті чи CI:

```sh
export AWS_PROFILE=massage
umask 077
f="$(mktemp)"
# вставити URL у файл редактором (не через echo в командному рядку), потім:
aws ssm put-parameter --region eu-west-3 --type SecureString \
  --name /massage-staging/booking/database-url --value "file://$f"
rm -f "$f"
```

Те саме зробіть для `migration-database-url`. Перевірка без виводу значення:

```sh
aws ssm describe-parameters --region eu-west-3 \
  --parameter-filters Key=Name,Option=BeginsWith,Values=/massage-staging/booking/
```

## Neon

**Фактичний стан БД не перевірено.**
- Єдиний локальний доступ до Neon — кореневий `.env`, читати який заборонено. `neonctl` не встановлено.
- Однозначно визначити staging-доступ неможливо: за `BACKEND_HANDOFF.md` невідомо, чи `.env` вказує на окрему dev/staging-гілку, чи на «основну» БД.
- Підключень до Neon не було.

З коду, міграцій і документації репозиторію відомо:
- **4 міграції Prisma** у схемі `public`: `init`, `add_marketing_consent_pending`, `rename_pending_to_email_verified`, `add_email_verification_sent_at`. Це одна таблиця `User`, enum `UserStatus` і `_prisma_migrations`.
- **Регіон staging-БД Neon (`massage-staging`) — `aws eu-central-1` (Франкфурт)**, за ім'ям хоста в лозі задачі міграцій 2026-10-26. Отже, міжрегіональна затримка Париж → Франкфурт. Раніше за ім'ям хоста з `.env` визначено `eu-west-2` (`ARCHITECTURE_READINESS.md`), але це інша БД.
- **У наявній БД, імовірно, є таблиці й історія міграцій.** У `BACKEND_HANDOFF.md` записано, що `prisma migrate status` працював, а міграції застосовувались до появи окремих ролей migrator/app. Відсутність клієнтів не означає порожньої БД.

**Ризик для наявної БД.** Раннер міграцій видає `booking_app` права лише на таблиці, **власником яких є роль migrator** (`relowner = current_user`). Якщо таблиці створено іншою роллю (наприклад, власником Neon за замовчуванням):
- раннер мовчки пропустить їх;
- API стане `ready` (readiness робить лише `SELECT 1`), але запити до `User` падатимуть через відсутність прав;
- наступні `ALTER TABLE` від migrator не виконаються, бо він не власник.

**Рекомендація: окрема порожня staging-БД** (гілка або проєкт Neon) з ролями, як у `docker/postgres/init/10-booking-roles.sh`:
- `booking_migrator` — власник об'єктів, `CREATE` у `public`;
- `booking_app` — лише `CONNECT` і `USAGE`;
- без default privileges.

Тоді перший деплой застосує всі 4 міграції з нуля, а права видасть раннер. Перенесення наявних таблиць (`ALTER TABLE … OWNER TO booking_migrator`) чи `public → booking` — лише окремим планом.

Перевірки staging-БД, коли власник надасть доступ (read-only):
- `SELECT version()`;
- схеми й таблиці з власниками (`pg_tables`);
- `_prisma_migrations` (назви, `finished_at`, `rolled_back_at`);
- ролі `booking_migrator` і `booking_app` (`rolsuper`, `rolbypassrls`) та їхні гранти;
- `pg_stat_ssl` для свого з'єднання.

## Cloud Map: health check

Після першого `apply` контрольний `plan` показав `1 to add, 3 to change, 1 to destroy`. Причина:
- порожній блок `health_check_custom_config {}` провайдер AWS (v6.69.1) не передає в API, тож сервіс Cloud Map створено **без** custom health check;
- через це кожен `plan` хоче перестворити сервіс Cloud Map, а слідом — оновити `service_registries` сервісу ECS, `integration_uri` інтеграції та політику ролі деплою (вміст політики той самий, змінюється лише порядок обчислення).

Виправлення — `failure_threshold = 1` у блоці (атрибут застарілий, але AWS і так завжди використовує 1).

**Застосовано 2026-10-27 під час паузи** (`desired_count = 0`, екземплярів у Cloud Map немає):
- `plan` показував 1 to add, 3 to change, 1 to destroy; фактичний `apply` — **1 added, 0 changed, 1 destroyed**. Cloud Map перестворив сервіс з тим самим ID (`srv-qx53trey2blbnlxo`), тож ARN не змінився, і сервіс ECS, інтеграція та політика деплою оновлення не потребували.
- `aws servicediscovery get-service` → `HealthCheckCustomConfig: {"FailureThreshold": 1}`.
- Контрольний `plan` — **`No changes`** (лише попередження про застарілий `failure_threshold`).

**Перевірка після виправлення** (той самий день, ревізія `massage-staging-booking-api:2`, без міграцій):
- задача `HEALTHY` в ECS; Cloud Map перші ~30 с після реєстрації показував `UNHEALTHY`, потім ECS передав `HEALTHY`. API Gateway відповідав 200 вже в цей проміжок;
- через HTTPS `/health/live` → 200, `/health/ready` → 200 з версією `0e93e68ff7f2418eefe8c762b55588973034b32a`;
- після перевірки staging повернуто на паузу: `desired_count = 0`, running/pending 0, задач, екземплярів Cloud Map, ENI задачі й публічних IPv4 немає; URL відповідає 500.

Повторно застосовувати виправлення не потрібно.

## Workflow `Staging deploy (booking)`

`workflow_dispatch` лише на `develop`. Вхідні дані: `commit_sha`, `api_digest`, `migrate_digest`, `run_migrations` (за замовчуванням `true`), `verify_auth` (за замовчуванням `true`: після readiness `GET /api/me` без токена має дати `401 AUTH_REQUIRED` з `WWW-Authenticate: Bearer`, `check-auth.sh`; `false` — лише для образів без Firebase-автентифікації, наприклад відкат на `0e93e68`).

**Job `verify`** (`actions: read`, `contents: read`, без AWS):
1. Формат SHA (40 hex) і digest (`sha256:` + 64 hex).
2. Коміт є в історії `develop`: `compare <sha>...<вершина develop>` має статус `identical` або `ahead`. Коміти лише з `main` чи робочих гілок відхиляються.
3. Для цього SHA є успішний push-CI на `develop`.
4. Для цього SHA є успішний run `ECR publish`, і його artifact `ecr-publish-<sha>` містить рівно ці digest, репозиторії, теги й registry (`verify-publish-result.sh`).

**Job `deploy`** (`environment: staging`, `id-token: write`, `contents: read`):
1. **Repository variables** перевіряються за форматом.
2. **Вхід в AWS** роллю `AWS_STAGING_DEPLOY_ROLE_ARN`.
3. **ECR:** тег `<sha>` в обох репозиторіях має саме ці digest. Теги immutable, тож тег надійно прив'язує digest до коміту.
4. **Поточна ревізія сервісу** записується: що саме зараз задеплоєно.
5. **Міграції** (якщо `run_migrations`):
   - нова ревізія `…-booking-migrate` з образом за digest;
   - `run-task` у public subnet, SG `migrate`, public IP;
   - очікування `STOPPED` до 20 хв.
   - Успіх — **лише exit code 0** контейнера `booking-migrate` (`check-migration-task.sh`). Інакше API не оновлюється.
   - Логи міграції workflow не виводить: логи Actions у публічному репозиторії публічні. Він друкує назву потоку в CloudWatch.
6. **API:**
   - нова ревізія `…-booking-api` з образом за digest і `APP_VERSION=<sha>`;
   - `update-service --desired-count 1`;
   - очікування завершеного rollout до 25 хв (`check-service-deployment.sh`): ревізія та сама, `rolloutState = COMPLETED`, одне розгортання, усі task запущені. Відкат circuit breaker на попередню ревізію — помилка.
7. **Health** за HTTPS: `GET <STAGING_API_BASE_URL>/health/ready` має повернути 200, `status: ready` і `version` = SHA (`check-readiness.sh`). Так перевіряється, що відповідає саме новий образ і що він бачить БД.
8. **Автентифікація** (якщо `verify_auth`): `GET <STAGING_API_BASE_URL>/api/me` без токена → `401 AUTH_REQUIRED` (`check-auth.sh`). Health не доводить, що бізнес-API налаштоване; цей крок доводить, що `/api/me` існує і вимагає токен, не звертаючись до Firebase. Разом із `REQUIRE_FIREBASE_AUTH=true` у task definition (ще не додано) неналаштований Firebase зупиняє задачу ще на старті.
9. **Summary:** нова й попередня ревізії, образи й інструкція з відкату.

**Одночасність:** `concurrency: staging-deploy` без скасування, тож одночасно йде один деплой. Якщо в черзі чекає кілька запусків, GitHub залишає лише найновіший.

**Права ролі `massage-staging-github-deploy`:**
- trust — лише `sub` `repo:OlehDribko@131261254/Massage-backend@1318544830:environment:staging` і `aud`;
- `ecr:DescribeImages` на два репозиторії;
- `ecs:DescribeTaskDefinition` і `ecs:RegisterTaskDefinition` на `*`, бо ці дії не підтримують обмеження за ресурсом;
- `ecs:RunTask` лише для сім'ї `…-booking-migrate:*` і лише в кластері `massage-staging` (`ecs:cluster`);
- `ecs:DescribeTasks` на task цього кластера;
- `ecs:DescribeServices` і `ecs:UpdateService` лише на сервіс `booking-api`;
- `iam:PassRole` лише на 4 ролі booking-задач і лише для `ecs-tasks.amazonaws.com`.

Прав на ECR push/delete, IAM, інфраструктуру, логи й Terraform state немає. Роль публікації (`sub` `…:ref:refs/heads/develop`) і роль деплою (`…:environment:staging`) взаємно недоступні.

**Відкат застосунку.**
- **Автоматичний:** circuit breaker повертає попередню ревізію, якщо нові task не стають healthy. Workflow тоді завершується помилкою.
- **Ручний:** запустити workflow з попереднім SHA і його digest (artifact його `ECR publish` run, у summary видно попередній образ) і `run_migrations = false`.
- **БД ніколи не відкочується автоматично.** Старий образ має працювати з новішою схемою, тож міграції пишуться в стилі expand/contract.

**Тести критичної логіки:** `.github/scripts/staging-deploy/test.sh`, 36 сценаріїв без AWS. Серед них:
- підміна образу лише за digest;
- заміна `APP_VERSION`, видалення read-only полів;
- відмова для тегу, чужого registry, другого контейнера;
- розбіжність artifact, переставлені digest;
- exit code міграції 0/1/відсутній/ще працює;
- rollout завершено, в процесі, впав, відкочено circuit breaker, 0 task;
- readiness з іншою версією, 503 БД, 503 API Gateway, не-JSON.

Їх запускає CI job `deploy-scripts` разом зі shellcheck.

## Порядок першого запуску

Дії, позначені **[власник]**, потребують окремого рішення або доступу; нічого з цього ще не виконано.

1. **[власник]** Вибір HTTPS-схеми (рекомендовано A) і злиття PR у `develop`, потім у `main`, бо `workflow_dispatch` має бути в default branch.
2. **[власник]** Staging-БД у Neon: окрема гілка або проєкт, ролі `booking_migrator`/`booking_app`, перевірки з розділу «Neon».
3. **[власник]** SSM-параметри (розділ «Секрети»).
4. **[власник]** GitHub environment `staging`: Deployment branches — лише `develop`; за бажанням required reviewer, доступно для публічних репозиторіїв на GitHub Free. Без цього environment буде створено автоматично без обмежень під час першого запуску.
5. **[власник → погоджений apply]** У `infra/environments/staging`: `terraform plan -out=staging-deploy.tfplan` з образами коміту `0e93e68` (`terraform.tfvars` або `-var`). Очікується **38 to add, 0 to change, 0 to destroy**. Потім `terraform apply staging-deploy.tfplan` і контрольний `plan`, який має показати `No changes`.
6. **Repository variables** — з `terraform output deploy_workflow_variables`:
   - `AWS_STAGING_DEPLOY_ROLE_ARN`;
   - `STAGING_ECS_CLUSTER`, `STAGING_ECS_SERVICE`;
   - `STAGING_API_TASK_FAMILY`, `STAGING_MIGRATE_TASK_FAMILY`;
   - `STAGING_MIGRATE_SUBNET_IDS`, `STAGING_MIGRATE_SECURITY_GROUP`, `STAGING_MIGRATE_LOG_GROUP`;
   - `STAGING_API_BASE_URL`.

   `AWS_ACCOUNT_ID` і `AWS_REGION` уже є.
7. **[власник]** Перший запуск:

   ```sh
   gh workflow run staging-deploy.yml --ref develop \
     -f commit_sha=<sha> -f api_digest=sha256:… -f migrate_digest=sha256:… -f run_migrations=true
   ```

   Для коміту, що містить цей workflow, спершу потрібні push-CI і `ECR publish`.
8. Після перевірок деплою — пауза, якщо staging не потрібен постійно (розділ «Пауза staging»).

## Пауза staging

Режим для перерв між перевірками: API не працює, а все потрібне для повторного запуску лишається на місці. Виконує **[власник]** зі своїм профілем (`AWS_PROFILE=massage`). Роль деплою для цього не потрібна, а workflow паузи немає.

**Зберігається:**
- **Neon** (поза AWS): БД, ролі, дані, історія міграцій. Під час паузи до неї ніхто не підключається.
- **SSM-параметри.**
- **Образи ECR.** Теги `IMMUTABLE`; lifecycle-правило видаляє лише untagged-образи, старші за 30 днів, а опубліковані образи мають тег SHA.
- **Ревізії task definition, сервіс (з `desired_count = 0`), API Gateway, VPC link, Cloud Map, ролі, SG.**

**Не зберігається:** логи CloudWatch старші за `log_retention_days` (14 днів) видаляються як завжди.

### Зупинка

```sh
export AWS_PROFILE=massage AWS_REGION=eu-west-3
aws ecs update-service --cluster massage-staging --service booking-api \
  --desired-count 0 --query 'service.desiredCount'
aws ecs wait services-stable --cluster massage-staging --services booking-api
```

Не запускайте зупинку, поки триває деплой (workflow `Staging deploy` у стані `in_progress`). Інакше крок rollout у workflow завершиться помилкою.

### Перевірка паузи

```sh
# 1. Сервіс: desired 0, running 0, pending 0, одне розгортання
aws ecs describe-services --cluster massage-staging --services booking-api \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,deployments:length(deployments)}'

# 2. Жодної задачі в кластері, зокрема задач міграцій: 0
aws ecs list-tasks --cluster massage-staging --desired-status RUNNING --query 'length(taskArns)'

# 3. Жодного екземпляра в Cloud Map: 0
sid="$(aws servicediscovery list-services --query "Services[?Name=='booking-api'].Id" --output text)"
aws servicediscovery list-instances --service-id "$sid" --query 'length(Instances)'

# 4. Немає ENI задач, отже немає публічної IPv4 задачі: 0
sg="$(aws ec2 describe-security-groups --filters Name=group-name,Values=massage-staging-api --query 'SecurityGroups[0].GroupId' --output text)"
aws ec2 describe-network-interfaces --filters Name=group-id,Values="$sg" --query 'length(NetworkInterfaces)'

# 5. Публічний URL відповідає помилкою від API Gateway (перевірено: 500 {"message":"Internal Server Error"})
curl -s -o /dev/null -w '%{http_code}\n' "$(gh variable get STAGING_API_BASE_URL)/health/live"
```

ENI задачі звільняється через кілька хвилин після зупинки. Якщо в п. 4 ще `1`, повторіть пізніше.

### Залишкові витрати під час паузи

Тарифи — з розділу «Кошторис» (USD, on-demand, до кредитів і Free Tier). Ціни за добу — місячна ціна / 30.

**Припущення:** задач немає (пауза перевірена, див. вище); у ECR лише образи коміту `0e93e68`; логи до 0.1 GB; до URL ніхто не звертається. Якщо хоч одне з них не виконується, сума буде іншою.

| Ресурс | За добу |
|---|---|
| Fargate, public IPv4 задачі | 0 (задач немає) |
| Route 53 private hosted zone (namespace Cloud Map), $0.50/міс. | ≈ 0.017 |
| Cloud Map: зареєстровані екземпляри | 0 (екземплярів немає) |
| API Gateway HTTP API, VPC link V2 | 0 без запитів (погодинної плати немає) |
| ECR: ≈ 0.33 GB (2 образи коміту `0e93e68`), $0.10/GB-міс. | ≈ 0.001; росте з кожною публікацією |
| CloudWatch Logs, зберігання (< 0.1 GB) | < 0.001 |
| ECS-кластер, task definitions, IAM, SG, VPC, subnets, IGW | 0 |
| SSM Standard, ключ `aws/ssm` | 0 |
| S3 state (кілька KB) | ≈ 0 |
| **Разом без запитів** | **≈ $0.02 на добу (≈ $0.55 на місяць)** |

- **URL API Gateway лишається публічним.** Запити до нього можуть тарифікуватися, навіть коли відповідь помилкова (під час паузи — 500): виходимо з того, що тарифікуються.
- **Оцінка під постійним потоком запитів — ≈ $0.43 на добу.** Це розрахунок за припущеннями, а не гарантована верхня межа: throttling працює за принципом best effort, і жорсткого ліміту витрат немає (див. «Кошторис»).

  Склад:

  | Стаття | Припущення | За добу |
  |---|---|---|
  | Базові витрати паузи | таблиця вище | ≈ 0.02 |
  | HTTP API | 172 800 запитів (2 rps цілодобово) × $1.17/млн | ≈ 0.20 |
  | Виклики Cloud Map | один discovery на запит × $1/млн | ≈ 0.17 |
  | Access logs | ≈ 350 B на запис → ≈ 0.06 GB × $0.5985/GB | ≈ 0.04 |
  | Вихідний трафік | відповіді 500 ≈ 300 B → ≈ 0.05 GB × $0.09/GB | ≈ 0.005 |
  | **Разом** | | **≈ $0.43** |

  Швидкість понад 2 rps, більші записи логів або відповіді збільшать суму. Якщо потік запитів під час паузи реальний (видно в лог-групі `/apigateway/massage-staging/booking-api`), рішення — окремо: тимчасово знизити throttling або видалити stage.
- **Neon** — поза рахунком AWS.
- **Пауза довша за 60 днів без запитів:** VPC link переходить у `INACTIVE`. Перші запити після повторного запуску падатимуть, доки API Gateway не відновить інтерфейси (хвилини). Workflow-перевірка readiness у такому разі може не вкластися в час, і її треба повторити.

### Що може знову запустити сервіс

Перевірено за кодом і в акаунті 2026-10-24.

**Сам по собі сервіс не запускається:**

| Механізм | Чому не запускає під час паузи |
|---|---|
| Terraform `apply` | `desired_count` у `ignore_changes`. Якщо сервіс буде перестворено, його створять з `desired_count = 0`. |
| CI (`ci.yml`, push/PR) | AWS не використовує |
| `ECR publish` | лише `workflow_dispatch`; роль публікації не має прав на ECS |
| `AWS OIDC check` | лише `workflow_dispatch`; read-only |
| Circuit breaker ECS | відкочує ревізію, `desired_count` не змінює |
| App Auto Scaling, EventBridge Scheduler / Rules | у акаунті немає жодного scalable target, розкладу чи правила; Terraform їх не описує |

**Запустити сервіс може лише людина:** `Staging deploy` (лише `workflow_dispatch`, job у environment `staging`, ставить `desired-count 1`) або ручний `update-service` з адмін-профілем.

Щоб випадковий запуск workflow під час паузи не стартував задачі, увімкніть у environment `staging` **required reviewer**. Тоді job деплою чекатиме схвалення, перш ніж отримає AWS-доступ.

### Повторний запуск

**Той самий образ, без міграцій.** Схема БД під час паузи не змінювалась.

```sh
export AWS_PROFILE=massage AWS_REGION=eu-west-3
aws ecs update-service --cluster massage-staging --service booking-api \
  --desired-count 1 --query 'service.taskDefinition'
aws ecs wait services-stable --cluster massage-staging --services booking-api
base="$(gh variable get STAGING_API_BASE_URL)"
curl -s "$base/health/ready"   # очікується 200 і version = SHA останнього деплою
```

- Сервіс стартує з тією ревізією, яка була задеплоєна до паузи. Ревізії, створені Terraform під час паузи, підхопить лише наступний деплой.
- Compute Neon після простою прокидається за кілька секунд. Перший `/health/ready` може дати 503 `database_unavailable` (`READINESS_TIMEOUT_MS` = 2000): повторіть через 10–20 с.

**Новий образ:** звичайний запуск `Staging deploy` (розділ «Workflow»). Він сам поставить `desired-count 1`; `run_migrations = true`, якщо в коміті є нові міграції.

Після повторного запуску витрати повертаються до ≈ $0.52 на добу (розділ «Кошторис»).
