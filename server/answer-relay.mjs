#!/usr/bin/env node
/**
 * answer-relay.mjs —— 「答题中转」服务（单文件、零依赖，只用 Node 标准库）
 *
 * ┌─ 为什么需要它 ────────────────────────────────────────────────┐
 * │ 原版之所以「下载即用、点一下自动托管」，是因为 daxuesoutijiang.com │
 * │ 在背后养着服务器和算力：客户端只把题目发过去，答案由他们的服务器算。│
 * │ 这部分不是代码，没法从 CRX 里掏出来 —— 所以它复刻不了。            │
 * │                                                                │
 * │ 但你可以自己扮演同样的角色：把 API Key 放在这个中转里部署一次，    │
 * │ 然后把地址填进扩展（或写进 DEFAULT_RELAY_URL 常量）打包发给同学。  │
 * │ 同学那边零配置、不需要任何 Key，用的算力在你这边。                 │
 * └────────────────────────────────────────────────────────────────┘
 *
 * 运行：
 *   UPSTREAM_BASE=https://api.deepseek.com/v1 \
 *   UPSTREAM_KEY=sk-xxxx \
 *   UPSTREAM_MODEL=deepseek-chat \
 *   RELAY_TOKEN=随便设一个口令 \
 *   node answer-relay.mjs
 *
 * 环境变量：
 *   PORT                监听端口，默认 8787
 *   UPSTREAM_BASE       上游 OpenAI 兼容地址（填到 /v1）。留空 = 纯题库模式，不调模型
 *   UPSTREAM_KEY        上游 API Key
 *   UPSTREAM_MODEL      模型名，默认 gpt-4o-mini
 *   UPSTREAM_TEMPERATURE 默认 0.1
 *   RELAY_TOKEN         可选。设了之后扩展端必须填同样的口令才能用
 *   BANK_FILE           题库文件路径，默认 ./answer-bank.json
 *   ALLOW_ORIGIN        CORS 允许的来源，默认 *
 *
 * 接口：
 *   GET  /health      健康检查 + 题库统计
 *   POST /solve       解题（扩展调用的就是这个）
 *   GET  /bank.json   下载题库（可以直接发给别人导入扩展）
 *   POST /bank        合并导入题库  body: {entries:{...}}
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8787);
const UPSTREAM_BASE = (process.env.UPSTREAM_BASE || "").replace(/\/+$/, "");
const UPSTREAM_KEY = process.env.UPSTREAM_KEY || "";
const UPSTREAM_MODEL = process.env.UPSTREAM_MODEL || "gpt-4o-mini";
const UPSTREAM_TEMPERATURE = Number(process.env.UPSTREAM_TEMPERATURE || 0.1);
const RELAY_TOKEN = process.env.RELAY_TOKEN || "";
const BANK_FILE = path.resolve(process.env.BANK_FILE || "./answer-bank.json");
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 180000);
// auto = 有图就发图，模型不支持时自动去掉图重试；0 = 从不发图（纯文本模型，如 qwen2.5:7b）
const UPSTREAM_VISION = String(process.env.UPSTREAM_VISION || "auto").toLowerCase();
const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32MB，够放整题截图
const MAX_ENTRIES = 20000;

/* ============================================================ 题库 */

/** 与扩展 src/background/cache.js 完全一致的 key 派生规则 —— 两边的题库可以互相导入 */
function normalizeForKey(s) {
  return String(s == null ? "" : s)
    .replace(/[\s\u00a0\u3000]+/g, "")
    .replace(/[\u200b-\u200f\ufeff]/g, "");
}

