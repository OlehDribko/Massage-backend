# Інфраструктура (Terraform)

- **bootstrap** — S3 bucket для Terraform state, GitHub Actions OIDC provider і роль перевірки входу.
- **staging foundation** — мережа (VPC, public subnets, security groups) і спільні ECR-репозиторії; **створено в AWS і перевірено**.
- **публікація образів** — IAM-роль `massage-staging-github-ecr-publish` і workflow `ECR publish (booking)`; **поки лише описані**, у AWS не створені й не запускались.

ECS, ALB, сертифікати, DNS, секрети, production і деплой ще не описані. Neon залишається зовнішньою БД і Terraform-ом не керується.

```
infra/
  bootstrap/                      # S3 bucket для state; власний state — у цьому ж bucket
    versions.tf                   # Terraform ~> 1.16, hashicorp/aws ~> 6.69
    providers.tf                  # регіон, allowed_account_ids, default_tags; без профілю
    variables.tf                  # aws_account_id, region (eu-west-3), state_bucket_prefix
    main.tf                       # bucket і його налаштування
    github_oidc.tf                # OIDC provider GitHub + роль перевірки входу (develop)
    outputs.tf                    # ім'я/ARN bucket, ключі state
    .terraform.lock.hcl           # точні версії й хеші провайдера (darwin_arm64, linux_amd64)
    terraform.tfvars.example      # шаблон значень змінних
    backend.tf                    # backend "s3" (часткова конфігурація)
  backend-config/
    bootstrap.s3.tfbackend.example
    staging.s3.tfbackend.example
    production.s3.tfbackend.example
  environments/
    staging/                      # окрема root-конфігурація, state envs/staging/terraform.tfstate
      versions.tf, providers.tf   # ті самі версії; allowed_account_ids; default_tags Environment=staging
      backend.tf                  # backend "s3" (часткова конфігурація)
      variables.tf                # акаунт, регіон, CIDR, AZ, порт API, CIDR для ALB, термін untagged
      network.tf                  # VPC, IGW, 2 public subnets, маршрути, default SG без правил
      security_groups.tf          # SG для ALB і API
      ecr.tf                      # ECR booking-api і booking-migrate
      ecr_publish_role.tf         # IAM-роль публікації образів (GitHub OIDC, develop)
      outputs.tf                  # ID для майбутніх ECS/ALB
      .terraform.lock.hcl         # власний lock-файл (darwin_arm64, linux_amd64)
      terraform.tfvars.example
```

У Git потрапляють лише `*.tf`, lock-файл і `*.example`. Ігноруються:
- `.terraform/`;
- state і його backup (`*.tfstate`, `*.tfstate.*`);
- збережені plan-файли (`*.tfplan`);
- локальні значення (`*.tfvars`, `*.tfvars.json`, `*.tfbackend`);
- crash-логи.

## Що створює bootstrap

Один S3 bucket у `eu-west-3`. Його ім'я має вигляд `<state_bucket_prefix>-<aws_account_id>-<region>`, наприклад `massage-backend-tfstate-<ACCOUNT_ID>-eu-west-3`. Імена S3 bucket спільні для всіх акаунтів AWS. ID акаунта й регіон у назві роблять збіг малоймовірним, але не гарантують, що ім'я вільне: це AWS перевіряє лише під час створення bucket. Якщо ім'я зайняте, `apply` завершиться помилкою, і треба змінити `state_bucket_prefix`.

Налаштування bucket:
- **versioning** — кожен запис state зберігає попередню версію;
- **шифрування SSE-S3** (`AES256`, ключі під керуванням S3);
- **повне блокування public access** (усі чотири прапорці) і `BucketOwnerEnforced`, тобто ACL вимкнено;
- **bucket policy** відхиляє запити без HTTPS (`aws:SecureTransport = false`) і з TLS нижче 1.2;
- **захист від видалення:** `prevent_destroy = true` і `force_destroy = false`. `terraform destroy` відмовиться видаляти bucket, а непорожній bucket не видалиться разом з об'єктами.

`allowed_account_ids = [var.aws_account_id]`: провайдер відмовиться працювати з будь-яким іншим акаунтом.

## Ключі state

Один bucket, окремі об'єкти state:

| State | Ключ |
|---|---|
| bootstrap | `bootstrap/terraform.tfstate` |
| staging | `envs/staging/terraform.tfstate` |
| production | `envs/production/terraform.tfstate` |

Блокування — нативне для S3 (`use_lockfile = true`, файл `<key>.tflock` поруч зі state). DynamoDB не використовується: у Terraform 1.16 блокування через DynamoDB позначене як deprecated.

