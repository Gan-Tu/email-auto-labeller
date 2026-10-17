import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    env: { BASE_URL: "http://localhost:8080", APP_ORIGINS: "" },
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