function md5hex(s) {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

function cacheKey(p) {
  if (!p) return "";
  const type = p.questionType || "";
  const qid = normalizeForKey(p.questionId);
  if (qid) return "id:" + qid + "|" + type;

  const text = normalizeForKey(p.questionText);
  const opts = (Array.isArray(p.options) ? p.options : []).map(normalizeForKey);
  if (text || opts.length) return "txt:" + md5hex(type + "\u0000" + text + "\u0000" + opts.join("\u0001"));

  const img = p.base64 || p.screenshot || "";
  if (img) return "img:" + md5hex(type + "\u0000" + img + "\u0000" + opts.join("\u0001"));
  return "";
}

let bank = { v: 1, meta: { hits: 0, miss: 0 }, entries: {} };

function loadBank() {
  try {
    if (!fs.existsSync(BANK_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(BANK_FILE, "utf8"));
    if (raw && raw.entries && typeof raw.entries === "object") bank = raw;
    bank.meta = bank.meta || { hits: 0, miss: 0 };
    console.log(`[题库] 已加载 ${Object.keys(bank.entries).length} 条 :: ${BANK_FILE}`);
  } catch (e) {
    console.warn("[题库] 读取失败，从空题库开始：", (e && e.message) || e);
  }
}

let saveTimer = null;
let saving = false;
function saveBankSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveBank, 2000);
}
function saveBank() {
  saveTimer = null;
  if (saving) return;
  saving = true;
  try {
    const tmp = BANK_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(bank));
    fs.renameSync(tmp, BANK_FILE);
  } catch (e) {
    console.warn("[题库] 写入失败：", (e && e.message) || e);
  } finally {
    saving = false;
  }
}

/** 超出上限时按最后使用时间淘汰，保留 90% —— 与扩展端一致 */
function trim(entries, max = MAX_ENTRIES) {
  const keys = Object.keys(entries);
  if (keys.length <= max) return entries;
  keys.sort((a, b) => (entries[a].at || 0) - (entries[b].at || 0));
  const drop = keys.length - Math.floor(max * 0.9);
  for (let i = 0; i < drop; i++) delete entries[keys[i]];
  return entries;
}

function bankGet(key) {
  if (!key) return null;
  const hit = bank.entries[key];
  if (hit && hit.o) {
    hit.n = (hit.n || 0) + 1;
    hit.at = Date.now();
    bank.meta.hits = (bank.meta.hits || 0) + 1;
    saveBankSoon();
    return hit;
  }
  bank.meta.miss = (bank.meta.miss || 0) + 1;
  return null;
}

function bankPut(key, option, questionType, engine) {
  if (!key || !option) return;
  const prev = bank.entries[key];
  bank.entries[key] = {
    o: option,
    t: questionType || (prev && prev.t) || "",
    e: engine || "relay",
    n: prev ? prev.n || 0 : 0,
    at: Date.now(),
  };
  trim(bank.entries);
  saveBankSoon();
}

/* ============================================================ 答题 */

const SYSTEM_PROMPT = [
  "你是一个严谨的答题助手。用户会给出题目（题干、选项、题型），你必须给出正确答案。",
  "只输出一个 JSON 对象，不要解释，不要 markdown 代码块。",
  '输出格式：{"option":"答案","isAccurate":1}',
  "option 的取值规则：",
  '- 单选题：单个大写字母，例如 "A"',
  '- 多选题：大写字母连写，例如 "ABD"',
  '- 判断题：只能是 "对" 或 "错"',
  '- 填空题/分录题/资料题：每个空一个答案，多个空用 # 分隔，例如 "答案1#答案2"',
  "- 简答题/名词解释/论述题/计算题/其他题：完整答案文本",
  "isAccurate 固定为 1。",
].join("\n");

