/**
 * src/background/web-solver.js —— 「网页版 DeepSeek」这条免费答题通道的后台驱动
 * ==========================================================================================
 *
 * 思路：不调任何 API，而是开一个 chat.deepseek.com 的后台标签页，把题目打进去、等它答完、
 *       把回答抠回来。标签页用 active:false 创建/更新，**不会抢你的焦点**，你可以继续用电脑
 *       干别的；页面自身的流式请求在后台照常跑，等待靠内容脚本里的 MutationObserver
 *       （不受后台标签定时器节流影响，详见 src/content/deepseek.js 顶部注释）。
 *
 * 每题都先把标签页导航到 https://chat.deepseek.com/ 开一个全新会话 —— 实测这样最干净：
 *   ① 不带上一题的上下文，不会被带偏；
 *   ② 顺带把可能卡住的状态一起重置。
 *
 * ⚠ 已知代价与风险（务必知情）：
 *   - 必须已登录 chat.deepseek.com；偶尔会弹人机验证，需要人工点一下；
 *   - 网页版有频率限制，问太快会被限流；
 *   - 自动化操作网页版**可能违反其服务条款，有封号风险**；
 *   - 比 API 慢（每题页面加载 + 生成，约 8~20 秒）。
 */
import { normalizeAnswer } from "./solver.js";

const DS_ORIGIN = "https://chat.deepseek.com/";
const DEFAULT_TIMEOUT_MS = 120000;

/** 记住上次用的标签页，避免每次都新开 */
let cachedTabId = null;

/* ------------------------------------------------------------------ 提示词 */

