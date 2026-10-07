/**
 * Python str 模式 \s 的统一正则（供 skills 复用，与 gates 保持同一语义）。
 * JS \s 与 Python \s 的差异：JS 多 \ufeff，少 \x1c-\x1f 与 \x85。
 */

export const PY_WS_CLASS =
  ' \\t\\n\\v\\f\\r\\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'

/** 全量剥除空白（对照 Python re.sub(r"\s+", "", s)）。 */
export const PY_WS_STRIP = new RegExp(`[${PY_WS_CLASS}]+`, 'g')

/** 折叠空白为单个空格（对照 Python re.sub(r"\s+", " ", s)）。 */
export const PY_WS_COLLAPSE = new RegExp(`[${PY_WS_CLASS}]+`, 'g')
