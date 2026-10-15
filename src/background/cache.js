/**
 * src/background/cache.js — 本地答案题库（零成本复用）。
 *
 * 动机：换任何答题引擎都要么花钱、要么花电费、要么花时间。
 * 唯一能让「重复题」零成本的办法就是本地缓存 —— 超星的题库复用率很高
 * （同一门课的测验、不同班级的同名测验经常出同一道题），所以这一层
 * 的实际省钱效果通常比换引擎更大。
 *
 * 设计：
 *   - 单键存储 dxrep_answerCache，形状 { v, meta:{hits,miss}, entries:{ key: {o,t,e,n,at} } }
 *     o=答案、t=题型、e=哪个引擎给出的、n=被命中次数、at=最后使用时间戳
 *   - key 由 cacheKey() 派生，优先级：questionId > 题干+选项哈希 > 图片哈希
 *   - 超过 MAX_ENTRIES 时按最后使用时间 LRU 淘汰到 90%
 *   - 支持导出/导入 JSON，同学之间可以互相合并题库
 *
 * 与原插件的关系：原插件没有本地题库（每题都发服务器），这是本复刻的净增能力。
 */
import { md5 } from "../../lib/md5.js";

export const CACHE_STORAGE_KEY = "dxrep_answerCache";
export const CACHE_VERSION = 1;
export const MAX_ENTRIES = 20000;

/* ------------------------------------------------------ 纯函数（可单测） */

/**
 * 归一化用于生成 key 的文本：去掉全部空白与零宽字符。
 * 不做更激进的归一化（不敢动标点），避免把两道不同的题撞成同一道。
 */
export function normalizeForKey(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/[\s\u00a0\u3000]+/g, "")
    .replace(/[\u200b-\u200f\ufeff]/g, "");
}

/**
 * 由题目载荷派生题库 key。
 * 返回空串表示无法为该题建立稳定身份（此时不读写题库）。
 *
 * 为什么不只用题干：同一句题干在不同课程里选项可能不同，
 * 所以把题型与选项一起折进哈希。
 * questionId 是超星自带的稳定题号，优先用它。
 */
export function cacheKey(payload) {
  if (!payload || typeof payload !== "object") return "";
  const type = payload.questionType ? String(payload.questionType) : "";
  const qid = normalizeForKey(payload.questionId);
  if (qid) return "id:" + qid + "|" + type;

  const text = normalizeForKey(payload.questionText);
  const opts = (Array.isArray(payload.options) ? payload.options : []).map(normalizeForKey).join("\u0001");
  if (text || opts) return "txt:" + md5(type + "\u0000" + text + "\u0000" + opts);

  const img = payload.base64 || payload.screenshot || "";
  if (typeof img === "string" && img) {
    const comma = img.indexOf(",");
    const b64 = comma >= 0 ? img.slice(comma + 1) : img;
    if (b64) return "img:" + md5(type + "\u0000" + b64 + "\u0000" + opts);
  }
  return "";
}

/** 按最后使用时间做 LRU 淘汰（纯函数，不碰存储） */
export function trimEntries(entries, max) {
  const limit = typeof max === "number" && max > 0 ? max : MAX_ENTRIES;
  const src = entries && typeof entries === "object" ? entries : {};
  const keys = Object.keys(src);
  if (keys.length <= limit) return { entries: src, removed: 0 };

  const keep = Math.max(1, Math.floor(limit * 0.9));
  const sorted = keys.slice().sort((a, b) => (src[a] && src[a].at ? src[a].at : 0) - (src[b] && src[b].at ? src[b].at : 0));
  const out = {};
  for (const k of sorted.slice(sorted.length - keep)) out[k] = src[k];
  return { entries: out, removed: keys.length - keep };
}

/**
 * 合并导入的题库（纯函数）。
 * 以导入为准：同一条目答案不同时用导入的（假定对方题库更新）。
 * 只接受带非空答案 o 的条目。
 */
