# Postman: ручна перевірка API

Колекція й шаблон environment для ручної перевірки staging:

| Файл | Що це |
|---|---|
| [`postman/massage-booking.postman_collection.json`](../postman/massage-booking.postman_collection.json) | Колекція (Postman v2.1): запити до API і вхід через Firebase REST |
| [`postman/massage-staging.postman_environment.json`](../postman/massage-staging.postman_environment.json) | Шаблон environment: заповнено лише staging URL і Firebase project ID |

Основа колекції — OpenAPI 3.1 (`services/booking/src/openapi/document.ts`). Тест `services/booking/test/postman-collection.test.ts` (входить у `npm test` і CI) перевіряє:
- кожен запит відповідає операції OpenAPI, і кожна операція має запит;
- токени відповідають ролям: публічні маршрути — без токена, `/api/admin` — лише `adminIdToken`;
- тіла запитів проходять ті самі Zod-схеми, що й API;
- у файлах немає секретів, а скрипти пишуть лише в environment і нічого не виводять.

## Стан staging (2026-11-01)

| Що | Стан |
|---|---|
| Публічні перевірки через HTTPS (health, каталог з 35 послуг, доступність, 401 без токена, 404 для вимкнених маршрутів) | **пройдено** (етап A, коміт `5221d98`) |
| Справжній вхід Firebase (email/пароль, гість, Google) | **не перевірено** |
| Профілі (sync, читання, зміна), ролі, призначення адміністратора | **не перевірено** |
| Авторизовані операції: графік, бронювання, перенесення, скасування, права доступу | **не перевірено** |
| Реальні листи (Firebase-підтвердження email, листи про бронювання) | **не перевірено** |
| Листи про бронювання (`ENABLE_BOOKING_NOTIFICATIONS`) | **вимкнено** на staging |
| Маркетингова підписка (`ENABLE_MARKETING_SUBSCRIPTION`) | **вимкнено** на staging: маршрути відповідають `404 NOT_FOUND` |
| Swagger (`ENABLE_API_DOCS`) | **вимкнено** на staging |

## Правила безпеки

- **Колекцію не запускають через Collection Runner** — ні цілком, ні папкою. Запити надсилаються вручну, по одному.
- Колекція не має ланцюжків запитів (`setNextRequest`, `sendRequest`), тож сама нічого не створює й не скасовує. Скрипти лише:
  - перевіряють, що потрібні змінні заповнені; якщо ні — запит пропускається з підказкою в Console, без значень;
  - зберігають токени, `profile.id`, `bookingId` і Idempotency-Key у **поточні значення** вибраного environment.
- Токени зберігаються лише після HTTP 200, коли токен — непорожній рядок, виданий для проєкту `firebaseProjectId`. Інакше старі значення лишаються. Скрипти не виводять у Console ні токенів, ні паролів, ні ключа.
- Postman сам показує надіслані запити в Console, а відповіді Firebase — на панелі відповіді, разом із токенами. Тому не діліться скріншотами чи експортом Console і не зберігайте приклади відповідей (Save Response) для запитів папки 1.
- Колекція **не призначає роль адміністратора**: в API такої операції немає, роль призначає власник окремою командою.
- Вхід через Google колекція не імітує. Він можливий лише в браузері, через frontend (popup чи redirect, авторизований домен у Firebase, CORS). Це окрема майбутня браузерна перевірка.

## 1. Імпорт

1. Postman → **Import** → оберіть обидва файли з теки `postman/`.
2. Праворуч угорі виберіть environment **Massage staging (local template)**.
3. Якщо ви ввійшли в акаунт Postman, колекція й environment синхронізуються з хмарою Postman. Синхронізуються лише **Initial value**; **Current value** зберігається локально. Секрети вводьте тільки в Current value, Initial value лишайте порожнім.

## 2. Ключ і дані акаунтів

- **Web API key:** Firebase Console → проєкт `massage-fr` → Project settings → General → Web API Key. Вставте його в **Current value** змінної `firebaseWebApiKey`.
  - Якщо ключ обмежено HTTP-referrer'ами сайту, Firebase відповість `403 … referer … blocked`. У такому разі потрібне окреме рішення про ключ.