function buildUserText(p) {
  const lines = [];
  lines.push(`题型：${p.questionType || "未知"}`);
  if (p.blankNum) lines.push(`空的数量：${p.blankNum}`);
  lines.push("");
  lines.push("题目：");
  lines.push(p.questionText || "(见图片)");
  const options = Array.isArray(p.options) ? p.options : [];
  if (options.length) {
    lines.push("");
    lines.push("选项：");
    options.forEach((o, i) => lines.push(`${String.fromCharCode(65 + i)}. ${o}`));
  }
  // ★ 视频弹题被平台拒收后的重试：必须换一个答案，否则会一直选同一个错项
  const tried = String(p.historyResult || "").trim();
  if (tried) {
    lines.push("");
    lines.push(`注意：本题之前提交过「${tried}」，被平台判为错误。请重新判断并给出不同的答案，绝对不要再给 ${tried}。`);
  }
  return lines.join("\n");
}

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try {
      return JSON.parse(t.slice(s, e + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeAnswer(raw, questionType) {
  if (raw == null) return "";
  let v = raw;
  if (Array.isArray(v)) v = v.join("");
  if (typeof v === "object") {
    if (typeof v.option === "string") v = v.option;
    else if (Array.isArray(v.option)) v = v.option.join("");
    else if (typeof v.answer === "string") v = v.answer;
    else v = JSON.stringify(v);
  }
  v = String(v);
  if (questionType === "单选题" || questionType === "多选题") {
    const letters = v.toUpperCase().match(/[A-Z]/g);
    if (letters && letters.length) return Array.from(new Set(letters)).join("");
  }
  if (questionType === "判断题") {
    const t = String(v).trim();
    // ★ 与 src/background/solver.js 的 normalizeAnswer 保持一致：
    //   否定必须先判（「不正确」「不对」里都含肯定词），否则会判成「对」。
    if (/不正确|不对|不是|错误|错|×|✗|false|^n/i.test(t)) return "错";
    if (/正确|对|是|√|✓|true/i.test(t)) return "对";
    const letters = t.toUpperCase().match(/[A-Z]/g);
    if (letters && letters.length) return letters[0] === "A" ? "对" : "错";
    return t;
  }
  return v.trim();
}

async function callUpstream(p, jsonMode, withImage = true, triedNoImage = false) {
  const content = [{ type: "text", text: buildUserText(p) }];
  const img = p.base64 || p.screenshot;
  const hasImg = typeof img === "string" && img.startsWith("data:image");
  const useImg = hasImg && withImage && UPSTREAM_VISION !== "0";
  if (useImg) {
    content.push({ type: "image_url", image_url: { url: img } });
  }

  const body = {
    model: UPSTREAM_MODEL,
    temperature: UPSTREAM_TEMPERATURE,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${UPSTREAM_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${UPSTREAM_KEY}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 400 && jsonMode) {
    // 很多自建/老版本服务不认 response_format，去掉重试一次
    console.warn("[上游] 400，去掉 response_format 重试");
    return callUpstream(p, false, withImage, triedNoImage);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    // 纯文本模型（qwen2.5:7b 等）收到图片内容会直接报错 —— 去掉图片再试一次
    if (useImg && !triedNoImage && /image|vision|multimodal|image_url|不支持|图片/i.test(t)) {
      console.warn("[上游] 该模型不支持图片，去掉图片重试一次");
      return callUpstream(p, jsonMode, false, true);
    }
    const err = new Error(`上游 HTTP ${res.status} ${t.slice(0, 300)}`);
    err.httpStatus = res.status;
    throw err;
  }

  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  const parsed = extractJson(text);
  if (!parsed) throw new Error("上游返回内容无法解析为 JSON");
  return parsed;
}

/* ============================================================ HTTP */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求体过大（超过 32MB）"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, obj, raw) {
  const body = raw != null ? raw : JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": raw != null ? "application/json; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, null, "");

  const url = new URL(req.url, "http://localhost");
  const route = url.pathname.replace(/\/+$/, "") || "/";

  try {
    /* --- 健康检查 --- */
    if (req.method === "GET" && (route === "/health" || route === "/")) {
      return send(res, 200, {
        ok: true,
        model: UPSTREAM_BASE ? UPSTREAM_MODEL : null,
        mode: UPSTREAM_BASE ? "relay+bank" : "bank-only",
        vision: UPSTREAM_VISION === "0" ? false : "auto",
        needToken: !!RELAY_TOKEN,
        bank: { count: Object.keys(bank.entries).length, hits: bank.meta.hits || 0, miss: bank.meta.miss || 0 },
      });
    }

    /* --- 下载题库 --- */
    if (req.method === "GET" && route === "/bank.json") {
      return send(res, 200, bank);
    }

    /* --- 合并导入题库 --- */
    if (req.method === "POST" && route === "/bank") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (RELAY_TOKEN && body.token !== RELAY_TOKEN) return send(res, 401, { errNo: 403, errMsg: "口令不对" });
      const incoming = body.entries && typeof body.entries === "object" ? body.entries : {};
      let added = 0,
        updated = 0,
        skipped = 0;
      for (const k of Object.keys(incoming)) {
        const e = incoming[k];
        if (!e || typeof e.o !== "string" || !e.o) {
          skipped++;
          continue;
        }
        const prev = bank.entries[k];
        if (!prev) added++;
        else updated++;
        bank.entries[k] = {
          o: e.o,
          t: e.t || (prev && prev.t) || "",
          e: e.e || "import",
          n: Math.max((prev && prev.n) || 0, e.n || 0),
          at: Math.max((prev && prev.at) || 0, e.at || 0) || Date.now(),
        };
      }
      trim(bank.entries);
      saveBank();
      return send(res, 200, { errNo: 0, added, updated, skipped, total: Object.keys(bank.entries).length });
    }

    /* --- 解题 --- */
    if (req.method === "POST" && route === "/solve") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (RELAY_TOKEN && body.token !== RELAY_TOKEN) {
        return send(res, 401, { errNo: 403, errMsg: "口令不对：请在中转和扩展里填同一个 token" });
      }
      const payload = body.payload || {};
      const key = cacheKey(payload);

      // ★ 视频弹题被平台拒收后的重试：**不能吃题库**。
      //   题库里存的正是刚刚被超星拒收的那个答案，吃了就永远换不掉、
      //   内容脚本会一直原地重试到轮数用尽。必须重新问上游。
      const tried = String(payload.historyResult || "").trim();
      const retrying = !!tried;

      const hit = retrying ? null : bankGet(key);
      if (hit) {
        return send(res, 200, {
          errNo: 0,
          result: { option: hit.o, isAccurate: 1, questionType: payload.questionType, engine: "relay-bank" },
        });
      }

      if (!UPSTREAM_BASE) {
        return send(res, 200, {
          errNo: -100,
          errMsg: "中转是纯题库模式（没配 UPSTREAM_BASE），题库里没有这道题",
        });
      }

      const t0 = Date.now();
      let parsed;
      try {
        parsed = await callUpstream(payload, true);
      } catch (e) {
        const msg = (e && e.message) || String(e);
        console.error(`[解题] 失败 ${Date.now() - t0}ms :: ${msg}`);
        return send(res, 200, { errNo: -4, errMsg: msg });
      }

      const option = normalizeAnswer(parsed.option ?? parsed.answer, payload.questionType);
      if (!option) return send(res, 200, { errNo: -8, errMsg: "模型没给出答案" });

      bankPut(key, option, payload.questionType, "relay-llm");
      console.log(
        `[解题] ${Date.now() - t0}ms ${payload.questionType || "?"} -> ${option.slice(0, 40).replace(/\n/g, " ")}`
      );
      return send(res, 200, {
        errNo: 0,
        result: { option, isAccurate: 1, questionType: payload.questionType, engine: "relay-llm" },
      });
    }

    return send(res, 404, { errNo: -1, errMsg: "没有这个接口：" + route });
  } catch (e) {
    return send(res, 500, { errNo: -1, errMsg: (e && e.message) || String(e) });
  }
});

