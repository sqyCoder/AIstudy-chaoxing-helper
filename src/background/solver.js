/**
 * src/background/solver.js — 求解器。
 *
 * 两条可插拔的答题通道（对应逆向出的 handleSolveExercise）：
 *   1) "llm"    —— 用户自己的 OpenAI 兼容 /chat/completions（默认）
 *   2) "origin" —— 原服务器接口 /dxai/submit/exercise/solve（一键切回）
 *
 * 原接口要点（逆向自 @api/search）：
 *   - host = https://www.daxuesoutijiang.com
 *   - method = FILE ⇒ 请求包装器把它变成 POST + FormData(multipart)
 *   - needSignature = false ⇒ 答题链路上没有 fkey/ftime，只有公共参数
 *   - 公共参数：appId=collegepcpi, vcname=1.17.1, os, sourceAppId, vc=1171
 *   - 响应是明文 JSON（AESCBCDecrypt 从未被调用），{errNo:0, data:{option, isAccurate}}
 */
import { md5 } from "../../lib/md5.js";

export const ORIGIN_HOST = "https://www.daxuesoutijiang.com";
export const ORIGIN_SOLVE_PATH = "/dxai/submit/exercise/solve";
const APP_ID = "collegepcpi";
const VCNAME = "1.17.1";
const VC = 1171;

/* ------------------------------------------------------------ 公共 */

export function getOperatingSystem() {
  const ua = navigator.userAgent || "";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Linux/i.test(ua)) return "linux";
  return "unknown";
}

function commonParams(sourceAppId) {
  return {
    appId: APP_ID,
    vcname: VCNAME,
    os: getOperatingSystem(),
    sourceAppId: sourceAppId || "",
    vc: VC,
  };
}

