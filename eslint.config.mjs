import js from "@eslint/js";
import globals from "globals";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import tsParser from "@typescript-eslint/parser";
import tseslint from "@typescript-eslint/eslint-plugin";
import prettier from "eslint-config-prettier";

const unicornRecommended =
  unicorn.configs?.["flat/recommended"] ?? unicorn.configs?.recommended;
const sonarRecommended = sonarjs.configs?.recommended;
const unicornRules = unicornRecommended?.rules ?? {};
const sonarRules = sonarRecommended?.rules ?? {};

const typeCheckedRules = {
  ...(tseslint.configs?.["recommended-type-checked"]?.rules ?? {}),
  ...(tseslint.configs?.["strict-type-checked"]?.rules ?? {}),
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.cache/**",
      "**/build/**",
      "**/.turbo/**",
      "**/.pnpm/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.es2022,
        ...globals.node,
      },
    },
    plugins: {
      unicorn,
      sonarjs,
    },
    rules: {
      ...unicornRules,
      ...sonarRules,
      "unicorn/filename-case": [
        "error",
        {
          cases: {
            camelCase: true,
            kebabCase: true,
            snakeCase: true,
          },
        },
      ],
      "unicorn/prevent-abbreviations": "off",
      "unicorn/no-null": "off",
      "unicorn/no-process-exit": "off",
      "unicorn/no-useless-fallback-in-spread": "off",
      "unicorn/prefer-string-raw": "off",
      "unicorn/prefer-top-level-await": "off",
      "unicorn/switch-case-braces": "off",
      "unicorn/prefer-switch": "off",
      "unicorn/no-useless-switch-case": "off",
      "unicorn/no-negated-condition": "off",
      "unicorn/numeric-separators-style": "off",
      "sonarjs/no-duplicate-string": ["error", { threshold: 4 }],
    },
  },
  {
    files: ["packages/*/src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ["packages/*/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...typeCheckedRules,
      "no-undef": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs", "packages/*/scripts/**/*.mjs"],
    rules: {
      "unicorn/no-process-exit": "off",
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
    },
    rules: {
      "unicorn/prefer-module": "off",
    },
  },
  prettier,
].filter(Boolean);