loadBank();
server.listen(PORT, () => {
  console.log("─────────────────────────────────────────────");
  console.log(`  答题中转已启动  http://127.0.0.1:${PORT}`);
  console.log(`  模式     : ${UPSTREAM_BASE ? "题库 + 上游模型" : "纯题库（未配 UPSTREAM_BASE）"}`);
  if (UPSTREAM_BASE) {
    console.log(`  上游     : ${UPSTREAM_BASE}  model=${UPSTREAM_MODEL}`);
    console.log(`  图片支持 : ${UPSTREAM_VISION === "0" ? "关（纯文本模型，跳过图片题）" : "自动（模型不支持时自动降级）"}`);
  }
  console.log(`  口令     : ${RELAY_TOKEN ? "已启用" : "未设置（谁都能用）"}`);
  console.log(`  题库文件 : ${BANK_FILE}`);
  console.log("─────────────────────────────────────────────");
  console.log("  扩展设置里「答案来源」选「答题中转」，地址填：");
  console.log(`  ${UPSTREAM_BASE ? "" : ""}http://<这台机器的局域网IP>:${PORT}/solve`);
  console.log("  别人电脑上用就在防火墙放行端口，并把上面的 IP 换成你的局域网地址。");
  console.log("─────────────────────────────────────────────");
});

process.on("SIGINT", () => {
  saveBank();
  console.log("\n题库已保存，退出。");
  process.exit(0);
});
// Windows 上程序化 kill / 服务被停掉时不一定有 SIGINT，补一个兜底
process.on("exit", () => {
  try {
    saveBank();
  } catch {
    /* 退出阶段不再抛错 */
  }
});