function buildPrompt(payload) {
  const lines = [];
  lines.push("你是答题助手。请只输出答案本身，不要解释、不要分析、不要 markdown 代码块。");
  lines.push("");
  lines.push("题型：" + (payload.questionType || "未知"));
  if (payload.blankNum) lines.push("空的数量：" + payload.blankNum);
  lines.push("题目：");
  lines.push(payload.questionText || "(见图片)");
  const options = Array.isArray(payload.options) ? payload.options : [];
  if (options.length) {
    lines.push("选项：");
    options.forEach((o, i) => lines.push(String.fromCharCode(65 + i) + ". " + o));
  }
  const tried = String(payload.historyResult || "").trim();
  if (tried) {
    lines.push("");
    lines.push(
      "注意：本题之前提交过「" + tried + "」，被平台判为错误。请重新判断并给出不同答案，不要再给 " + tried + "。"
    );
  }
  lines.push("");
  lines.push("输出要求：");
  lines.push("- 单选题：只输出一个大写字母，例如 A");
  lines.push("- 多选题：只输出大写字母连写，例如 ABD");
  lines.push("- 判断题：只输出「对」或「错」");
  lines.push("- 填空题：每个空一个答案，多个空用 # 分隔");
  lines.push("- 简答/论述等：直接输出答案正文");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ 回答解析 */

/**
 * 网页版比 API 更爱「多写两句」，直接用 relay 那套 normalizeAnswer 有风险：
 * 它对选择题会把文本里所有大写字母都收进来（"答案是A。B不对" → "AB"）。
 * 所以这里先按「整行就是答案」严格匹配，再退化到关键词，最后才交给 normalizeAnswer。
 */
export function parseWebAnswer(raw, questionType, optionCount) {
  let t = String(raw == null ? "" : raw).trim();
  if (!t) return "";

  // 去掉 markdown 粗体/标题/行内代码等装饰
  t = t.replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-zA-Z]*\n?/g, "")).replace(/[*`#>]/g, "");

  const isChoice = questionType === "单选题" || questionType === "多选题";
  const maxLetter = String.fromCharCode(65 + Math.max(1, Math.min(optionCount || 6, 26)) - 1);

  if (isChoice) {
    const letterRe = new RegExp("^[\\s（(【\\[]*([A-" + maxLetter + "])(?:[\\s、,，。.．)）】\\]]*)$");
    // 1) 某一行本身就是答案
    const lines = t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const line of lines) {
      const m = line.match(letterRe);
      if (m) return m[1];
    }
    // 2) 带关键词的行
    //    ⚠ 多选题必须在**整行**里收集全部合法字母：原来用 `kw[0].match(/[A-Z]/g)`，
    //      而关键词正则结尾是 `([A-Z])`，`kw[0]` 在第一个字母处就结束，
    //      「答案：ABD 因为…」会被截成 "A"，只勾一个选项还被写进题库。
    if (questionType === "多选题") {
      for (const line of lines) {
        if (!/(?:答案|应选|正确选项|选)/.test(line)) continue;
        const ls = Array.from(
          new Set((line.toUpperCase().match(/[A-Z]/g) || []).filter((c) => c <= maxLetter))
        );
        if (ls.length) return ls.join("");
      }
    } else {
      const kw = t.match(/(?:答案|应选|正确选项|选)\s*(?:是|为|：|:)?\s*[（(【\[]?\s*([A-Z])/);
      if (kw && kw[1] <= maxLetter) return kw[1];
    }
    // 3) 全文里就只有一个合法字母 ⇒ 就是它
    const all = Array.from(new Set((t.match(/[A-Z]/g) || []).filter((c) => c <= maxLetter)));
    if (all.length === 1) return all[0];
    // 4) 退化：交给通用规范化（可能不完美，但不至于空手而归）
    return normalizeAnswer(t, questionType);
  }

  // 判断题/填空题/简答题：交给通用规范化
  return normalizeAnswer(t, questionType);
}

/* -------------------------------------------------------------- 批量（整页一次问完） */

/**
 * ★ 为什么要有批量：
 *   网页版 DeepSeek 对「短时间内新建会话 + 连续发消息」非常敏感，逐题问会直接
 *   被判定「消息发送频繁」而不作答。而且每题都导航到根路径 = 每次都刷新一次页面，
 *   又慢又容易被风控。整份章节测验合并成**一条消息**问完，只刷新一次、只发一条。
 */
export function buildBatchPrompt(items) {
  const lines = [];
  lines.push("你是答题助手。下面有多道题，请**一次性全部作答**。");
  lines.push("只输出一个 JSON 数组，不要解释、不要任何 markdown 代码块、不要多余文字。");
  lines.push('格式：[{"i":1,"answer":"A"},{"i":2,"answer":"对"}]');
  lines.push("answer 的取值：单选题=单个大写字母；多选题=大写字母连写；判断题=「对」或「错」；填空题=多个空用 # 分隔；简答题=答案正文。");
  lines.push("");
  items.forEach((p, idx) => {
    lines.push("【第 " + (idx + 1) + " 题】i=" + (idx + 1) + "  题型：" + (p.questionType || "未知"));
    lines.push("题目：" + (p.questionText || "").replace(/\s+/g, " ").trim());
    const options = Array.isArray(p.options) ? p.options : [];
    if (options.length) {
      lines.push("选项：");
      options.forEach((o, i) => lines.push(String.fromCharCode(65 + i) + ". " + String(o).replace(/\s+/g, " ").trim()));
    }
    lines.push("");
  });
  lines.push("再次强调：只输出那个 JSON 数组，共 " + items.length + " 个元素。");
  return lines.join("\n");
}

/** 从模型回答里抠出 JSON 数组（容忍代码块、前后废话） */
function extractJsonArray(text) {
  let t = String(text || "").replace(/```[a-zA-Z]*/g, "").replace(/```/g, "").trim();
  const s = t.indexOf("[");
  const e = t.lastIndexOf("]");
  if (s >= 0 && e > s) {
    try {
      const arr = JSON.parse(t.slice(s, e + 1));
      if (Array.isArray(arr)) return arr;
    } catch (err) {
      /* 落到行解析 */
    }
  }
  return null;
}

/**
 * 解析批量回答 → 与 items 等长的答案数组（认不出的位置是空串）。
 * 三级兜底：① JSON 数组里带 i 的对象；② JSON 字符串数组（按顺序）；③ 逐行 `1. A` / `1、对`。
 */
export function parseBatchAnswers(text, items) {
  const n = items.length;
  const out = new Array(n).fill("");

  const arr = extractJsonArray(text);
  if (arr) {
    if (arr.length && typeof arr[0] === "object" && arr[0] !== null) {
      arr.forEach((o, k) => {
        const idx = Number(o.i != null ? o.i : o.index != null ? o.index : o.n != null ? o.n : k + 1) - 1;
        if (idx < 0 || idx >= n) return;
        const raw = o.answer != null ? o.answer : o.option != null ? o.option : o.a;
        out[idx] = parseWebAnswer(String(raw == null ? "" : raw), items[idx].questionType, (items[idx].options || []).length);
      });
    } else {
      arr.forEach((v, k) => {
        if (k >= n) return;
        out[k] = parseWebAnswer(String(v == null ? "" : v), items[k].questionType, (items[k].options || []).length);
      });
    }
    if (out.some((x) => x)) return out;
  }

  // 行解析：形如 "1. A" / "1、对" / "第1题：B" / "i=1 answer=对"
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const m =
      line.match(/(?:^|\D)(\d{1,2})\s*[.、:：)）]?\s*(?:i\s*=\s*\d+\s*)?(?:answer\s*[=:：]\s*)?([A-Za-z]|对|错|正确|错误|是|否)\s*$/);
    if (!m) continue;
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= n || out[idx]) continue;
    out[idx] = parseWebAnswer(m[2], items[idx].questionType, (items[idx].options || []).length);
  }
  return out;
}

/** 批量走网页版：一条消息问完整页题 */
async function solveBatchWithWebOnce(items, cfg) {
  const timeoutMs = Number((cfg && cfg.timeoutMs) || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  let tabId;
  try {
    tabId = await ensureTab();
  } catch (e) {
    return { errNo: -3, errMsg: "打不开 DeepSeek 标签页：" + ((e && e.message) || e) };
  }
  try {
    await gotoSafe(tabId);
    if (!(await waitTabComplete(tabId, Math.min(timeoutMs, 15000)))) {
      return { errNo: -3, errMsg: "DeepSeek 页面加载超时（可能没登录或网络不通）" };
    }
    if (!(await ensureContentScript(tabId, true))) {
      return await needLogin(tabId);
    }
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: "DS_ASK",
      prompt: buildBatchPrompt(items),
      // 一次答多题，生成更久；但要有上限，别让「等待」无限制膨胀
      timeoutMs: Math.min(Math.max(timeoutMs, 45000 + items.length * 15000), 240000),
    });
    if (!resp || !resp.ok) {
      return { errNo: -4, errMsg: "网页版批量作答失败：" + ((resp && resp.reason) || "unknown") };
    }
    return { errNo: 0, answers: parseBatchAnswers(resp.answer, items), raw: String(resp.answer || "").slice(0, 600), ms: resp.ms };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
      return { errNo: -3, errMsg: "DeepSeek 标签页没响应，可能被关掉了：请保持那个标签页开着" };
    }
    return { errNo: -4, errMsg: "网页版批量通道异常：" + msg };
  }
}

/**
 * 整页题目一次性问完。
 * @returns {Promise<{errNo:number, answers?:string[], errMsg?:string}>}
 */
export async function solveBatchWithWeb(items, cfg) {
  if (!Array.isArray(items) || !items.length) return { errNo: -1, errMsg: "空题目列表" };
  const MAX_ATTEMPTS = 2;
  let last = null;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const t0 = Date.now();
    const r = await solveBatchWithWebOnce(items, cfg);
    if (r && r.errNo === 0 && r.answers && r.answers.filter(Boolean).length) {
      // 部分认不出也返回，让上层对个别题回退到单题通道
      return r;
    }
    last = r;
    if (r && r.errNo === -3) break;
    // 同 solveWithWeb：慢失败多半是限流，别再翻倍等待
    if (Date.now() - t0 > 120000) break;
    if (i < MAX_ATTEMPTS) await new Promise((res) => setTimeout(res, 2000));
  }
  return last || { errNo: -4, errMsg: "网页版批量作答失败" };
}

/* ------------------------------------------------------------------ 标签页 */

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (e) {
    return null;
  }
}

/** 找到可用的 DeepSeek 标签页；没有就后台开一个（不抢焦点） */
async function ensureTab() {
  if (cachedTabId != null) {
    const t = await getTab(cachedTabId);
    if (t && t.url && t.url.indexOf("deepseek.com") >= 0) return cachedTabId;
    cachedTabId = null;
  }
  // 先在已开标签里找
  let list = [];
  try {
    list = await chrome.tabs.query({ url: "https://chat.deepseek.com/*" });
  } catch (e) {
    list = [];
  }
  if (list && list.length) {
    cachedTabId = list[0].id;
    return cachedTabId;
  }
  const created = await chrome.tabs.create({ url: DS_ORIGIN, active: false });
  cachedTabId = created.id;
  return cachedTabId;
}

/** 每题都开新会话：导航到根路径最干净（实测根路径就是全新会话） */
async function gotoSafe(tabId) {
  await chrome.tabs.update(tabId, { url: DS_ORIGIN });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等标签页 load 完（轮询 chrome.tabs.get，不用 onUpdated，少一份监听要清） */
async function waitTabComplete(tabId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = await getTab(tabId);
    if (t && t.status === "complete") return true;
    await sleep(250);
  }
  return false;
}

/**
 * 内容脚本可能还没注入完 —— 失败就补注入一次再重试。
 *
 * @param {number} tabId
 * @param {boolean} [requireInput] true = 还要求页面里**真的有输入框**（也就是已登录）。
 *
 * ⚠ 分享给同学时这一步是关键：没登录时 chat.deepseek.com 只有登录页，没有 textarea。
 *   旧写法只判 `r.ok` 就算「注入成功」，于是一路走到 DS_ASK 再白等 20 秒、还要重试一次，
 *   最后丢一句同学看不懂的 `no_input`。现在当场判失败，交给 needLogin() 去提示。
 */
async function ensureContentScript(tabId, requireInput) {
  for (let i = 0; i < 8; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: "DS_PING" });
      if (r && r.ok) {
        if (!requireInput) return true;
        if (r.hasInput) return true;
        // 驱动已经注入成功了，只是页面上没有输入框 ⇒ 就是没登录，再重试注入也没用
        return false;
      }
    } catch (e) {
      /* 还没注入 */
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ["src/content/deepseek.js"],
      });
    } catch (e) {
      /* 标签页可能正在导航，下一轮再试 */
    }
    await sleep(400);
  }
  return false;
}

/**
 * 没登录时的统一处理：**把那个 DeepSeek 标签页切到前台**（原来是后台开的，同学根本看不见），
 * 再返回一句能照着做的错误。这样同学的第一反应是「哦我要登录」，而不是「这插件坏了」。
 */
async function needLogin(tabId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
    const t = await chrome.tabs.get(tabId);
    if (t && t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
  } catch (e) {
    /* 切前台失败不影响返回错误 */
  }
  return {
    errNo: -3,
    errMsg:
      "请先在刚打开的 chat.deepseek.com 标签页里登录你的账号（登录完成后回到课程页重开一次即可）。" +
      "本模式用你自己的 DeepSeek 网页版账号作答，免费、不需要填任何 Key。",
  };
}

/* ------------------------------------------------------------------ 对外入口 */

/**
 * @param {object} payload 与 SolverExercise 的 payload 同构
 * @param {object} cfg { timeoutMs, tabUrl }
 * @returns {Promise<{errNo:number, result?:object, errMsg?:string}>}
 */
async function solveWithWebOnce(payload, cfg) {
  const timeoutMs = Number((cfg && cfg.timeoutMs) || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  let tabId;
  try {
    tabId = await ensureTab();
  } catch (e) {
    return { errNo: -3, errMsg: "打不开 DeepSeek 标签页：" + ((e && e.message) || e) };
  }

  try {
    await gotoSafe(tabId);
    const ok = await waitTabComplete(tabId, Math.min(timeoutMs, 15000));
    if (!ok) return { errNo: -3, errMsg: "DeepSeek 页面加载超时（可能没登录或网络不通）" };

    if (!(await ensureContentScript(tabId, true))) {
      return await needLogin(tabId);
    }

    const prompt = buildPrompt(payload);
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: "DS_ASK",
      prompt: prompt,
      timeoutMs: timeoutMs,
    });

    if (!resp || !resp.ok) {
      return { errNo: -4, errMsg: "网页版 DeepSeek 作答失败：" + ((resp && resp.reason) || "unknown") };
    }

    const optionCount = Array.isArray(payload.options) ? payload.options.length : 0;
    const option = parseWebAnswer(resp.answer, payload.questionType, optionCount);
    if (!option) {
      return {
        errNo: -8,
        errMsg: "没能从网页版回答里认出答案（原文：" + String(resp.answer || "").slice(0, 120) + "）",
      };
    }
    return {
      errNo: 0,
      result: {
        option: option,
        isAccurate: 1,
        questionType: payload.questionType,
        engine: "deepseek-web",
        raw: String(resp.answer || "").slice(0, 400),
        ms: resp.ms,
        partial: !!resp.partial,
      },
    };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
      return { errNo: -3, errMsg: "DeepSeek 标签页没响应，可能被关掉了：请保持那个标签页开着" };
    }
    return { errNo: -4, errMsg: "网页版 DeepSeek 通道异常：" + msg };
  }
}

/**
 * 网页版 DeepSeek 免费通道的对外入口。
 *
 * ⚠ 为什么必须带重试：免费网页版会排队。同一场真机测验里实测三题耗时
 *   35.8s / **超时 150s 一个字没吐** / 12.7s。而章节测验是「只要有一题不确定就
 *   只暂存、不提交」——一题超时就会让整份测验卡在「待完成」。
 *   所以「没拿到答案」必须换一个新会话重试一次。
 */
export async function solveWithWeb(payload, cfg) {
  const timeoutMs = Number((cfg && cfg.timeoutMs) || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const MAX_ATTEMPTS = 2;
  let last = null;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const t0 = Date.now();
    const r = await solveWithWebOnce(payload, { timeoutMs: timeoutMs });
    if (r && r.errNo === 0) return r;
    last = r;
    const code = r && r.errNo;
    // -4（作答失败/超时）与 -8（认不出答案）值得换新会话重试；
    // -3（标签页打不开/注入失败/没登录）重试也没用，直接返回，免得卡两倍时间。
    if (code !== -4 && code !== -8) break;
    // ★ 只在「快速失败」时重试。慢失败（>90s）几乎都是 DeepSeek 限流/排队，
    //   再试一次只会把单题等待翻倍到 5 分钟以上，用户体感就是「卡死」。
    if (Date.now() - t0 > 90000) break;
    if (i < MAX_ATTEMPTS) await new Promise((res) => setTimeout(res, 1500));
  }
  return last || { errNo: -4, errMsg: "网页版 DeepSeek 作答失败" };
}

/** 设置页的「测试网页版」用：只做一次连通性自检，不真的答题 */
export async function testWeb() {
  let tabId;
  try {
    tabId = await ensureTab();
    await gotoSafe(tabId);
    const ok = await waitTabComplete(tabId, 15000);
    if (!ok) return { ok: false, errMsg: "页面加载超时" };
    if (!(await ensureContentScript(tabId))) return { ok: false, errMsg: "驱动注入失败" };
    const ping = await chrome.tabs.sendMessage(tabId, { type: "DS_PING" });
    if (ping && ping.ok && ping.hasInput) {
      return { ok: true, info: "已连上 chat.deepseek.com（输入框就绪）" + (ping.url ? " · " + ping.url : "") };
    }
    return { ok: false, errMsg: "页面里找不到输入框，可能没登录" };
  } catch (e) {
    return { ok: false, errMsg: (e && e.message) || String(e) };
  }
}