> **Різні ключі самі по собі не розмежовують доступ.** Будь-хто з правами на bucket може читати й змінювати і staging, і production state. Розмежування — окремі IAM-політики з обмеженням за префіксом ключа:
> - `s3:ListBucket` з умовою `s3:prefix`;
> - `s3:GetObject` і `s3:PutObject` на файл state;
> - `s3:GetObject`, `s3:PutObject` і `s3:DeleteObject` на `*.tflock`.
>
> Їх ще не створено. Конфігурацій staging і production теж ще немає; є лише приклади backend-конфігурації для них.

## State містить чутливі дані

Terraform зберігає в state атрибути ресурсів відкритим текстом, зокрема значення, позначені `sensitive`. Також у state можуть потрапити паролі, рядки підключення й ключі майбутніх ресурсів. Тому:
- доступ до bucket — лише через IAM, і лише тим, кому він потрібен;
- локальні файли state (зокрема `terraform.tfstate.backup`, що лишився після перенесення) не комітяться, не пересилаються й не потрапляють у Docker build context (`infra` виключено в `.dockerignore`); тримайте їх із правами `600`;
- plan-файли (`*.tfplan`) теж можуть містити чутливі значення й не комітяться.

## Витрати

S3 тарифікується за обсяг збережених даних (з versioning — разом зі старими версіями state), за кількість запитів і за вихідний трафік. Для одного невеликого state суми зазвичай малі, але не нульові. Актуальні ціни для `eu-west-3` дивіться на сторінці тарифів Amazon S3. Очищення старих версій (lifecycle rule для noncurrent versions) поки не налаштоване — це окреме рішення: воно зменшує витрати, але скорочує історію для відновлення.

## Поточний стан

- Bucket `massage-backend-tfstate-<ACCOUNT_ID>-eu-west-3` створено через `terraform apply` (6 ресурсів).
- State самого bootstrap перенесено в цей bucket: ключ `bootstrap/terraform.tfstate`, блокування `use_lockfile`. Backend описано в `backend.tf`.
- Контрольний `terraform plan` після перенесення показує `No changes`.
| Компонент | Описано в Terraform | Створено в AWS |
|---|---|---|
| S3 bucket для state (`infra/bootstrap`) | так | так |
| GitHub OIDC provider і роль `massage-backend-github-oidc-check` (`infra/bootstrap`) | так | так; вхід з `develop` перевірено workflow `AWS OIDC check` |
| Staging: VPC, subnets, IGW, маршрути, security groups (`infra/environments/staging`) | так | так (21 ресурс разом з ECR); налаштування перевірено read-only API, контрольний `plan` — `No changes` |
| ECR `massage/booking-api`, `massage/booking-migrate` (`infra/environments/staging`) | так | так; образів ще немає |
| IAM-роль `massage-staging-github-ecr-publish` (`infra/environments/staging`) | так | **ні** |
| Workflow `.github/workflows/ecr-publish.yml` | так | не запускався |
| ALB, listeners, ECS, сертифікати, DNS, секрети, production | ні | ні |

> Команди, що змінюють AWS (`apply`, перенесення state), виконуються лише після окремого рішення.

## Облікові дані та перевірка акаунта

Конфігурація не містить профілю, він задається змінною середовища:

```sh
aws login --profile massage                      # тимчасова сесія
export AWS_PROFILE=massage
aws sts get-caller-identity --query '[Account, Arn]' --output text
```

Переконайтеся, що ID — очікуваний акаунт, а ARN належить IAM-користувачу, а не Root (`...:root`). Той самий ID має бути в `terraform.tfvars`. Якщо акаунт інший, `allowed_account_ids` зупинить `plan`.

Terraform 1.16.6 (провайдер hashicorp/aws 6.69.1 і S3 backend) працює з профілем `aws login` напряму: `AWS_PROFILE=massage` достатньо. Якщо сесія спливла, команди падають з помилкою про облікові дані; тоді знову виконайте `aws login`.

Запасний варіант на випадок, якщо інший інструмент не підтримує профіль `aws login`: окремий профіль із `credential_process` у `~/.aws/config` (локальний файл користувача, не репозиторій):

```ini
[profile massage-terraform]
region = eu-west-3
credential_process = aws configure export-credentials --profile massage --format process
```

Не запускайте `export-credentials` з виводом у термінал. Не копіюйте ключі в `*.tfvars`, `*.tfbackend`, змінні в репозиторії чи будь-які інші файли.

## Робота з bootstrap (state у S3)

Одноразово в робочій копії:

