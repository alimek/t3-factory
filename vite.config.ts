import { defineConfig } from "vite-plus";

// Generated output and hand-edited Markdown are not formatted or linted.
const ignorePatterns = [
  "**/node_modules/**",
  "**/dist/**",
  "**/coverage/**",
  "**/.e2e/**",
  "**/pnpm-lock.yaml",
  "**/*.md",
];

const privatePackageImports = {
  regex: "(^|/)(contracts|domain-validation)/(src|dist)(/|$)|^@t3-factory/[^/]+/(src|dist)(/|$)",
  message: "Use the workspace package's public exports instead of its implementation files.",
};
const sharedImportRestrictions = [
  privatePackageImports,
  {
    regex: "(^|/)(apps|backend|frontend|desktop)(/|$)",
    message: "Shared domain packages cannot depend on applications; put I/O in the owning app.",
  },
];

const backendImportRestrictions = [
  privatePackageImports,
  {
    regex: "(^|/)(frontend|desktop)(/|$)",
    message: "The backend owns Factory operations independently of its clients.",
  },
];

export default defineConfig({
  fmt: {
    printWidth: 100,
    ignorePatterns,
  },
  lint: {
    ignorePatterns,
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import"],
    categories: { correctness: "error" },
    options: { typeAware: true, denyWarnings: true, reportUnusedDisableDirectives: "error" },
    rules: {
      eqeqeq: "error",
      "no-empty": "error",
      "no-var": "error",
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      "import/no-cycle": "error",
      "typescript/ban-ts-comment": [
        "error",
        { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true, "ts-check": false },
      ],
      "typescript/no-explicit-any": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      "typescript/no-duplicate-type-constituents": "error",
      "typescript/no-misused-promises": "error",
      "typescript/no-floating-promises": "error",
      "typescript/prefer-promise-reject-errors": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "typescript/no-misused-spread": "error",
      "typescript/no-base-to-string": "error",
      "typescript/restrict-plus-operands": "error",
      // Flags destructured Node module functions and static methods, which do not use `this`.
      "typescript/unbound-method": "off",
    },
    overrides: [
      {
        files: ["packages/*/src/**", "apps/frontend/src/**"],
        rules: { "import/no-nodejs-modules": "error" },
      },
      {
        files: ["packages/*/src/**"],
        rules: {
          "no-restricted-imports": ["error", { patterns: sharedImportRestrictions }],
          "no-restricted-globals": [
            "error",
            {
              checkGlobalObject: true,
              globals: ["fetch", "XMLHttpRequest", "WebSocket", "localStorage", "sessionStorage"],
            },
          ],
        },
      },
      {
        files: ["packages/contracts/src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                ...sharedImportRestrictions,
                {
                  regex: "(^|/)domain-validation(/|$)",
                  message:
                    "Contracts own shared types; validation depends on contracts, not vice versa.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["apps/frontend/src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                privatePackageImports,
                {
                  regex: "(^|/)(backend|desktop)(/|$)",
                  message:
                    "The browser uses shared contracts and its transport, not host implementation.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["apps/backend/src/**"],
        rules: {
          "no-restricted-imports": ["error", { patterns: backendImportRestrictions }],
        },
      },
      {
        files: ["apps/backend/src/runner/run-store/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                ...backendImportRestrictions,
                {
                  regex: "(^|/)adapters/",
                  message:
                    "The Run store never reaches T3: its transactions cannot span a T3 call. Orchestration calls the T3 adapter.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["apps/backend/test/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  regex: "^@t3-factory/backend(/|$)|(^|/)dist(/|$)",
                  message:
                    "Backend tests import backend modules by relative source path, so one copy of the backend loads.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["apps/desktop/src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                privatePackageImports,
                {
                  regex: "(^|/)(backend|frontend)/(src|dist)(/|$)",
                  message: "The desktop hosts the backend through its public package exports.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["apps/*/src/**"],
        rules: { "no-console": "error" },
      },
      {
        // The CLI entry point reports startup status on the terminal.
        files: ["apps/backend/src/main.ts"],
        rules: { "no-console": "off" },
      },
      {
        files: ["apps/frontend/**"],
        plugins: ["react"],
        env: { browser: true },
        rules: {
          "react/rules-of-hooks": "error",
          "react-hooks/exhaustive-deps": "error",
          "react/jsx-key": "error",
          // Data-loading effects deliberately reset error/loading state before fetching.
          "react/set-state-in-effect": "off",
        },
      },
    ],
  },
});
