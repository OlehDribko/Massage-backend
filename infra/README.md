# Інфраструктура (Terraform)

Перший етап: **bootstrap** — S3 bucket для Terraform state. Мережа, ECR, ECS, ALB, OIDC і деплой тут ще не описані. Neon залишається зовнішньою БД і Terraform-ом не керується.

```
infra/
  bootstrap/                      # S3 bucket для state (спочатку локальний state)
    versions.tf                   # Terraform ~> 1.16, hashicorp/aws ~> 6.69
    providers.tf                  # регіон, allowed_account_ids, default_tags; без профілю
    variables.tf                  # aws_account_id, region (eu-west-3), state_bucket_prefix
    main.tf                       # bucket і його налаштування
    outputs.tf                    # ім'я/ARN bucket, ключі state
    .terraform.lock.hcl           # точні версії й хеші провайдера (darwin_arm64, linux_amd64)
    terraform.tfvars.example      # шаблон значень змінних
    backend.tf.example            # блок backend "s3" для перенесення state
  backend-config/
    bootstrap.s3.tfbackend.example
    staging.s3.tfbackend.example
    production.s3.tfbackend.example
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
- локальний `terraform.tfstate` (до перенесення) не комітиться, не пересилається й не кладеться в Docker build context (`infra` виключено в `.dockerignore`);
- plan-файли (`*.tfplan`) теж можуть містити чутливі значення й не комітяться.

## Витрати

S3 тарифікується за обсяг збережених даних (з versioning — разом зі старими версіями state), за кількість запитів і за вихідний трафік. Для одного невеликого state суми зазвичай малі, але не нульові. Актуальні ціни для `eu-west-3` дивіться на сторінці тарифів Amazon S3. Очищення старих версій (lifecycle rule для noncurrent versions) поки не налаштоване — це окреме рішення: воно зменшує витрати, але скорочує історію для відновлення.

## Запуск (лише для майбутнього узгодженого запуску)

> Команди нижче змінюють AWS-акаунт. Виконуйте їх лише після окремого рішення. Поки що `plan` і `apply` не запускалися.

### 1. Облікові дані та перевірка акаунта

Конфігурація не містить профілю, він задається змінною середовища:

```sh
aws login --profile massage                      # тимчасова сесія
export AWS_PROFILE=massage
aws sts get-caller-identity --query Account --output text
```

Переконайтеся, що виведений ID — саме очікуваний акаунт. Той самий ID вкажіть у `terraform.tfvars`. Якщо акаунт інший, `allowed_account_ids` зупинить `plan`.

Підтримку сесій `aws login` у Terraform AWS provider і в S3 backend поки не перевірено. Якщо Terraform не бачить облікових даних профілю `massage`, створіть окремий профіль, який отримує тимчасові облікові дані через `credential_process` з активної сесії `aws login`. Ключі при цьому ніде не зберігаються.

Запис у `~/.aws/config` (локальний файл користувача, не репозиторій):

```ini
[profile massage-terraform]
region = eu-west-3
credential_process = aws configure export-credentials --profile massage --format process
```

Далі `aws login --profile massage`, `export AWS_PROFILE=massage-terraform` і та сама перевірка акаунта. Коли сесія `aws login` спливає, `credential_process` перестає видавати облікові дані: треба знову виконати `aws login`.

Не запускайте `export-credentials` з виводом у термінал. Не копіюйте ключі в `*.tfvars`, `*.tfbackend`, змінні в репозиторії чи будь-які інші файли.

### 2. init → validate → plan → перегляд → apply

```sh
cd infra/bootstrap
cp terraform.tfvars.example terraform.tfvars    # вказати aws_account_id
terraform init                                   # локальний state, backend не налаштований
terraform fmt -check -recursive ..
terraform validate
terraform plan -out=bootstrap.tfplan
```

Перегляньте plan. Очікується створення 6 ресурсів:
- `aws_s3_bucket`;
- `aws_s3_bucket_ownership_controls`;
- `aws_s3_bucket_public_access_block`;
- `aws_s3_bucket_versioning`;
- `aws_s3_bucket_server_side_encryption_configuration`;
- `aws_s3_bucket_policy`.

Змін чи видалень бути не повинно. Перевірте ім'я bucket і регіон. Лише тоді:

```sh
terraform apply bootstrap.tfplan
terraform output
```

Після цього в `infra/bootstrap` лежить **локальний** `terraform.tfstate`. Не видаляйте його до перенесення.

### 3. Перенесення bootstrap state у S3 (окремий крок)

```sh
cd infra/bootstrap
cp backend.tf.example backend.tf
cp ../backend-config/bootstrap.s3.tfbackend.example ../backend-config/bootstrap.s3.tfbackend
# у bootstrap.s3.tfbackend вкажіть bucket = значення `terraform output -raw state_bucket_name`
terraform init -migrate-state -backend-config=../backend-config/bootstrap.s3.tfbackend
```

Terraform запитає підтвердження копіювання наявного state у backend `s3`.

Перевірка перенесення:

```sh
terraform state list        # ті самі 6 ресурсів, тепер читаються з S3
terraform plan              # "No changes"
aws s3api head-object --bucket <bucket> --key bootstrap/terraform.tfstate
```

Після успішної перевірки:
- закомітьте `backend.tf` окремим PR;
- `bootstrap.s3.tfbackend` лишається локальним, бо `*.tfbackend` ігнорується; ім'я bucket не секрет, і його можна буде комітити, коли з'явиться CI для Terraform;
- локальні `terraform.tfstate` і `terraform.tfstate.backup` можна видалити лише після цього, бо вони дублюють state із чутливими даними.

## Перевірки без AWS

Ті самі перевірки виконує job `terraform` у CI (`.github/workflows/ci.yml`). Він працює без облікових даних AWS і без backend і не запускає `plan`/`apply`. Lock-файл там лише читається (`-lockfile=readonly`), тож розбіжність версії провайдера з lock-файлом робить job червоним. Локально:

```sh
cd infra/bootstrap
terraform fmt -check -recursive ..
terraform init -backend=false -input=false -lockfile=readonly
terraform validate
```

Вони не звертаються до AWS: `init -backend=false` лише завантажує провайдер із Terraform Registry.

Lock-файл оновлюється для обох платформ:

```sh
terraform providers lock -platform=darwin_arm64 -platform=linux_amd64
```

## Що визначити перед першим `plan`

- ID акаунта, з яким звіряється `allowed_account_ids`.
- Чи влаштовує ім'я bucket за замовчуванням (`state_bucket_prefix`); чи воно вільне, покаже лише `apply`.
- Чи працює сесія `aws login` з Terraform; інакше — профіль із `credential_process` (див. вище).
- Політику зберігання старих версій state (lifecycle) і хто матиме доступ до bucket.
- IAM-розмежування staging і production state (разом із появою цих конфігурацій).