```sh
cd infra/bootstrap
cp terraform.tfvars.example terraform.tfvars                       # aws_account_id
cp ../backend-config/bootstrap.s3.tfbackend.example ../backend-config/bootstrap.s3.tfbackend
# у bootstrap.s3.tfbackend: bucket = "massage-backend-tfstate-<ACCOUNT_ID>-eu-west-3"
terraform init -backend-config=../backend-config/bootstrap.s3.tfbackend
```

Далі звичайний цикл: `terraform validate` → `terraform plan -out=bootstrap.tfplan` → перегляд → `terraform apply bootstrap.tfplan` (лише після погодження).

Основним записом інфраструктури є **state у S3** (`bootstrap/terraform.tfstate`); локальні файли state в `infra/bootstrap` більше не використовуються.

`plan` читає state з S3 і бере блокування: створює `bootstrap/terraform.tfstate.tflock` і після завершення видаляє його. Нову версію state `plan` не записує обов'язково; записує її `apply`, а також команди, що змінюють state (`state mv`, `import` тощо). Оскільки bucket версіонований, після кожного блокування лишаються старі версії й delete markers об'єкта `.tflock`. Це очікувано, але вони теж займають місце й рахуються в запитах. Не вимикайте блокування (`-lock=false`).

Перевірка, що state читається з S3:

```sh
terraform state list        # 6 керованих ресурсів + data source
terraform plan -detailed-exitcode   # код 0 = No changes
aws s3api head-object --bucket <bucket> --key bootstrap/terraform.tfstate \
  --query '{VersionId:VersionId,SSE:ServerSideEncryption}'
```

## Початковий bootstrap з нуля

Потрібен лише для нового акаунта або якщо bucket ще не існує. Backend у `backend.tf` посилається на bucket, якого тоді ще немає, тому перший запуск іде з локальним state, а `backend.tf` тимчасово відкладається:

```sh
cd infra/bootstrap
mv backend.tf backend.tf.off                     # тимчасово, не комітити
cp terraform.tfvars.example terraform.tfvars    # aws_account_id
terraform init
terraform validate
terraform plan -out=bootstrap.tfplan
```

Перегляньте plan. Очікується створення 6 ресурсів і жодних змін чи видалень:
- `aws_s3_bucket`;
- `aws_s3_bucket_ownership_controls`;
- `aws_s3_bucket_public_access_block`;
- `aws_s3_bucket_versioning`;
- `aws_s3_bucket_server_side_encryption_configuration`;
- `aws_s3_bucket_policy`.

Перевірте ім'я bucket і регіон. Далі, після погодження:

```sh
terraform apply bootstrap.tfplan
chmod 600 terraform.tfstate
```

Перед перенесенням зробіть резервну копію state поза репозиторієм із правами `600`. Перевірте, що об'єкта `bootstrap/terraform.tfstate` у bucket ще немає: потрібен саме `404`, а `403` (AccessDenied) не означає, що його немає. Потім:

```sh
mv backend.tf.off backend.tf
cp ../backend-config/bootstrap.s3.tfbackend.example ../backend-config/bootstrap.s3.tfbackend
# bucket = значення `terraform output -raw state_bucket_name`
terraform init -migrate-state -backend-config=../backend-config/bootstrap.s3.tfbackend
```

На запит «copy existing state to the new backend» відповідайте `yes`; `-force-copy` і `-reconfigure` не використовуйте. Після цього перевірка — як у розділі вище: `state list`, `plan -detailed-exitcode`, `head-object`.

Особливості:
- **Lineage і serial.** Terraform 1.16.6 під час перенесення в порожній S3 backend записує state з **новим lineage і serial 1**. Вміст ресурсів не змінюється; так поводиться сам Terraform (`internal/states/remote/state.go`, `PersistState`). Через це резервна копія локального state має інший lineage, і повернути її через `terraform state push` можна лише з `-force`, тобто з перезаписом віддаленого state. Робіть це тільки свідомо.
- **Локальні копії.** Після перенесення в `infra/bootstrap` лишаються порожній `terraform.tfstate` і `terraform.tfstate.backup` з попереднім state. Обидва ігноруються Git; тримайте їх із правами `600` і видаляйте лише окремим рішенням.

## GitHub Actions → AWS через OIDC

`github_oidc.tf` описує:
- `aws_iam_openid_connect_provider.github` — провайдер `https://token.actions.githubusercontent.com` з audience `sts.amazonaws.com`. `thumbprint_list` не задано: для GitHub IAM перевіряє сертифікат за власним списком довірених CA. Перед додаванням провайдера read-only запитом перевірено, що в акаунті OIDC-провайдерів ще немає.
- `aws_iam_role.github_oidc_check` (`massage-backend-github-oidc-check`) — **роль перевірки входу, а не роль деплою**.

