import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "client/src/**/*.test.ts",
      "shared/src/**/*.test.ts",
      "server/src/**/*.test.ts",
    ],
    environment: "node", // sim is renderer-agnostic; tests must never need a DOM
  },
});
