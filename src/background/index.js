/**
 * src/background/index.js — MV3 service worker（ES module）。
 *
 * 职责：
 *   1. 消息总线（对应逆向出的 onMessage / onMessageExternal 派发）
 *   2. 求解：把题目交给 solver.js，按设置走 LLM 或原服务器接口
 *   3. MAIN world 注入：把 UEditor 赋值消息广播到指定 tab 的所有 frame
 *   4. 可视区域截图：chrome.tabs.captureVisibleTab
 */
import { solveWithLlm, solveWithOrigin, solveWithRelay, testLlm, testRelay } from "./solver.js";
import { solveWithWeb, solveBatchWithWeb, testWeb } from "./web-solver.js";
import { cacheKey, cacheGet, cachePut, cacheStats, cacheExport, cacheImport, cacheClear } from "./cache.js";

const PFX = "dxrep_";

const MSG = {
  GET_SETTINGS: "GetSettings",
  SET_SETTINGS: "SetSettings",
  SOLVE_EXERCISE: "SolveExercise",
  // ★ 这两个必须和 src/common/consts.js 的 MSG 表逐字一致。
  //   后台有自己的一份 MSG 表，只往 consts.js 加会导致 `case MSG.X` 求值成
  //   `case undefined`，消息静默落进 default 返回 unknown message。
  SOLVE_EXERCISE_BATCH: "SolveExerciseBatch",
  TEST_WEB: "TestWeb",
  TEST_LLM: "TestLlm",
  TEST_RELAY: "TestRelay",
  POST_TO_FRAMES: "PostToFrames",
  CAPTURE_VISIBLE_TAB: "CaptureVisibleTab",
  GET_PLAYBACK_SPEED: "GetPlaybackSpeed",
  REPORT_LOG: "ReportLog",
  OPEN_OPTIONS: "OpenOptions",
  GET_TAB_ID: "GetCurrentTabId",
  CACHE_STATS: "CacheStats",
  CACHE_EXPORT: "CacheExport",
  CACHE_IMPORT: "CacheImport",
  CACHE_CLEAR: "CacheClear",
};

/**
 * ★ 分享给朋友用之前，只需要改下面这一个常量 ★
 *
 * 把它设成你自己的「答题中转」地址（见 server/README.md，一个单文件 Node 服务，
 * 你把 API Key 放在那边，朋友这边不需要任何 Key），再把 answerSource 默认改成 "relay"：
 *
 *   const DEFAULT_ANSWER_SOURCE = "relay";
 *   const DEFAULT_RELAY_URL = "https://你的中转地址/solve";
 *   const DEFAULT_RELAY_TOKEN = "中转口令";
 *
 * 这三行不用手改 —— 跑 server\打包给同学.ps1，它会自动帮你改好并打包。
 * 这样朋友装完扩展、打开学习通章节页、把「视频助手 / 开启」打开就能用，零配置 —— 和原版体验一致。
 * 留空则表示「只有题库模式」，解题助手不会请求任何外部服务。
 */
const DEFAULT_RELAY_URL = "";
const DEFAULT_RELAY_TOKEN = "";
// ⚠ 这里就是「默认用哪个答题引擎」：
//   "web"  网页版 DeepSeek（免费，用你已登录的 chat.deepseek.com）← 当前你自己的副本用这个
//   "relay" 答题中转（自己架一次，朋友零配置）
//   "bank"  仅本地题库（不联网；pack-neutral 打源码包时会把它改回这个）
//   "llm" / "origin" 需要用户自己配，不适合做默认
const DEFAULT_ANSWER_SOURCE = "web";

/**
 * 默认「题库模式」：零依赖、零配置、零花费。
 *   - 视频助手不需要任何引擎，装完即可用
 *   - 解题助手先查本地题库；命中即秒答，未命中就跳过该题（不会去联网，也不会乱填）
 *
 * 想要更强的解题能力，在设置页把「答案来源」改成下面任意一种：
 *   "relay"  → 你的中转地址（推荐分享；朋友零配置）
 *   "llm"    → 你自己的任意 OpenAI 兼容接口（可填本机 Ollama，完全免费离线）
 *   "origin" → 原插件服务器（需要你在 daxuesoutijiang.com 有权益）
 */
