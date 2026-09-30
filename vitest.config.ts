import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    environmentMatchGlobs: [["test/hooks.**", "jsdom"]],
    include: ["test/**/*.test.{ts,tsx}"],
  },
})