**Trust policy і permissions policy — різні речі.**
- **Trust policy** вирішує, *хто може взяти роль*. Тут це лише токен GitHub Actions з точними значеннями `aud` і `sub` (`StringEquals`, без wildcard), дія `sts:AssumeRoleWithWebIdentity`.
- **Permissions policies** вирішують, *що можна робити з роллю*. У цієї ролі їх немає взагалі: ні inline, ні managed. `aws_iam_role_policies_exclusive` і `aws_iam_role_policy_attachments_exclusive` з порожніми списками фіксують це в Terraform: будь-яку політику, додану вручну, наступний `plan` покаже, а `apply` прибере.

Отже, сесія не має доступу до S3 state, ECR, ECS, IAM і не може нічого створювати. Працює лише `sts get-caller-identity`, якому дозволи не потрібні. Максимальна тривалість сесії ролі — 1 година; workflow просить 15 хвилин.

**Точний `sub`.** У репозиторії ввімкнено immutable subject claims. GitHub REST API `GET /repos/OlehDribko/Massage-backend/actions/oidc/customization/sub` повертає:
- `use_immutable_subject: true`;
- `use_default: true` (власного шаблону немає);
- `sub_claim_prefix: repo:OlehDribko@131261254/Massage-backend@1318544830`.

За документацією GitHub (OIDC reference, «Immutable subject claims») для гілки формат такий: `repo:OWNER@OWNER-ID/REPO@REPO-ID:ref:refs/heads/BRANCH`. Роль довіряє рівно одному значенню:

```
repo:OlehDribko@131261254/Massage-backend@1318544830:ref:refs/heads/develop
```

Наслідки:
- запуски з інших гілок, тегів і PR, а також job з `environment:` (тоді `sub` має вигляд `...:environment:NAME`) роль не отримають;
- якщо репозиторій буде перестворено (нові ID) або змінено шаблон `sub`, trust policy треба оновити (змінні `github_owner_id`, `github_repository_id`).

**Workflow `.github/workflows/aws-oidc-check.yml`:**
- лише `workflow_dispatch`;
- job виконується тільки для `refs/heads/develop`;
- права `contents: read` і `id-token: write` лише в цього job (на рівні workflow — `permissions: {}`);
- `aws-actions/configure-aws-credentials` v6.3.0 закріплено за SHA;
- сесія 15 хвилин, `allowed-account-ids`;
- далі `sts get-caller-identity` і точне порівняння акаунта та ARN `assumed-role/<role>/gha-oidc-check-<run_id>`.

Токени й облікові дані не виводяться. Workflow не входить у `CI / required`; звичайний CI і далі працює без облікових даних AWS.

**Змінні GitHub** (repository variables, не secrets; задаються після `apply`):

| Змінна | Значення |
|---|---|
| `AWS_OIDC_CHECK_ROLE_ARN` | `terraform output -raw github_oidc_check_role_arn` |
| `AWS_ACCOUNT_ID` | ID акаунта (12 цифр) |

**Порядок застосування:**
1. **Merge** цього PR у `develop`, а потім у `main`. `workflow_dispatch` можна запустити лише тоді, коли файл workflow є в default branch (`main`). Сам запуск — на гілці `develop` (`gh workflow run aws-oidc-check.yml --ref develop`).
2. **Локальний plan** в `infra/bootstrap`: `terraform plan -out=oidc.tfplan`. Очікується лише додавання OIDC provider, ролі та двох exclusive-ресурсів; змін і видалень S3-ресурсів бути не повинно.
3. **Погоджений apply** цього plan.
4. **Налаштування variables** `AWS_OIDC_CHECK_ROLE_ARN` і `AWS_ACCOUNT_ID` у GitHub (Settings → Secrets and variables → Actions → Variables).
5. **Ручна перевірка OIDC:** запуск `AWS OIDC check` на `develop`. Очікуваний результат: `OIDC sign-in OK: arn:aws:sts::<ACCOUNT_ID>:assumed-role/massage-backend-github-oidc-check/gha-oidc-check-<run_id>`.

## Staging: мережа та ECR

`infra/environments/staging` — окрема root-конфігурація. Мережу й ECR із цього розділу **створено в AWS** (`apply` 21 ресурсу, state `envs/staging/terraform.tfstate`) і перевірено read-only API; контрольний `plan` показує `No changes`. API ще ніде не запускається. **ALB і listeners не створені й у цій конфігурації не описані**: є лише security group для майбутнього ALB.

