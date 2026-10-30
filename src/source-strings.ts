/**
 * 遍历源码中的字符串，跳过 JS / JSX / HTML 注释。
 * 保留完整字符串，供调用方继续匹配 Vue 绑定属性中的嵌套引号。
 */
export function forEachSourceString(code: string, visit: (literal: string) => void, markup = /^\s*</.test(code)): void {
  function skipQuoted(start: number, collect = true): number {
    const quote = code[start]
    let end = start + 1
    while (end < code.length) {
      if (code[end] === "\\") end += 2
      else if (code[end++] === quote) break
    }
    if (collect) visit(code.slice(start, end))
    return end
  }

  function skipRegExp(start: number): number {
    let inClass = false
    for (let end = start + 1; end < code.length; end++) {
      const char = code[end]
      if (char === "\n" || char === "\r") break
      if (char === "\\") end++
      else if (char === "[") inClass = true
      else if (char === "]") inClass = false
      else if (char === "/" && !inClass) return end + 1
    }
    return start + 1
  }

  function tagEnd(start: number): number {
    let braces = 0
    for (let index = start; index < code.length; index++) {
      const char = code[index]
      if (char === '"' || char === "'" || char === "`") index = skipQuoted(index, false) - 1
      else if (char === "{") braces++
      else if (char === "}") braces--
      else if (char === ">" && braces === 0) return index + 1
    }
    return code.length
  }

  function scanMarkup(start: number, document = false): number {
    let index = start
    let depth = 0
    while (index < code.length) {
      if (code.startsWith("<!--", index)) {
        const end = code.indexOf("-->", index + 4)
        index = end < 0 ? code.length : end + 3
        continue
      }
      const tag = code[index] === "<" && /^<(\/?)([\w.:-]*)(?=\s|\/?>)/.exec(code.slice(index))
      if (tag) {
        const end = tagEnd(index + tag[0].length)
        index += tag[0].length
        while (index < end) {
          if (code[index] === '"' || code[index] === "'") index = skipQuoted(index)
          else if (code[index] === "{") index = scan(index + 1, true, end)
          else index++
        }
        if (document && !tag[1] && /^(script|style)$/i.test(tag[2])) {
          const close = new RegExp(`</${tag[2]}\\s*>`, "ig")
          close.lastIndex = index
          const match = close.exec(code)
          if (tag[2].toLowerCase() === "script") scan(index, false, match?.index ?? code.length)
          index = match ? close.lastIndex : code.length
          continue
        }
        const selfClosing = code[end - 2] === "/" || /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag[2])
        depth += tag[1] ? -1 : selfClosing ? 0 : 1
        if (!document && depth <= 0) return index
        continue
      }
      if (code[index] === "{") index = scan(index + 1, true)
      else index++ // 模板文本中的 URL、斜杠和撇号不是 JS 注释或字符串。
    }
    return index
  }

  function scan(start: number, interpolation = false, limit = code.length): number {
    let index = start
    let braces = 0
    let canStartRegExp = true
    let previousWord = ""
    const controlParens: boolean[] = []

    while (index < limit) {
      const char = code[index]
      if (/\s/.test(char)) {
        index++
        continue
      }
      if (code.startsWith("<!--", index) || code.startsWith("/*", index)) {
        const html = char === "<"
        const close = html ? "-->" : "*/"
        const end = code.indexOf(close, index + (html ? 4 : 2))
        index = end < 0 ? code.length : end + close.length
        continue
      }
      if (code.startsWith("//", index)) {
        while (index < code.length && !/[\r\n\u2028\u2029]/.test(code[index])) index++
        continue
      }
      if (char === "<" && canStartRegExp) {
        const tag = /^<([\w.:-]*)(?=\s|\/?>)/.exec(code.slice(index))
        if (tag && (code[tagEnd(index + tag[0].length) - 2] === "/" || code.includes(`</${tag[1]}`, index))) {
          index = scanMarkup(index)
          canStartRegExp = false
          previousWord = ""
          continue
        }
      }
      if (char === '"' || char === "'") {
        index = skipQuoted(index)
        canStartRegExp = false
        previousWord = ""
        continue
      }
      if (char === "`") {
        let segment = index++
        while (index < limit) {
          if (code[index] === "\\") index += 2
          else if (code.startsWith("${", index)) {
            visit(code.slice(segment, index))
            index = scan(index + 2, true)
            segment = index
          } else if (code[index++] === "`") {
            break
          }
        }
        visit(code.slice(segment, index))
        canStartRegExp = false
        previousWord = ""
        continue
      }
      if (char === "/" && canStartRegExp && code[index + 1] !== ">") {
        index = skipRegExp(index)
        canStartRegExp = false
        previousWord = ""
        continue
      }
      if (/[\w$]/.test(char)) {
        const begin = index++
        while (index < code.length && /[\w$]/.test(code[index])) index++
        previousWord = code.slice(begin, index)
        canStartRegExp = /^(return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|else|do)$/.test(previousWord)
        continue
      }
      if (char === "(") controlParens.push(/^(if|while|for|with|switch|catch)$/.test(previousWord))
      if (char === "{") braces++
      if (char === "}") {
        if (interpolation && braces === 0) return index + 1
        braces--
      }
      canStartRegExp = char === ")"
        ? controlParens.pop() === true
        : /[=(:,\[!&|?;{}~%^*+\-/]/.test(char) || (char === ">" && code[index - 1] === "=")
      previousWord = ""
      index++
    }
    return index
  }

  if (markup) scanMarkup(0, true)
  else scan(0)
}
