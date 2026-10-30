# Перевірка реального Firebase (staging)

Модульні тести й Auth Emulator не перевіряють трьох речей: справжній підпис токенів проєкту `massage-fr`, службовий ключ із SSM і права IAM. Їх перевіряють запити зі справжнім ID token. Лише staging; production не чіпати.

Перевірка ділиться на дві частини:
- **Частина A** — зараз, у вікні короткого запуску (`infra/staging-deploy.md`, «Короткий запуск з Firebase-автентифікацією»). Тільки Firebase REST, `curl` і `jq`, без окремих застосунків.
- **Частина B** — пізніше, разом з інтеграцією frontend.

## Частина A: Firebase REST (зараз)

Що перевіряється: гість, email/пароль (зокрема прив'язка гостя), профіль, відкликання сесій, відмова для недійсного токена.

### Правила для секретів
- Пароль тестового акаунта генерується (`openssl rand`) і живе лише у змінній скрипта. Ніхто його не вводить і не бачить.
- ID tokens і пароль передаються в `curl` лише через конфігурацію на stdin (`curl -K -`, рядки формує вбудований `printf` оболонки). Тому вони не потрапляють ні в аргументи процесів (`ps`), ні в історію команд. Скрипт не вмикає `set -x`.
- Скрипт виводить лише кроки, HTTP-статуси, коди помилок і несекретні поля профілю. Відповіді Firebase REST, що містять `idToken`/`refreshToken`, не виводяться.
- Web API key (`Project settings → General → Web API key`) не є секретом: він вбудовується в кожен frontend. Його кладуть у файл `~/.config/massage/firebase-staging-web-api-key` (права `600`, поза репозиторієм), щоб не передавати в чаті й аргументах.
- Тестовий акаунт: `fbcheck-<випадково>@example.com` (зарезервований домен, листи не надсилаються). Наприкінці акаунт видаляється у Firebase, навіть якщо перевірка впала (`trap`). Рядок `UserProfile` у staging-БД лишається як тестові дані.

### Скрипт

Зберегти як файл поза репозиторієм. Запуск: `API=<STAGING_API_BASE_URL> bash <файл>`. Для прогону на Auth Emulator додатково задати `IDP_BASE=http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1`.

Код виходу: `0` — усі перевірки пройшли; інакше перший рядок `FAIL:` пояснює причину. Будь-який `FAIL` зупиняє перевірку, після чого staging повертається на паузу.

```bash
#!/usr/bin/env bash
# Real Firebase check (part A). Prints steps, statuses and non-secret fields only.
set -euo pipefail
set +x
umask 077

API="${API:?set API to the staging base URL}"
IDP="${IDP_BASE:-https://identitytoolkit.googleapis.com/v1}"
KEY_FILE="${KEY_FILE:-$HOME/.config/massage/firebase-staging-web-api-key}"
WEB_KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
EMAIL="fbcheck-$(openssl rand -hex 4)@example.com"
PASS="$(openssl rand -hex 16)"
TOKEN=""
STATUS=""
BODY=""

fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok   $*"; }
# Escapes a value for a double-quoted curl config string.
q() { local s=${1//\\/\\\\}; printf '%s' "${s//\"/\\\"}"; }

# Identity Toolkit call; key, token and password go through stdin only.
idp() {
  local out
  out="$(printf 'url = "%s/accounts:%s?key=%s"\nheader = "Content-Type: application/json"\ndata = "%s"\nwrite-out = "\\n%%{http_code}"\n' \
    "$IDP" "$1" "$(q "$WEB_KEY")" "$(q "$2")" | curl -sS -K -)"
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}
token_from_body() { jq -r '.idToken // empty' <<<"$BODY"; }

# Backend call: api METHOD PATH TOKEN [JSON]
api() {
  local cfg out
  cfg="$(printf 'url = "%s%s"\nrequest = "%s"\nwrite-out = "\\n%%{http_code}"' "$API" "$2" "$1")"
  if [ -n "$3" ]; then cfg="$cfg"$'\n'"header = \"Authorization: Bearer $(q "$3")\""; fi
  if [ -n "${4:-}" ]; then cfg="$cfg"$'\n'"header = \"Content-Type: application/json\""$'\n'"data = \"$(q "$4")\""; fi
  out="$(printf '%s\n' "$cfg" | curl -sS -K -)"
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}
code() { jq -r '.code // empty' <<<"$BODY" 2>/dev/null || true; }
field() { jq -r "$1" <<<"$BODY"; }

cleanup() {
  if [ -n "$TOKEN" ]; then
    idp delete "{\"idToken\":\"$(q "$TOKEN")\"}" || true
    echo "cleanup: Firebase test user delete -> $STATUS"
  fi
}
trap cleanup EXIT

# A1. Guest
idp signUp '{"returnSecureToken":true}'
[ "$STATUS" = 200 ] || fail "anonymous signUp -> $STATUS (Anonymous provider / Web API key)"
TOKEN="$(token_from_body)"
api POST /api/me/sync "$TOKEN"
[ "$STATUS" = 200 ] || fail "guest sync -> $STATUS $(code) (INVALID_TOKEN: project id; AUTH_UNAVAILABLE: key/IAM)"
PROFILE_ID="$(field .profile.id)"
[ "$(field .profile.authState)" = anonymous ] || fail "guest authState"
field '.bookingReadiness.blockers | index("anonymous_session") != null' | grep -qx true || fail "guest blockers"
ok "A1 guest: sync 200, profile created, authState anonymous"
api GET /api/me "$TOKEN"
[ "$STATUS" = 200 ] && [ "$(field .profile.id)" = "$PROFILE_ID" ] || fail "guest GET /api/me -> $STATUS"
ok "A1 guest: GET /api/me 200, same profile"

# A2. Link the guest to email/password (same UID); 2a: token returned by the link.
# A second later than the guest sign-in, so the session times differ (as in real use).
sleep 1
idp update "{\"idToken\":\"$(q "$TOKEN")\",\"email\":\"$EMAIL\",\"password\":\"$(q "$PASS")\",\"returnSecureToken\":true}"
[ "$STATUS" = 200 ] || fail "link password -> $STATUS"
LINKED="$(token_from_body)"
[ -n "$LINKED" ] && TOKEN="$LINKED"
api POST /api/me/sync "$TOKEN"
echo "info A2a token returned by linking: sync -> $STATUS $(code)   (Auth Emulator: 401 SESSION_REVOKED)"

# A3. Sign in again with email/password (frontend contract after linking)
sleep 1
idp signInWithPassword "{\"email\":\"$EMAIL\",\"password\":\"$(q "$PASS")\",\"returnSecureToken\":true}"
[ "$STATUS" = 200 ] || fail "signInWithPassword -> $STATUS"
TOKEN="$(token_from_body)"
api POST /api/me/sync "$TOKEN"
[ "$STATUS" = 200 ] || fail "registered sync -> $STATUS $(code)"
[ "$(field .profile.id)" = "$PROFILE_ID" ] || fail "profile changed after linking"
[ "$(field .profile.authState)" = registered ] || fail "authState after linking"
[ "$(field .profile.emailVerified)" = false ] || fail "emailVerified must be false"
ok "A3 email/password: same profile, registered, email not verified"

# A4. Profile
api PATCH /api/me "$TOKEN" '{"name":"Firebase Check","phone":"+33612345678"}'
[ "$STATUS" = 200 ] || fail "PATCH profile -> $STATUS $(code)"
[ "$(field .profile.phone)" = "+33612345678" ] || fail "phone not stored in E.164"
[ "$(field '.bookingReadiness.blockers | join(",")')" = email_not_verified ] || fail "blockers after PATCH"
ok "A4 profile: name and phone saved, only blocker email_not_verified"
api PATCH /api/me "$TOKEN" '{"role":"admin"}'
[ "$STATUS" = 400 ] && [ "$(code)" = VALIDATION_FAILED ] || fail "role change must be refused -> $STATUS"
ok "A4 profile: role change refused (400 VALIDATION_FAILED)"

# A5. Missing and invalid tokens
api GET /api/me ""
[ "$STATUS" = 401 ] && [ "$(code)" = AUTH_REQUIRED ] || fail "no token -> $STATUS"
api GET /api/me "not-a-real-token"
[ "$STATUS" = 401 ] && [ "$(code)" = INVALID_TOKEN ] || fail "invalid token -> $STATUS"
ok "A5 no token 401 AUTH_REQUIRED, invalid token 401 INVALID_TOKEN"

# A6. Revoke all sessions
sleep 2
api POST /api/me/sessions/revoke "$TOKEN"
[ "$STATUS" = 204 ] || fail "revoke -> $STATUS $(code)"
api GET /api/me "$TOKEN"
[ "$STATUS" = 401 ] && [ "$(code)" = SESSION_REVOKED ] || fail "revoked token -> $STATUS $(code)"
sleep 1
idp signInWithPassword "{\"email\":\"$EMAIL\",\"password\":\"$(q "$PASS")\",\"returnSecureToken\":true}"
[ "$STATUS" = 200 ] || fail "sign in after revoke -> $STATUS"
TOKEN="$(token_from_body)"
api GET /api/me "$TOKEN"
[ "$STATUS" = 200 ] && [ "$(field .profile.id)" = "$PROFILE_ID" ] || fail "after re-sign-in -> $STATUS"
ok "A6 revoke 204, old token 401 SESSION_REVOKED, new sign-in 200 same profile"

echo "PASS (test user is deleted on exit)"
```

### Що записати
- Рядки `ok` і `info A2a` (без токенів). `info A2a` показує, як реальний Firebase поводиться з токеном, отриманим одразу після прив'язки пароля. Результат перенести в `docs/auth-and-profiles.md`, розділ 5. Повторний вхід лишається в контракті frontend за будь-якого результату.
- Рядок `cleanup: … -> 200`.

## Частина B: разом з інтеграцією frontend (ще не перевірено)

| Сценарій | Чому не в частині A |
|---|---|
| **Реальний вхід Google**, прив'язка гостя до Google, конфлікт облікових даних (`credential-already-in-use`) | Потрібен браузерний клієнт з OAuth; окремий тестовий застосунок не погоджено |
| Листи Firebase: підтвердження email (`emailVerified: true` після `getIdToken(true)` + `sync`), скидання пароля, відкликання старого токена після нового пароля (очікується `401 SESSION_REVOKED`) | Потрібні реальна скринька й перехід за посиланням |
| Маркетинг: чекбокс, лист Brevo, повторне надсилання, підтвердження, відписка | На staging маркетинг вимкнено (`outcome: "unavailable"`) |
| Права адміністратора (`docs/auth-and-profiles.md`, розділ 9) | Відкладено |
| Заблокований акаунт (`403 ACCOUNT_DISABLED`) | Потрібна дія в консолі Firebase; мапінг перевірено на емуляторі |

Поведінку повторного входу після прив'язки пароля поза емулятором перевіряє частина A (`info A2a`).