### Відокремлення від bootstrap
- **Окремий state.** Об'єкт `envs/staging/terraform.tfstate` лежить у тому ж bucket, але це окремий state зі своїм блокуванням (`use_lockfile`). `plan`/`apply` staging не торкаються ресурсів bootstrap, і навпаки.
- **Власні файли.** Окремі `backend.tf`, змінні, lock-файл і `default_tags` (`Environment = staging`). Ініціалізація: `terraform init -backend-config=../../backend-config/staging.s3.tfbackend`.
- **Доступ.** Як і для інших ключів state, розмежування доступу між bootstrap і staging у bucket ще не налаштоване (див. «Ключі state»).

### Схема

```
Internet
   │  HTTP 80 (лише майбутній redirect на HTTPS) / HTTPS 443
   │  (alb_ingress_cidrs, за замовчуванням 0.0.0.0/0)
   ▼
[SG alb] ── майбутній ALB і listeners (не описані й не створені)
   │  TCP app_port (3001) лише до SG api
   ▼
[SG api] ── майбутні ECS Fargate tasks, assign_public_ip = true (не описані й не створені)
   │  egress: TCP 443 і TCP 5432 → 0.0.0.0/0
   ▼
Internet Gateway → ECR, CloudWatch Logs, Neon, Brevo, Firebase

VPC 10.20.0.0/16
  public subnet eu-west-3a  10.20.0.0/24 ┐
  public subnet eu-west-3b  10.20.1.0/24 ┴─ route table: 0.0.0.0/0 → IGW
```

| Ресурс | Призначення |
|---|---|
| `aws_vpc.main` | окрема VPC, DNS увімкнено |
| `aws_default_security_group.main` | default SG без жодних правил, щоб ніщо не використовувало її випадково |
| `aws_internet_gateway.main`, `aws_route_table.public`, `aws_route.public_internet`, `aws_route_table_association.public` | вихід в інтернет для public subnets |
| `aws_subnet.public` (2) | різні AZ; `map_public_ip_on_launch = false` |
| `aws_security_group.alb` + правила | вхід 80/443 з `alb_ingress_cidrs`; вихід лише TCP `app_port` до SG api |
| `aws_security_group.api` + правила | вхід лише TCP `app_port` від SG alb; вихід TCP 443 і 5432 |
| `aws_ecr_repository.booking` (2) + `aws_ecr_lifecycle_policy.booking` (2) | `massage/booking-api` і `massage/booking-migrate`, спільні для staging і production |

NAT Gateway, Elastic IP і VPC endpoints не описані. Без NAT Fargate tasks у public subnets можуть дістатися ECR, CloudWatch, Neon, Brevo і Firebase лише з публічною IP-адресою. Тому майбутній ECS-сервіс і задача міграцій **потребуватимуть `assign_public_ip = true`** у `network_configuration`; без цього pull образу й вихідні з'єднання не працюватимуть.

**Порт 80** на SG alb призначений лише для майбутнього listener із redirect на HTTPS, а не для обслуговування API по HTTP. **Перед публічними сценаріями авторизації** (вхід, токени, підтвердження email) потрібні домен і сертифікат ACM: передавати облікові дані й токени по незашифрованому HTTP не можна.

### Public subnet ≠ відкритий доступ
Public subnet лише має маршрут до Internet Gateway. Чи можна достукатися до ресурсу ззовні, вирішують security groups:
- у SG api єдине вхідне правило — `app_port` **від SG alb**;
- SSH та інших прямих публічних правил немає;
- автоматичні public IP у subnets вимкнені.

Навіть із public IP task прийматиме з'єднання лише від ALB.

### Політика egress для API
Потрібні напрямки:

| Куди | Протокол / порт | Навіщо |
|---|---|---|
| ECR API, шари образів у S3 | TCP 443 | pull образу |
| CloudWatch Logs | TCP 443 | логи |
| Secrets Manager / SSM (згодом) | TCP 443 | секрети |
| Brevo API, Firebase (Google APIs) | TCP 443 | HTTPS API |
| Neon | TCP 5432 | PostgreSQL з TLS, `verify-full` |

- Правила обмежені **портами**, а не IP-адресами, бо адреси Neon, Brevo, Google і публічних endpoint-ів AWS змінюються.
- DNS (Amazon Route 53 Resolver у VPC) і Amazon Time Sync security groups не фільтрують, окремі правила для них не потрібні.
- Порт 5432 потрібен, лише якщо Neon підключається через стандартний TCP-порт PostgreSQL (так працює драйвер `pg` у застосунку).
- Звузити egress до конкретних адрес можна через VPC endpoints для сервісів AWS або через egress-проксі для зовнішніх провайдерів. Вартість endpoints залежить від типу: gateway endpoints (S3, DynamoDB) окремо не тарифікуються, interface endpoints (наприклад, ECR API, CloudWatch Logs) тарифікуються погодинно і за обсяг даних. Нових endpoints у цій конфігурації немає.