export function mergeEntries(base, incoming) {
  const out = {};
  for (const k of Object.keys(base || {})) out[k] = base[k];

  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const k of Object.keys(incoming || {})) {
    const inc = incoming[k];
    if (!k || !inc || typeof inc !== "object" || typeof inc.o !== "string" || !inc.o) {
      skipped++;
      continue;
    }
    const cur = out[k];
    if (!cur) {
      out[k] = {
        o: inc.o,
        t: inc.t || "",
        e: inc.e || "imported",
        n: Math.max(1, Number(inc.n) || 1),
        at: Number(inc.at) || Date.now(),
      };
      added++;
      continue;
    }
    const merged = { o: cur.o, t: cur.t || "", e: cur.e || "", n: Number(cur.n) || 1, at: Number(cur.at) || 0 };
    let changed = false;
    if (inc.o !== cur.o) {
      merged.o = inc.o;
      changed = true;
    }
    if ((Number(inc.n) || 0) > merged.n) {
      merged.n = Number(inc.n);
      changed = true;
    }
    if ((Number(inc.at) || 0) > merged.at) {
      merged.at = Number(inc.at);
      changed = true;
    }
    if (changed) {
      updated++;
      out[k] = merged;
    }
  }
  return { entries: out, added, updated, skipped };
}

/* ------------------------------------------------------ 存储读写 */

function emptyCache() {
  return { v: CACHE_VERSION, meta: { hits: 0, miss: 0 }, entries: {} };
}

async function readAll() {
  let raw;
  try {
    const o = await chrome.storage.local.get(CACHE_STORAGE_KEY);
    raw = o && o[CACHE_STORAGE_KEY];
  } catch {
    return emptyCache();
  }
  if (!raw || typeof raw !== "object") return emptyCache();
  if (!raw.entries || typeof raw.entries !== "object") raw.entries = {};
  if (!raw.meta || typeof raw.meta !== "object") raw.meta = { hits: 0, miss: 0 };
  raw.v = CACHE_VERSION;
  return raw;
}

async function writeAll(c) {
  try {
    await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: c });
  } catch {
    /* 超出配额等情况下静默失败，不影响答题 */
  }
}

/** 命中则返回条目（并累加使用计数），未命中返回 null */
export async function cacheGet(key) {
  if (!key) return null;
  const c = await readAll();
  const e = c.entries[key];
  if (e && typeof e.o === "string" && e.o) {
    e.n = (Number(e.n) || 0) + 1;
    e.at = Date.now();
    c.meta.hits = (Number(c.meta.hits) || 0) + 1;
    await writeAll(c);
    return e;
  }
  c.meta.miss = (Number(c.meta.miss) || 0) + 1;
  await writeAll(c);
  return null;
}

/** 写入一条答案 */
export async function cachePut(key, option, questionType, engine) {
  if (!key || !option) return false;
  const c = await readAll();
  const prev = c.entries[key];
  c.entries[key] = {
    o: String(option),
    t: questionType || "",
    e: engine || "",
    n: (prev && Number(prev.n)) || 1,
    at: Date.now(),
  };
  c.entries = trimEntries(c.entries).entries;
  await writeAll(c);
  return true;
}

export async function cacheStats() {
  const c = await readAll();
  const keys = Object.keys(c.entries);
  let reused = 0;
  let lastAt = 0;
  const byEngine = {};
  for (const k of keys) {
    const e = c.entries[k] || {};
    reused += Math.max(0, (Number(e.n) || 1) - 1);
    const eng = e.e || "未知";
    byEngine[eng] = (byEngine[eng] || 0) + 1;
    if ((Number(e.at) || 0) > lastAt) lastAt = Number(e.at) || 0;
  }
  const hits = Number(c.meta.hits) || 0;
  const miss = Number(c.meta.miss) || 0;
  return {
    count: keys.length,
    reused,
    hits,
    miss,
    rate: hits + miss > 0 ? hits / (hits + miss) : 0,
    byEngine,
    lastAt,
  };
}

export async function cacheExport() {
  const c = await readAll();
  return {
    v: CACHE_VERSION,
    kind: "dxstj-answer-bank",
    note: "网课助手·复刻版 本地题库导出。可分享给同学，用「导入题库」合并。",
    exportedAt: Date.now(),
    meta: { hits: Number(c.meta.hits) || 0, miss: Number(c.meta.miss) || 0 },
    entries: c.entries,
  };
}

export async function cacheImport(data) {
  if (!data || typeof data !== "object" || !data.entries || typeof data.entries !== "object") {
    return { ok: false, errMsg: "不是有效的题库文件（缺少 entries 字段）" };
  }
  const c = await readAll();
  const r = mergeEntries(c.entries, data.entries);
  const t = trimEntries(r.entries);
  c.entries = t.entries;
  await writeAll(c);
  return {
    ok: true,
    added: r.added,
    updated: r.updated,
    skipped: r.skipped,
    trimmed: t.removed,
    total: Object.keys(c.entries).length,
  };
}

export async function cacheClear() {
  const c = emptyCache();
  await writeAll(c);
  return { ok: true };
}
