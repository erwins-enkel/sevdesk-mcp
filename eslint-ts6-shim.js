// typescript-eslint 8.x needs TypeScript's JS compiler API, which TypeScript 7 (the
// Go-native compiler this project builds with) does not ship. This hook resolves
// `typescript` to @typescript/typescript6 for the lint packages only; everything else,
// including `tsc`, keeps TypeScript 7. Delete this file (and its import in
// eslint.config.js, and the @typescript/typescript6 devDependency) once typescript-eslint
// supports TypeScript 7: https://github.com/typescript-eslint/typescript-eslint/issues/10940
import { registerHooks } from 'node:module';

const LINT_PACKAGES =
  /\/node_modules\/(@typescript-eslint\/[^/]+|typescript-eslint|ts-api-utils)\//;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^typescript(\/|$)/.test(specifier) && LINT_PACKAGES.test(context.parentURL ?? '')) {
      return nextResolve(specifier.replace(/^typescript/, '@typescript/typescript6'), context);
    }
    return nextResolve(specifier, context);
  },
});