SG alb має лише один вихідний напрямок — `app_port` до SG api. Для health checks ALB цього достатньо.

### ECR: два спільні репозиторії
Dockerfile має дві цілі — `runtime` (API) і `migrate` (одноразова міграція). Для них заведено два репозиторії, `massage/booking-api` і `massage/booking-migrate`, а не один з префіксами тегів:
- окремі права: ECS-сервісу API потрібен pull лише `booking-api`, задачі міграції — лише `booking-migrate`;
- окремі результати сканування й lifecycle;
- теги однакові для обох — git SHA коміту, без префіксів `runtime-`/`migrate-`.

Репозиторіїв для ще не реалізованих сервісів (AI, Payments, Notifications) немає.

**Спільні для staging і production.** Образ збирається один раз, перевіряється в staging і потрапляє в production **за digest** (`…/massage/booking-api@sha256:…`), без повторної збірки. Тому:
- назви репозиторіїв задає окрема змінна `ecr_namespace` (`massage`), незалежна від `name_prefix` (`massage-staging`), а ресурси мають тег `Environment = shared`;
- production використовуватиме ці самі репозиторії й не створюватиме дублікатів;
- поки що ними керує root `infra/environments/staging`. Якщо пізніше знадобиться окремий спільний root, це буде перенесення записів state (`terraform state mv` або блоки `moved`/`import`), а не перестворення репозиторіїв з образами. Зараз переносити state не потрібно.

Майбутня IAM-роль production для pull має отримати доступ до цих репозиторіїв, але не право push.

Налаштування обох репозиторіїв:
- приватні;
- `IMMUTABLE` теги;
- шифрування `AES256`;
- basic scan on push;
- `force_delete = false`.

Enhanced scanning вмикається на рівні реєстру, і ця конфігурація його не змінює. Repository-level `scan_on_push` працює, поки тип сканування реєстру — `BASIC`. Read-only `aws ecr get-registry-scanning-configuration` у `eu-west-3` показав `BASIC`.

Lifecycle прибирає лише **untagged** образи, старші за `ecr_untagged_expiry_days` (30 днів). Tagged образи автоматично не видаляються, бо потрібні для rollback. Образи, на які посилається manifest list, lifecycle не видаляє, поки існує сам list.

