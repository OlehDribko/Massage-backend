# Локальний клієнт перевірки Firebase

Мінімальна сторінка для ручної перевірки реального входу Firebase і API (`docs/firebase-staging-checklist.md`). Не frontend-застосунок і не для production.

- Firebase JS SDK 13.0.0 з офіційного CDN `gstatic.com`; npm-залежностей немає.
- `server.mjs` (Node 24) віддає сторінку на `http://localhost:5173` і пересилає `/api/*` та `/health/*` на `API_BASE_URL`. Браузер звертається лише до localhost, тому CORS staging змінювати не треба.
- ID token на сторінці не показується. Кнопка «Копіювати токен» кладе його в буфер для `read -rs TOKEN` у терміналі. Проксі не логує заголовки й тіла, лише метод, шлях і статус.

## Налаштування

1. Firebase Console → проєкт staging (`massage-fr`) → **Project settings → General → Your apps → Add app → Web** (`</>`), назва `firebase-check`, Hosting не вмикати.
2. Скопіюйте `firebase-config.example.json` у `firebase-config.local.json` (ігнорується Git) і перенесіть `apiKey` та `appId` з показаної конфігурації. Web-конфігурація не є секретом, але її не комітимо.
3. **Authentication → Settings → Authorized domains:** має бути `localhost` (додається за замовчуванням; лише у staging-проєкті).

## Запуск

```bash
# Лише Firebase (вхід, листи) — API не потрібне:
node tools/firebase-check/server.mjs

# Разом зі staging API (лише коли staging запущено для перевірки):
API_BASE_URL=https://<staging-api> node tools/firebase-check/server.mjs
```

Відкрити саме `http://localhost:5173`, а не `127.0.0.1`: Google-вхід дозволено лише для доменів зі списку Authorized domains.

Перед перевіркою API: «Вийти», щоб почати з чистої сесії. Кнопка «Прив'язати гостя» виконує кроки 2 і 2a сценарію: після прив'язки пароля робить `sync` з токеном, отриманим одразу після прив'язки, і записує результат у лог. Потім виконує повторний вхід і ще один `sync`.
