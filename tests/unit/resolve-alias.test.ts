import { describe, it, expect } from "vitest"
import type { IconifyJSON } from "../../src/index"
import { resolveAlias } from "../../src/index"

// 构造测试用的图标集数据
function makeIconSet(icons: Record<string, { body: string }>, aliases?: Record<string, { parent: string }>): IconifyJSON {
  return {
    prefix: "test",
    icons,
    aliases,
  }
}

describe("resolveAlias", () => {
  it("应返回 null 当图标集没有 aliases", () => {
    const set = makeIconSet({ sun: { body: '<circle cx="12" cy="12" r="5"/>' } })
    expect(resolveAlias(set, "sun")).toBeNull()
  })

  it("应返回 null 当别名不存在", () => {
    const set = makeIconSet({ sun: { body: "<circle/>" } }, { moon: { parent: "sun" } })
    expect(resolveAlias(set, "nonexistent")).toBeNull()
  })

  it("应解析直接别名：别名指向存在的图标", () => {
    const set = makeIconSet(
      { sun: { body: '<circle cx="12" cy="12" r="5"/>' } },
      { "sun-alt": { parent: "sun" } },
    )
    const result = resolveAlias(set, "sun-alt")
    expect(result).not.toBeNull()
    expect(result!.body).toBe('<circle cx="12" cy="12" r="5"/>')
  })

  it("应递归解析多层别名", () => {
    const set = makeIconSet(
      { sun: { body: "<circle/>" } },
      {
        "sun-alias-1": { parent: "sun-alias-2" },
        "sun-alias-2": { parent: "sun" },
      },
    )
    const result = resolveAlias(set, "sun-alias-1")
    expect(result).not.toBeNull()
    expect(result!.body).toBe("<circle/>")
  })

  it("别名应合并父图标的属性", () => {
    const set: IconifyJSON = {
      prefix: "test",
      icons: { sun: { body: "<circle/>", rotate: 1 } },
      aliases: { "sun-rotated": { parent: "sun", rotate: 2, hFlip: true } },
    }
    const result = resolveAlias(set, "sun-rotated")
    expect(result).not.toBeNull()
    // 别名属性应覆盖父图标属性（spread 顺序: 父在前，别名在后）
    expect(result!.body).toBe("<circle/>")
    expect(result!.rotate).toBe(2)
    expect(result!.hFlip).toBe(true)
  })

  it("应返回 null 当别名链断裂（别名指向不存在的图标）", () => {
    const set = makeIconSet(
      { sun: { body: "<circle/>" } },
      { "broken-alias": { parent: "this-does-not-exist" } },
    )
    expect(resolveAlias(set, "broken-alias")).toBeNull()
  })

  it("应返回 null 当别名 parent 为空", () => {
    const set = makeIconSet({ sun: { body: "<circle/>" } }, { "empty-parent": { parent: "" } })
    expect(resolveAlias(set, "empty-parent")).toBeNull()
  })
})
