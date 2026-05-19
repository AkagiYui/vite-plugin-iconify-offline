import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // 单元测试在 Node 环境运行
    environment: "node",
    // 测试文件匹配
    include: ["tests/**/*.test.ts"],
  },
})