const DEFAULTS = {
  // ⚠ 这三处默认值必须一致：background/index.js、src/options/options.js、
  //   src/content/side-bar.js 的本地 settings。曾经 background 是
  //   enableVideo:false / playbackRate:1，而设置页显示 true/2，
  //   用户以为已经开了、运行时却什么都没做 —— 这是「开了也没用」的一半原因。
  //   （另一处坑见 side-bar.js 的 loadSettings：storage 里没这个键时
  //     不能写 `=== true`，否则默认开启会被吃掉。）
  enableVideo: true,
  enableExam: true,
  // 默认 1 倍速：按用户要求「一直一倍，不要二倍速」。
  // 想变速在侧边栏面板的「倍速」下拉里自己选。
  playbackRate: 1,
  muteVideo: true,
  autoNext: true,
  skipDone: true,
  enableVideoQuiz: true,
  autoWork: true,
  autoSubmitWork: true,
  answerSource: DEFAULT_ANSWER_SOURCE,
  relayUrl: DEFAULT_RELAY_URL,
  relayToken: DEFAULT_RELAY_TOKEN,
  llmBaseUrl: "",
  llmApiKey: "",
  llmModel: "gpt-4o-mini",
  llmTemperature: 0.1,
  llmJsonMode: true,
  llmTimeoutMs: 180000,
  // 网页版 DeepSeek（免费通道）：等它答完的上限。
  // 免费网页版会排队（实测同场测验 35.8s / 超时150s / 12.7s 都有），别设太短。
  webTimeoutMs: 180000,
  useCache: true,
  sourceAppId: "",
  logEnabled: true,
  courseName: "",
};

/* ------------------------------------------------------------ 设置 */

async function getSettings() {
  const keys = Object.keys(DEFAULTS).map((k) => PFX + k);
  const stored = await chrome.storage.local.get(keys);
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = stored[PFX + k];
    out[k] = v === undefined || v === null ? DEFAULTS[k] : v;
  }
  return out;
}

async function setSettings(patch) {
  const o = {};
  for (const k of Object.keys(patch || {})) {
    if (!(k in DEFAULTS)) continue;
    o[PFX + k] = patch[k];
  }
  if (Object.keys(o).length) await chrome.storage.local.set(o);
  return getSettings();
}

/* ------------------------------------------------------- 消息处理 */