### Можливі витрати
- **ECR** — зберігання образів (накопичується, бо tagged образи не видаляються) і трафік.
- **Публічні IPv4-адреси** — AWS тарифікує публічні IPv4 погодинно; кожен ECS task із public IP і кожен вузол ALB матиме таку адресу.
- **Передача даних в інтернет.**
- **Згодом:** ALB (погодинно і за обсяг роботи), ECS Fargate (vCPU і пам'ять), CloudWatch Logs (обсяг і зберігання).

VPC, subnets, route tables, Internet Gateway і security groups окремої плати зазвичай не мають, але передача даних тарифікується. Актуальні тарифи дивіться на сторінках цін AWS для `eu-west-3`.

### Що лишається перед ECS/ALB
- **Публікація образів у ECR:** роль і workflow описані (див. «Публікація образів у ECR»), але ще не застосовані й не запускались.
- **ECS:** кластер, task definitions для API і міграцій (CPU/пам'ять, змінні, health check `/health/ready`), task execution role (pull з ECR, логи), task role, лог-групи CloudWatch.
- **Секрети** (`DATABASE_URL`, `MIGRATION_DATABASE_URL` для Neon, ключі Brevo/Firebase): Secrets Manager або SSM Parameter Store і доступ execution role до них.
- **ALB:** сам балансувальник, listeners (443 з сертифікатом ACM; 80 лише з redirect на HTTPS), target group (`ip`, порт 3001, health check). Потрібні домен і DNS. До появи сертифіката публічні сценарії авторизації не вмикати.
- **ECS-мережа:** `assign_public_ip = true` і public subnets з outputs у `network_configuration` сервісу та задачі міграцій.
- **Невідомі дані:**
  - чи потрібен Neon саме на порту 5432, чи лише HTTPS (serverless driver), і чи дозволяє Neon доступ з будь-яких IP (allowlist Neon прив'язав би до мінливих public IP tasks);
  - домен і сертифікат;
  - чи потрібен IPv6 (зараз лише IPv4).
- **Просування образів у production:** вирішено використовувати спільні репозиторії `massage/*` і передавати образ за digest. Відкрито, чи переносити ECR в окремий спільний root, коли з'явиться production.

## Публікація образів у ECR

Описано, але **ще не створено й не запускалось**: IAM-роль у `infra/environments/staging/ecr_publish_role.tf` і workflow `.github/workflows/ecr-publish.yml`.

### Роль `massage-staging-github-ecr-publish`
- **Federated principal:** наявний GitHub OIDC provider з bootstrap, дублікат не створюється. Його ARN передається явно змінною `github_oidc_provider_arn`; валідація вимагає, щоб це був провайдер `token.actions.githubusercontent.com` в акаунті `aws_account_id`. State bootstrap цей root не читає.
- **Trust policy:** `sts:AssumeRoleWithWebIdentity`, `StringEquals` для `aud = sts.amazonaws.com` і точного immutable `sub`, без wildcard:
  `repo:OlehDribko@131261254/Massage-backend@1318544830:ref:refs/heads/develop`.
  Запуски з `pull_request` мають `sub` `…:pull_request` і роль не отримають. Будь-який job на `develop`, що запитує OIDC-токен, теоретично міг би взяти роль, тому `id-token: write` має лише job публікації; звичайний CI токенів не запитує.
- **Permissions** (одна inline-політика; набір політик зафіксовано exclusive-ресурсами):
  - `ecr:GetAuthorizationToken` на `*` — API не підтримує обмеження за ресурсом;
  - лише на `massage/booking-api` і `massage/booking-migrate`: `BatchCheckLayerAvailability`, `InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload`, `PutImage`, `BatchGetImage`, `GetDownloadUrlForLayer`, `DescribeImages`.

  Прав на видалення образів чи репозиторіїв, зміну налаштувань ECR, інфраструктуру, IAM, ECS чи S3 state немає. Роль `massage-backend-github-oidc-check` не змінюється.

### Workflow `ECR publish (booking)`
- Лише `workflow_dispatch` на `develop`; публікує коміт `github.sha` (вершину `develop` на момент запуску).
- **Job `verify-ci`** (лише `actions: read`): бере останній запуск workflow `CI` з подією `push` на `develop` для **цього самого SHA**. Якщо запуску немає, він не завершений або не `success`, публікація зупиняється. Коміти з робочих гілок (лише PR-запуски CI) не проходять.
- **Job `publish`** (`contents: read`, `id-token: write`):
  - checkout саме перевіреного SHA з перевіркою `git rev-parse HEAD`;
  - вхід через OIDC з `allowed-account-ids`;
  - `docker build --platform linux/amd64`: ціль `runtime` → `massage/booking-api`, ціль `migrate` → `massage/booking-migrate`;
  - тег — повний SHA коміту; `latest` не використовується.
- Actions закріплено за повними SHA: `checkout` v7.0.1, `configure-aws-credentials` v6.3.0, `upload-artifact` v7.0.2.
- `concurrency: ecr-publish` без скасування: одночасно йде лише одна публікація.

**Повторний і частково успішний запуск.** Перед збіркою кожного образу workflow через `ecr:DescribeImages` перевіряє, чи є тег із цим SHA:
- **тег є** — образ не збирається й не пушиться повторно, береться його фактичний digest (`result: already-published`);
- **тега немає** (`ImageNotFoundException`) — збірка, push, потім digest читається з ECR (`result: published`);
- **будь-яка інша помилка** (наприклад, AccessDenied) — зупинка, а не «образу немає».

Тож якщо перший запуск опублікував лише `booking-api`, повтор допублікує тільки `booking-migrate`. Теги в репозиторіях `IMMUTABLE`, тому перезапис неможливий і на рівні ECR.

**Результат** — `ecr-publish-result.json` в artifact `ecr-publish-<sha>` (зберігається 90 днів) і таблиця в summary запуску:

```json
{
  "commit_sha": "<40-символьний SHA>",
  "region": "eu-west-3",
  "run_id": "<id запуску>",
  "images": {
    "booking_api": {
      "repository": "massage/booking-api",
      "tag": "<SHA>",
      "digest": "sha256:…",
      "image_uri": "<account>.dkr.ecr.eu-west-3.amazonaws.com/massage/booking-api@sha256:…",
      "result": "published | already-published"
    },
    "booking_migrate": { "…": "те саме для massage/booking-migrate" }
  }
}
```

Майбутній деплой (staging, потім production) використовуватиме `image_uri` **за digest**: production отримає ті самі образи, без повторної збірки.

**Repository variables** (не secrets; постійних AWS access keys немає):

| Змінна | Значення | Стан |
|---|---|---|
| `AWS_ACCOUNT_ID` | `849110175854` | уже існує |
| `AWS_REGION` | `eu-west-3` | потрібно додати |
| `AWS_ECR_PUBLISH_ROLE_ARN` | `terraform output -raw ecr_publish_role_arn` (staging) | потрібно додати після `apply` |

**Порядок застосування і першої публікації:**
1. Merge PR у `develop`, потім `develop` → `main`: `workflow_dispatch` має бути в default branch.
2. У локальний `infra/environments/staging/terraform.tfvars` додати `github_oidc_provider_arn` — значення `terraform output -raw github_oidc_provider_arn` в `infra/bootstrap`. Змінна обов'язкова, без неї `plan` не запуститься.
3. `terraform plan -out=…` у staging. Очікується лише створення ролі, її inline-політики та двох exclusive-ресурсів, без змін мережі й ECR.
4. Погоджений `apply`.
5. Додати repository variables `AWS_REGION` і `AWS_ECR_PUBLISH_ROLE_ARN`.
6. Переконатися, що CI для поточної вершини `develop` (push) успішний, і запустити `gh workflow run ecr-publish.yml --ref develop`. Перевірити artifact з digest і образи в ECR.

**Витрати.**
- ECR тарифікується за обсяг збережених образів; tagged образи lifecycle не видаляє, тож обсяг накопичуватиметься з кожною публікацією.
- Запуски GitHub Actions витрачають хвилини runner'ів і місце для artifacts. Для публічного репозиторію на стандартних runner'ах GitHub зазвичай не бере плату за хвилини, але ліміти й умови варто перевіряти в документації GitHub.

## Резервні копії state

- **Копії до міграції** (`terraform.tfstate.backup` і копія, зроблена перед `init -migrate-state`) містять state з **попереднім lineage**. Вони фіксують стан на момент міграції й не збігаються з lineage state у S3.
- **Після міграції** основним є state у S3. Його історію зберігає versioning bucket. Окрему копію поточного state робіть так (поза репозиторієм, без виводу в термінал):

  ```sh
  (umask 077; terraform state pull > "$HOME/terraform-state-backups/massage-backend/bootstrap-remote-$(date -u +%Y%m%dT%H%M%SZ).tfstate")
  ```

  Копія через `state pull` може відрізнятися від об'єкта в S3 форматуванням і порядком записів `check_results`, але lineage, serial і ресурси збігаються.
- **Відновлення — не звичайний крок.** Перед будь-яким відновленням з'ясуйте, що саме пошкоджено, порівняйте lineage, serial і ресурси копії з поточним state і реальною інфраструктурою, і лише тоді погодьте дію окремо. Спершу варто розглянути відновлення попередньої версії об'єкта в S3 (versioning). `terraform state push -force` перезаписує віддалений state, обходячи перевірки lineage і serial. Це крайній захід, а не стандартна процедура.

## Перевірки без AWS

Ті самі перевірки виконує job `terraform` у CI (`.github/workflows/ci.yml`) — для `infra/bootstrap` і `infra/environments/staging`. Він працює без облікових даних AWS і без backend і не запускає `plan`/`apply`. Lock-файл там лише читається (`-lockfile=readonly`), тож розбіжність версії провайдера з lock-файлом робить job червоним. Локально:

```sh
terraform fmt -check -recursive infra
for dir in infra/bootstrap infra/environments/staging; do
  (cd "$dir" && terraform init -backend=false -input=false -lockfile=readonly && terraform validate)
done
```

У робочій копії, де backend уже ініціалізований (наприклад, `infra/bootstrap`), `init -backend=false` краще запускати в тимчасовій копії модуля, щоб не змінювати локальні налаштування backend.

Вони не звертаються до AWS: `init -backend=false` лише завантажує провайдер із Terraform Registry.

Lock-файл оновлюється для обох платформ:

```sh
terraform providers lock -platform=darwin_arm64 -platform=linux_amd64
```

## Відкриті рішення

- Політика зберігання старих версій state (lifecycle rule для noncurrent versions) і хто матиме доступ до bucket.
- IAM-розмежування staging і production state (разом із появою цих конфігурацій).
- Чи обмежувати роль додатково за workflow (`job_workflow_ref`), коли з'являться ролі з реальними правами (staging/production).
- Коли видаляти локальні копії state, що лишилися після перенесення (`terraform.tfstate.backup`, резервна копія поза репозиторієм).
- Чи комітити `bootstrap.s3.tfbackend` (ім'я bucket не секрет), коли знадобиться запуск Terraform з бекендом у CI.