- Дані акаунтів — лише в **Current value** відповідних змінних:

| Роль | Змінні | Примітка |
|---|---|---|
| Клієнт | `clientEmail`, `clientPassword` | Наявний тестовий акаунт (створено в Firebase Console) |
| Адміністратор | `adminEmail`, `adminPassword` | Інший наявний тестовий акаунт. Роль `admin` призначає власник; до того `/api/admin` відповідає 403 |
| Гість | — | Анонімний вхід, даних не потрібно |

Токени ролей зберігаються окремо (`clientIdToken` / `clientRefreshToken`, `adminIdToken` / `adminRefreshToken`, `guestIdToken` / `guestRefreshToken`), тож вхід однієї ролі не перезаписує іншу.

## 3. Вхід, підтвердження email, оновлення токена, синхронізація

Порядок для клієнта (для адміністратора те саме з запитами `Admin: …`):

1. **`1. Firebase sign-in → Client: sign in (email/password)`.** Вхід в наявний акаунт, без реєстрації. Очікування: усі тести зелені, зокрема `tokens saved to clientIdToken / clientRefreshToken`.
   - `Firebase error: INVALID_LOGIN_CREDENTIALS` — неправильний email або пароль;
   - `OPERATION_NOT_ALLOWED` — вхід за email і паролем вимкнено у Firebase.
2. **`3. Client → Profile: sync`.** Очікування: `HTTP 200`, `role: client`, `authState: registered`. Акаунт, створений у Console, має `emailVerified: false`, а серед `blockers` є `email_not_verified`. Скрипт зберігає `profile.id` у `clientProfileId`.
3. **⚠️ `Client: ⚠️ SEND verification email (real email)`.** Надсилає справжній лист на адресу акаунта. Очікування: `HTTP 200`. Відкрийте посилання з листа (перевірте також «Спам»).
4. **`Client: refresh ID token`.** Очікування: `tokens saved…`. Новий токен уже містить підтверджений email. Повторюйте цей запит щоразу, коли API відповідає `401 TOKEN_EXPIRED` або `INVALID_TOKEN`: ID token діє близько години.
5. **`Profile: sync`** ще раз. Очікування: `emailVerified: true`, у `blockers` лишаються `name_missing` і `phone_missing`.
6. **`Profile: ⚠️ update name and phone`** — вигадані ім'я й телефон замініть своїми тестовими. Після цього `bookingReadiness.ready: true`.

**Гість:** `Guest: anonymous sign-in` → `4. Guest → Profile: sync (guest)`. Кожне надсилання `anonymous sign-in` створює нового анонімного користувача у Firebase. Повторно використовуйте `Guest: refresh ID token`.

## 4. Сценарії клієнта й адміністратора

**Публічні** (`2. Public`):
1. `List services` → скопіюйте `id` послуги в `serviceId`.
2. `Availability of a service` → скопіюйте `startsAt` вільного слота в `bookingStartsAt`.

Слотів не буде, доки адміністратор не задасть графік. Параметри `from` і `to` за замовчуванням вимкнені: щоб їх задіяти, увімкніть їх і заповніть `availabilityFrom` / `availabilityTo` у форматі `YYYY-MM-DD`.

**Адміністратор** (`5. Admin`, після призначення ролі власником):
1. `Profile: sync (admin)` — тест `role is admin` стане зеленим лише після призначення ролі. Скрипт зберігає `adminProfileId`.
2. `Schedule: get` → `Schedule: ⚠️ replace weekly`. Години в тілі запиту вигадані, відредагуйте їх перед надсиланням.
3. Винятки: заповніть `exceptionDate`, далі `Schedule: ⚠️ set exception of a date` або `⚠️ remove exception of a date`.
4. Бронювання: заповніть `adminBookingsDate` для `Bookings: list of a date`, далі `Bookings: get any` і `Bookings: ⚠️ cancel (studio)` за `bookingId`.

