# Інфраструктура (Terraform)

Перший етап: **bootstrap** — S3 bucket для Terraform state. Мережа, ECR, ECS, ALB, OIDC і деплой тут ще не описані. Neon залишається зовнішньою БД і Terraform-ом не керується.

```
infra/
  bootstrap/                      # S3 bucket для state; власний state — у цьому ж bucket
    versions.tf                   # Terraform ~> 1.16, hashicorp/aws ~> 6.69
    providers.tf                  # регіон, allowed_account_ids, default_tags; без профілю
    variables.tf                  # aws_account_id, region (eu-west-3), state_bucket_prefix
    main.tf                       # bucket і його налаштування
    outputs.tf                    # ім'я/ARN bucket, ключі state
    .terraform.lock.hcl           # точні версії й хеші провайдера (darwin_arm64, linux_amd64)
    terraform.tfvars.example      # шаблон значень змінних
    backend.tf                    # backend "s3" (часткова конфігурація)
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
- локальні файли state (зокрема `terraform.tfstate.backup`, що лишився після перенесення) не комітяться, не пересилаються й не потрапляють у Docker build context (`infra` виключено в `.dockerignore`); тримайте їх із правами `600`;
- plan-файли (`*.tfplan`) теж можуть містити чутливі значення й не комітяться.

## Витрати

S3 тарифікується за обсяг збережених даних (з versioning — разом зі старими версіями state), за кількість запитів і за вихідний трафік. Для одного невеликого state суми зазвичай малі, але не нульові. Актуальні ціни для `eu-west-3` дивіться на сторінці тарифів Amazon S3. Очищення старих версій (lifecycle rule для noncurrent versions) поки не налаштоване — це окреме рішення: воно зменшує витрати, але скорочує історію для відновлення.

## Поточний стан

- Bucket `massage-backend-tfstate-<ACCOUNT_ID>-eu-west-3` створено через `terraform apply` (6 ресурсів).
- State самого bootstrap перенесено в цей bucket: ключ `bootstrap/terraform.tfstate`, блокування `use_lockfile`. Backend описано в `backend.tf`.
- Контрольний `terraform plan` після перенесення показує `No changes`.
- Конфігурацій staging і production ще немає.

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

Далі звичайний цикл: `terraform validate` → `terraform plan -out=bootstrap.tfplan` → перегляд → `terraform apply bootstrap.tfplan` (лише після погодження). Під час `plan`/`apply` Terraform бере блокування: створює `bootstrap/terraform.tfstate.tflock` і після завершення видаляє. Не вимикайте блокування (`-lock=false`).

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

## Відкриті рішення

- Політика зберігання старих версій state (lifecycle rule для noncurrent versions) і хто матиме доступ до bucket.
- IAM-розмежування staging і production state (разом із появою цих конфігурацій).
- Коли видаляти локальні копії state, що лишилися після перенесення (`terraform.tfstate.backup`, резервна копія поза репозиторієм).
- Чи комітити `bootstrap.s3.tfbackend` (ім'я bucket не секрет), коли знадобиться запуск Terraform з бекендом у CI.