async function postToFrames(tabId, message) {
  if (typeof tabId !== "number") return { ok: false, reason: "no_tab" };
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: (m) => {
        try {
          window.postMessage(m, "*");
        } catch (e) {
          /* ignore */
        }
      },
      args: [message],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/**
 * 读取超星播放器自己的倍速 cookie —— 对应逆向出的 background `GetPlaybackSpeed` 分支：
 *   let e = await getAllCk("chaoxing.com"),
 *       t = e.find((e) => "doubleSpeedValue" === e.name);
 *   r({ speed: t });
 * 原插件在面板 onMounted 里用它作为初始倍速（cookie 优先于存储 playBackRate）。
 */
async function getPlaybackSpeed() {
  try {
    const list = await chrome.cookies.getAll({ domain: "chaoxing.com" });
    const hit = (list || []).find((c) => c && c.name === "doubleSpeedValue");
    return { speed: hit || null };
  } catch (e) {
    return { speed: null, errMsg: String((e && e.message) || e) };
  }
}

/**
 * 求解入口。顺序固定为「先查本地题库」：
 *   1. 题库命中  → 直接返回，不发任何网络请求（零成本、零等待）
 *   2. 未命中    → 按 answerSource 请求对应引擎，成功后把答案写回题库
 *   3. 纯题库模式 → 未命中就返回 -100，让内容脚本跳过这一题
 *
 * 题库只在 useCache 打开时读取；写入不受开关影响 ——
 * 这样即使你暂时不想用旧答案，题库也会持续积累。
 */
async function handleSolve(payload, sender) {
  const s = await getSettings();
  const key = cacheKey(payload);

  // ★ 视频弹题（questionFrom === "video"）不入库；带 historyResult 的重试不吃缓存。
  //   超星可能把一次提交直接拒收（DOM 里 #spanNot / #spanNotBackPoint 变 display:block、
  //   而 #videoquiz-submit 还挂着），这时内容脚本会带 historyResult 换答案重试。
  //   如果还去吃题库/缓存，拿到的正是刚刚被平台拒收的那个答案，会原地打转直到轮数用尽。
  const isVideoQuiz = String(payload.questionFrom || "") === "video";
  const retrying = !!String(payload.historyResult || "").trim();

  if (s.useCache !== false && key && !retrying) {
    const hit = await cacheGet(key);
    if (hit && hit.o) {
      return {
        errNo: 0,
        result: {
          option: hit.o,
          isAccurate: 1,
          engine: "cache",
          fromCache: true,
          questionType: payload.questionType,
        },
      };
    }
  }

  let res;
  if (s.answerSource === "origin") {
    res = await solveWithOrigin(payload, s.sourceAppId);
  } else if (s.answerSource === "relay") {
    if (!s.relayUrl) {
      return {
        errNo: -100,
        noEngine: true,
        errMsg: "还没有配置答题中转地址：打开设置页 →「答案解析」→ 填入中转地址，或改用其它来源。",
      };
    }
    res = await solveWithRelay(payload, s.relayUrl, s.relayToken, s.llmTimeoutMs);
  } else if (s.answerSource === "llm") {
    if (!s.llmBaseUrl || !s.llmModel) {
      return {
        errNo: -100,
        noEngine: true,
        errMsg: "还没有配置模型：打开设置页 →「答案解析」→ 填入 API 地址与模型名称（本机 Ollama 有预设按钮）。",
      };
    }
    res = await solveWithLlm(payload, {
      baseUrl: s.llmBaseUrl,
      apiKey: s.llmApiKey,
      model: s.llmModel,
      temperature: s.llmTemperature,
      jsonMode: s.llmJsonMode,
      timeoutMs: s.llmTimeoutMs,
    });
  } else if (s.answerSource === "web") {
    // 网页版 DeepSeek（免费）：开/复用一个 chat.deepseek.com 后台标签页，打题目进去等它答完。
    // 不需要 Key、不花 API 钱；代价是慢一些，且需要你保持登录、别关掉那个标签页。
    res = await solveWithWeb(payload, { timeoutMs: s.webTimeoutMs });
  } else {
    // 纯题库模式（默认）：不请求任何外部服务，未命中就交给内容脚本跳过
    return {
      errNo: -100,
      noEngine: true,
      bankMiss: true,
      errMsg: "题库里没有这道题（当前为「仅题库」模式，不会联网）。可在设置页换用中转/模型，或导入别人的题库。",
    };
  }

  // 视频弹题的答案拿不到「平台是否接受」的确认（超星可能拒收），
  // 写进题库会把错答案永久固化下来，所以只用于本次作答、不入库。
  if (res && res.errNo === 0 && res.result && res.result.option && key && !isVideoQuiz) {
    await cachePut(key, res.result.option, payload.questionType, res.result.engine);
  }
  return res;
}

/**
 * ★ 整页批量求解。
 *
 * 为什么需要：网页版 DeepSeek 对「短时间连续新建会话 + 发消息」极其敏感，
 * 逐题问会被判定「消息发送频繁」直接不答；而且每题都要导航一次页面，又慢又容易被风控。
 * 做法：先逐题查本地题库（命中就一分钱、一次请求都不花），
 *       只把没命中的**合并成一条消息**去问网页版，回来再按位置拆开。
 * 非 web 引擎没有批量通道，直接退回逐题 handleSolve，行为与以前完全一致。
 */
async function handleSolveBatch(payloads, sender) {
  const s = await getSettings();
  const results = new Array(payloads.length).fill(null);
  const missIdx = [];
  const missPayloads = [];

  for (let i = 0; i < payloads.length; i++) {
    const p = payloads[i] || {};
    const key = cacheKey(p);
    if (s.useCache !== false && key) {
      const hit = await cacheGet(key);
      if (hit && hit.o) {
        results[i] = {
          option: hit.o,
          isAccurate: 1,
          engine: "cache",
          fromCache: true,
          questionType: p.questionType,
        };
        continue;
      }
    }
    missIdx.push(i);
    missPayloads.push(p);
  }

  if (!missPayloads.length) return { errNo: 0, results: results };

  if (s.answerSource !== "web") {
    for (let k = 0; k < missPayloads.length; k++) {
      const r = await handleSolve(missPayloads[k], sender);
      if (r && r.errNo === 0 && r.result) results[missIdx[k]] = r.result;
    }
    return { errNo: 0, results: results };
  }

  const r = await solveBatchWithWeb(missPayloads, { timeoutMs: s.webTimeoutMs });
  if (r && r.errNo === 0 && Array.isArray(r.answers)) {
    for (let k = 0; k < missPayloads.length; k++) {
      const opt = r.answers[k];
      if (!opt) continue;
      results[missIdx[k]] = {
        option: opt,
        isAccurate: 1,
        engine: "deepseek-web",
        questionType: missPayloads[k].questionType,
      };
      const key = cacheKey(missPayloads[k]);
      if (key) await cachePut(key, opt, missPayloads[k].questionType, "deepseek-web");
    }
    const got = results.filter(Boolean).length;
    return { errNo: 0, results: results, batch: { asked: missPayloads.length, got: got } };
  }

  // 整批失败：退回逐题，至少不比原来差
  for (let k = 0; k < missPayloads.length; k++) {
    if (results[missIdx[k]]) continue;
    const one = await handleSolve(missPayloads[k], sender);
    if (one && one.errNo === 0 && one.result) results[missIdx[k]] = one.result;
  }
  return { errNo: 0, results: results, errMsg: r && r.errMsg };
}

async function handle(msg, sender) {
  const type = msg && msg.messageType;
  switch (type) {
    case MSG.GET_SETTINGS:
      return await getSettings();

    case MSG.SET_SETTINGS:
      return await setSettings(msg.data);

    case MSG.SOLVE_EXERCISE:
      return await handleSolve(msg.data || {}, sender);

    case MSG.SOLVE_EXERCISE_BATCH: {
      const list = (msg.data && msg.data.payloads) || [];
      if (!Array.isArray(list) || !list.length) return { errNo: -1, errMsg: "空题目列表" };
      return await handleSolveBatch(list, sender);
    }

    case MSG.TEST_LLM: {
      const s = await getSettings();
      return await testLlm({
        baseUrl: (msg.data && msg.data.baseUrl) || s.llmBaseUrl,
        apiKey: (msg.data && msg.data.apiKey) || s.llmApiKey,
        model: (msg.data && msg.data.model) || s.llmModel,
        temperature: 0.1,
        jsonMode: s.llmJsonMode,
        timeoutMs: s.llmTimeoutMs,
      });
    }

    case MSG.TEST_RELAY: {
      const sr = await getSettings();
      return await testRelay({
        relayUrl: (msg.data && msg.data.relayUrl) || sr.relayUrl,
        relayToken: (msg.data && msg.data.relayToken) || sr.relayToken,
        timeoutMs: sr.llmTimeoutMs,
      });
    }

    case MSG.TEST_WEB:
      return await testWeb();

    case MSG.CACHE_STATS:
      return await cacheStats();

    case MSG.CACHE_EXPORT:
      return await cacheExport();

    case MSG.CACHE_IMPORT:
      return await cacheImport(msg.data);

    case MSG.CACHE_CLEAR:
      return await cacheClear();

    case MSG.POST_TO_FRAMES:
      return await postToFrames(sender?.tab?.id, msg.data);

    case MSG.CAPTURE_VISIBLE_TAB: {
      const windowId = sender?.tab?.windowId;
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
          format: "jpeg",
          quality: 70,
        });
        return { dataUrl };
      } catch (e) {
        return { dataUrl: "", errMsg: String((e && e.message) || e) };
      }
    }

    case MSG.GET_PLAYBACK_SPEED:
      return await getPlaybackSpeed();

    case MSG.REPORT_LOG:
      console.log("[DX LOG]", msg.data);
      return { ok: true };

    case MSG.OPEN_OPTIONS:
      await chrome.runtime.openOptionsPage();
      return { ok: true };

    case MSG.GET_TAB_ID:
      return { tabId: sender?.tab?.id ?? -1 };

    default:
      return { errNo: -1, errMsg: "unknown message: " + type };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ errNo: -1, errMsg: String((e && e.message) || e) }));
  return true; // 异步响应
});

/* ------------------------------------------------------------ 安装 */

chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSettings();
  const patch = {};
  for (const k of Object.keys(DEFAULTS)) {
    const cur = await chrome.storage.local.get(PFX + k);
    if (cur[PFX + k] === undefined) patch[PFX + k] = s[k];
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  console.log("[网课助手·复刻版] 已安装/更新");
});