**Клієнт** (`3. Client`):
1. `Bookings: ⚠️ create (Idempotency-Key)` → зберігає `bookingId`.
2. `Bookings: list own` / `get own`.
3. Заповніть `rescheduleStartsAt` → `Bookings: ⚠️ reschedule`.
4. `Bookings: ⚠️ cancel own`.

**Idempotency-Key** для створення бронювання береться зі змінної `bookingIdempotencyKey`:
- Якщо змінна порожня, скрипт **один раз** записує в неї новий UUID. Поки в змінній є значення, новий ключ не генерується.
- **Повтор тієї самої операції** (тайм-аут, невідомий результат): надішліть запит ще раз, не змінюючи ні ключ, ні тіло. Відповідь — `200` із заголовком `Idempotent-Replayed: true` і тим самим бронюванням; друге бронювання не створюється.
- **Нове бронювання:** очистіть Current value `bookingIdempotencyKey` (або впишіть власне значення: 8–128 символів `[A-Za-z0-9_-]`), задайте новий `bookingStartsAt` і надішліть.
- Той самий ключ з іншою послугою чи іншим часом → `422 IDEMPOTENCY_KEY_REUSED`.

**Права доступу** (`6. Permission checks`, дані не змінюються):

| Запит | Очікування |
|---|---|
| Без токена | `401 AUTH_REQUIRED` |
| Клієнт на `/api/admin` | `403 FORBIDDEN` |
| Гість намагається забронювати | `403 BOOKING_NOT_READY` з `anonymous_session` |

**Маркетинг** (`7. Marketing — DISABLED on staging`): зараз кожен запит відповідає `404 NOT_FOUND`. Запити лишено на майбутнє.

## 5. Запити, що змінюють дані або надсилають листи

Усі вони позначені ⚠️ у назві. Тест перевіряє, що кожен запит до API, крім GET, синхронізації профілю й перевірок прав, має цю позначку.

| Запит | Наслідок |
|---|---|
| `Client/Admin: ⚠️ SEND verification email` | **Справжній лист** від Firebase |
| `Guest: anonymous sign-in` | Новий анонімний користувач у Firebase Authentication |
| `Profile: sync` | Створює або оновлює профіль у БД (листів немає) |
| `Profile: ⚠️ update name and phone` | Змінює профіль |
| `Profile: ⚠️ sign out everywhere` | Відкликає всі сесії акаунта, після цього потрібен новий вхід |
| `Bookings: ⚠️ create` / `⚠️ reschedule` / `⚠️ cancel own` | Створює, переносить або скасовує бронювання. Листи про бронювання на staging вимкнено; після їх увімкнення ці запити надсилатимуть листи |
| `Schedule: ⚠️ replace weekly` / `⚠️ set exception` / `⚠️ remove exception` | Змінює графік студії |
| `Bookings: ⚠️ cancel (studio)` | Скасовує бронювання клієнта (і лист клієнту, коли листи увімкнено) |
| Маркетинг ⚠️ | Зараз 404. Після увімкнення запити на підписку надсилатимуть лист-підтвердження |

## 6. Очищення секретів перед експортом або передаванням

1. Environment → очистіть **Current value** змінних:
   - `firebaseWebApiKey`;
   - `clientEmail`, `clientPassword`, `adminEmail`, `adminPassword`;
   - усіх `…IdToken` і `…RefreshToken`;
   - `marketingFormEmail`, `marketingActionToken`.

   Можна інакше: скиньте всі значення до Initial value — у шаблоні вони порожні.
2. Не натискайте **Persist** чи **Persist all**: вони копіюють Current value в Initial value, а Initial value синхронізується й потрапляє в експорт.
3. Перевірте, що Initial value всіх змінних, крім `baseUrl` і `firebaseProjectId`, порожні.
4. Видаліть збережені приклади відповідей (Examples), якщо ви їх створювали, і очистіть Postman Console (**Clear**).
5. Після експорту відкрийте JSON-файли й переконайтеся, що поля `value` секретних змінних порожні та немає рядків, які починаються з `eyJ` (токени) або `AIza` (ключі Google).
6. Змінюючи колекцію в репозиторії, запускайте `npm test`: тест відхилить токени, ключі Google, справжні email-адреси та заповнені секрети в шаблоні.