export function base64ToBytes(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** 取出 data URL 里的 base64 文本（原插件的 picMD5 就是对这段文本做 md5） */
function base64Payload(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return "";
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/* ------------------------------------------------- 答案规范化 */

const CHOICE = new Set(["单选题", "多选题", "判断题"]);

export function normalizeAnswer(raw, questionType) {
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
    // "A、B" / "A,B" / "AB" -> "AB"
    const letters = v.toUpperCase().match(/[A-Z]/g);
    if (letters && letters.length) return Array.from(new Set(letters)).join("");
  }
  if (questionType === "判断题") {
    const t = String(v).trim();
    // ★ 否定必须先判：「不正确」「不对」「错误」里都含肯定词，
    //   原来写成 `/对|正确|是|true|√|T/i` 先跑，会把「不正确」判成「对」，
    //   而且 /i 让单个字母 T 命中任意小写 t（"not correct" → "对"）。
    if (/不正确|不对|不是|错误|错|×|✗|false|^n/i.test(t)) return "错";
    if (/正确|对|是|√|✓|true/i.test(t)) return "对";
    // 网页版常直接返回选项字母（选项是「A 对 / B 错」）
    const letters = t.toUpperCase().match(/[A-Z]/g);
    if (letters && letters.length) return letters[0] === "A" ? "对" : "错";
    return t;
  }
  return v.trim();
}

/* ---------------------------------------------------- LLM 通道 */

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

function buildUserText(payload) {
  const lines = [];
  lines.push(`题型：${payload.questionType || "未知"}`);
  if (payload.blankNum) lines.push(`空的数量：${payload.blankNum}`);
  lines.push("");
  lines.push("题目：");
  lines.push(payload.questionText || "(见图片)");
  const options = Array.isArray(payload.options) ? payload.options : [];
  if (options.length) {
    lines.push("");
    lines.push("选项：");
    options.forEach((o, i) => lines.push(`${String.fromCharCode(65 + i)}. ${o}`));
  }
  // ★ 视频弹题被平台拒收后的重试：必须换一个答案，否则会一直选同一个错项
  const tried = String(payload.historyResult || "").trim();
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
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function joinUrl(base, path) {
  if (!base) return path;
  return base.replace(/\/+$/, "") + "/" + String(path).replace(/^\/+/, "");
}

/** 是否指向本机模型服务（Ollama / LM Studio / llama.cpp 之类） */
export function isLocalBase(baseUrl) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(String(baseUrl || ""));
}

/** 本地推理的首字延迟可能很长（模型冷加载），默认给足 3 分钟 */
const DEFAULT_TIMEOUT_MS = 180000;

/** 一次 LLM 调用；jsonMode 单独传，便于上游不支持时重试 */
async function callLlm(payload, cfg, jsonMode) {
  const content = [];
  content.push({ type: "text", text: buildUserText(payload) });

  if (payload.base64 || payload.screenshot) {
    const url = payload.base64 || payload.screenshot;
    if (typeof url === "string" && url.startsWith("data:image")) {
      content.push({ type: "image_url", image_url: { url } });
    }
  }

  const body = {
    model: cfg.model,
    temperature: typeof cfg.temperature === "number" ? cfg.temperature : 0.1,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;

  let res;
  try {
    res = await fetch(joinUrl(cfg.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + (cfg.apiKey || ""),
      },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || e.name === "TimeoutError");
    if (aborted) {
      return {
        errNo: -3,
        errMsg: `模型请求超时（${Math.round(timeoutMs / 1000)} 秒）。本地模型冷启动可能较慢，可在设置页调大超时，或先手动跑一次让它加载进显存。`,
      };
    }
    if (isLocalBase(cfg.baseUrl)) {
      return {
        errNo: -3,
        errMsg:
          "连不上本地模型服务（" +
          cfg.baseUrl +
          "）。请确认 Ollama 已安装并在运行：命令行执行 `ollama serve`（或从开始菜单启动 Ollama），" +
          "并已 `ollama pull " +
          (cfg.model || "模型名") +
          "`。原始错误：" +
          ((e && e.message) || e),
      };
    }
    return { errNo: -3, errMsg: "无法连接大模型接口：" + ((e && e.message) || e) };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    return { errNo: -4, httpStatus: res.status, errMsg: `大模型接口返回 ${res.status}：${detail}` };
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    return { errNo: -5, errMsg: "大模型返回不是合法 JSON" };
  }

  const text = json?.choices?.[0]?.message?.content;
  if (!text) return { errNo: -6, errMsg: "大模型返回内容为空" };

  const parsed = extractJson(text);
  if (!parsed) return { errNo: -7, errMsg: "无法从模型输出中解析答案：" + String(text).slice(0, 200) };

  const option = normalizeAnswer(parsed, payload.questionType);
  if (!option) return { errNo: -8, errMsg: "模型未给出答案" };

  return {
    errNo: 0,
    result: {
      option,
      isAccurate: typeof parsed.isAccurate === "number" ? parsed.isAccurate : 1,
      raw: parsed,
      engine: "llm",
    },
  };
}

/**
 * @param {object} payload  题目载荷
 * @param {object} cfg      {baseUrl, apiKey, model, temperature, jsonMode, timeoutMs}
 *
 * 兼容性兜底：不少本机/自建服务（老版本 Ollama、llama.cpp、vLLM 的某些配置）
 * 不认 response_format，会直接返回 400。这时去掉 response_format 再试一次，
 * 提示词本身已经要求「只输出 JSON」，所以成功率几乎不受影响。
 */
export async function solveWithLlm(payload, cfg) {
  if (!cfg || !cfg.baseUrl) {
    return { errNo: -2, errMsg: "未配置大模型 API 地址，请在设置页填写。" };
  }
  if (!cfg.model) {
    return { errNo: -2, errMsg: "未配置模型名称，请在设置页填写。" };
  }

  const wantJson = cfg.jsonMode !== false;
  const first = await callLlm(payload, cfg, wantJson);
  if (wantJson && first.errNo === -4 && first.httpStatus === 400) {
    const retry = await callLlm(payload, cfg, false);
    if (retry.errNo === 0) return retry;
    return first;
  }
  return first;
}

/** 设置页的「测试连接」 */
export async function testLlm(cfg) {
  const res = await solveWithLlm(
    { questionText: "1+1 等于几？", questionType: "单选题", options: ["1", "2", "3", "4"] },
    cfg
  );
  return res;
}

/* ------------------------------------------------ 原服务器通道 */

export async function solveWithOrigin(payload, sourceAppId) {
  const form = new FormData();
  const common = commonParams(sourceAppId);
  Object.keys(common).forEach((k) => form.append(k, String(common[k])));

  const imageData = payload.base64 || payload.screenshot || "";
  const bytes = imageData ? base64ToBytes(imageData) : null;
  if (bytes && bytes.length) {
    form.append("image", new Blob([bytes], { type: "image/jpeg" }), "q.jpg");
  } else {
    form.append("image", new Blob([], { type: "image/jpeg" }), "q.jpg");
  }
  form.append("picMD5", imageData ? md5(base64Payload(imageData)) : "");

  form.append("historyResult", payload.historyResult || "");
  form.append("questionText", payload.questionText || "");
  form.append("questionId", payload.questionId || "");
  form.append("options", JSON.stringify(payload.options || []));
  form.append("questionType", payload.questionType || "");
  form.append("questionFrom", payload.questionFrom || "");
  form.append("blankNum", String(payload.blankNum || 0));
  form.append("llmType", payload.llmType || "");
  form.append("exciseUrl", payload.exciseUrl || "");
  form.append("chapterName", payload.chapterName || "");
  form.append("courseName", payload.courseName || "");
  form.append("courseId", payload.courseId || "");
  form.append("ceYanName", payload.ceYanName || "");
  form.append("questionTextHtml", payload.questionTextHtml || "");

  let res;
  try {
    res = await fetch(ORIGIN_HOST + ORIGIN_SOLVE_PATH, {
      method: "POST",
      body: form,
      credentials: "include",
    });
  } catch (e) {
    return { errNo: -3, errMsg: "无法连接原服务器接口：" + (e?.message || e) };
  }
  if (res.status === 204) return { errNo: -9, errMsg: "原接口返回 204" };
  if (!res.ok) return { errNo: -4, errMsg: "原接口返回 HTTP " + res.status };

  let json;
  try {
    json = await res.json();
  } catch {
    return { errNo: -5, errMsg: "原接口返回不是合法 JSON" };
  }

  if (json.errNo === 3 || json.errNo === 303) {
    return { errNo: json.errNo, errMsg: "未登录或登录已失效，请先在 daxuesoutijiang.com 登录。" };
  }
  if (json.errNo !== 0) {
    return { errNo: json.errNo, errMsg: json.errMsg || json.errmsg || "原接口返回错误" };
  }

  const data = json.data || {};
  const option = normalizeAnswer(data.option ?? data.answer, payload.questionType);
  return {
    errNo: 0,
    result: {
      option,
      isAccurate: typeof data.isAccurate === "number" ? data.isAccurate : 1,
      raw: data,
      engine: "origin",
    },
  };
}

/* --------------------------------------------------- 答题中转通道 */

/**
 * 「答题中转」通道 —— 分享给朋友的正确姿势。
 *
 * 原版之所以「下载即用」，是因为 daxuesoutijiang.com 在背后养着服务器和算力，
 * 客户端只负责把题目发过去。这部分不是代码，没法从 CRX 里掏出来。
 * 所以本复刻让你自己架一次同样的角色：你部署 server/answer-relay.mjs，
 * 把 API Key 放在服务端，然后把中转地址填在这里（或直接写进 DEFAULT_RELAY_URL 常量）。
 * 朋友拿到扩展后零配置即可用，Key 与算力都在你这边。
 *
 * 协议（同时也是 server/answer-relay.mjs 实现的契约）：
 *   请求 POST <relayUrl>   JSON: { token?, payload: {...题目字段} }
 *   响应 JSON: { errNo, result: { option, isAccurate, questionType?, engine? }, errMsg? }
 */
export async function solveWithRelay(payload, relayUrl, token, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token || "", payload }),
      signal: ctrl.signal,
    });
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return {
      errNo: aborted ? -6 : -3,
      errMsg: aborted
        ? "答题中转超时（" + Math.round((Number(timeoutMs) || DEFAULT_TIMEOUT_MS) / 1000) + " 秒没响应）。"
        : "连不上答题中转：" + ((e && e.message) || e) + " —— 请确认中转服务在运行、地址填对了。",
    };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 204) return { errNo: -9, errMsg: "答题中转返回 204（无内容）" };
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    return { errNo: -4, errMsg: "答题中转返回 HTTP " + res.status + (body ? "：" + body : "") };
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return { errNo: -5, errMsg: "答题中转返回不是合法 JSON" };
  }

  if (!json || (json.errNo !== 0 && json.errNo !== undefined && json.errNo !== null)) {
    return { errNo: json?.errNo ?? -7, errMsg: json?.errMsg || "答题中转返回错误" };
  }
  const r = json.result || json.data || {};
  const option = normalizeAnswer(r.option ?? r.answer, payload.questionType);
  if (!option) return { errNo: -8, errMsg: "答题中转没有给出答案" };
  return {
    errNo: 0,
    result: {
      option,
      isAccurate: typeof r.isAccurate === "number" ? r.isAccurate : 1,
      questionType: r.questionType || payload.questionType,
      engine: r.engine || "relay",
    },
  };
}

