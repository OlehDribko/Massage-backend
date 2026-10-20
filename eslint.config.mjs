// Flat config для всього репозиторію. Правила типізації описані в AGENTS.md.
import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "**/node_modules/",
    "**/dist/",
    // Згенерований код (зокрема Prisma Client, якщо його output буде в сервісі)
    "**/generated/",
  ]),
  {
    files: ["**/*.ts"],
    extends: [eslint.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // Коментарі eslint-disable не можуть вимкнути правила
      noInlineConfig: true,
      reportUnusedInlineConfigs: "error",
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      // as, <T> та подвійні приведення
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      // consistent-type-assertions не забороняє const-assertions, тому окремо
      "no-restricted-syntax": [
        "error",
        {
          selector:
            ":matches(TSAsExpression, TSTypeAssertion) > TSTypeReference[typeName.name='const']",
          message:
            "Const assertions are not allowed. Use an explicit type annotation or `satisfies`.",
        },
      ],
      // Успадковане з recommended правило пропонує замінити літеральну анотацію
      // (`const x: "a" = "a"`) на `as const`, що заборонено AGENTS.md. Вимкнення
      // не послаблює безпеку типів: явна літеральна анотація точна.
      "@typescript-eslint/prefer-as-const": "off",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-expect-error": true,
          "ts-check": false,
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
);
