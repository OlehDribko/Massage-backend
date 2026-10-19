# AGENTS.md

Інструкції для AI-помічників і розробників, які працюють у цьому репозиторії.

## Правила типізації TypeScript

Стосуються власного коду та тестів у всіх workspace (`services/*`, а згодом і `packages/*`).
Сторонні залежності (`node_modules`) і згенерований код (наприклад, Prisma Client) вручну не редагуються.

1. **`strict: true`** — обов'язково в кожній TypeScript-конфігурації. Строгість не послаблювати.
2. **Заборонено `any`** — явний (`: any`, `as any`, `any[]`, `Record<string, any>`, у generic-аргументах) і неявний, а також небезпечне використання значень типу `any` зі сторонніх типів.
3. **Заборонено type assertions** у будь-якій формі:
   - `value as T` та `<T>value`;
   - `as const`;
   - подвійні приведення (`as unknown as T`).
4. **Заборонено non-null assertions** (`value!`, `obj!.field`).
5. **Заборонено придушення помилок** через `// @ts-ignore`, `// @ts-nocheck`, `// @ts-expect-error`, а також вимкнення lint-правил (`eslint-disable…`) для обходу помилок.
6. **Зовнішні дані** — тіло запиту, env, відповіді API, JSON, payload токенів, повідомлення з черг — приймаються як `unknown` і перевіряються через Zod або коректне звуження типів (`typeof`, `in`, `instanceof`, type guards).
7. **Використовувати точні типи:** generics, discriminated unions, `satisfies` (замість `as`/`as const` для перевірки відповідності типу), типи, виведені зі схем (`z.infer`) та з Prisma.
8. **Не вважається type assertion:** перейменування при імпорті й експорті (`import { a as b }`, `import * as x`, `export { a as b }`).

Правила перевіряються автоматично: `npm run lint` (ESLint + typescript-eslint з type-aware правилами, конфігурація — `eslint.config.mjs`).