/**
 * 测试中转：先打 /health（便宜、不消耗模型额度），
 * 如果中转没实现 /health 就退化为发一道 1+1 的真题走完整链路。
 */
export async function testRelay(cfg) {
  const relayUrl = (cfg && cfg.relayUrl) || "";
  const token = (cfg && cfg.relayToken) || "";
  const timeoutMs = Number(cfg && cfg.timeoutMs) || DEFAULT_TIMEOUT_MS;

  if (!relayUrl) return { errNo: -3, errMsg: "还没填中转地址。例如 http://192.168.1.10:8787/solve" };

  const healthUrl = relayUrl.replace(/\/solve\/?$/, "/health");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, 15000));
  try {
    const res = await fetch(healthUrl, { signal: ctrl.signal });
    if (res.ok) {
      const h = await res.json().catch(() => null);
      if (h && h.ok) {
        const modeText =
          h.mode === "bank-only"
            ? "当前是纯题库模式（没配上游模型），只有题库里已有的题能答"
            : "上游模型 " + (h.model || "?");
        return {
          errNo: 0,
          result: {
            note: `模式=${h.mode}｜${modeText}｜题库 ${h.bank?.count ?? 0} 条｜口令=${h.needToken ? "需要" : "不需要"}`,
          },
        };
      }
    }
  } catch {
    /* /health 不可用就往下走真实解题 */
  } finally {
    clearTimeout(timer);
  }

  const res = await solveWithRelay(
    { questionText: "1+1 等于几？", questionType: "单选题", options: ["1", "2", "3", "4"] },
    relayUrl,
    token,
    Math.min(timeoutMs, 60000)
  );
  if (res.errNo === 0) return { errNo: 0, result: { note: "（/health 不存在，已用真实解题验证）答案=" + res.result.option } };
  if (res.errNo === -100) {
    return { errNo: 0, result: { note: "中转可达，但当前是纯题库模式（/health 也没实现）。题库里已有的题能答。" } };
  }
  return res;
}

/** 用扩展自带的 MD5 计算图片摘要（与原插件 picMD5 口径一致：对 base64 文本取摘要） */