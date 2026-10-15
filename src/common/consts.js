/**
 * src/common/consts.js — 经典脚本（非 ESM）。
 * 在 content script 里以第一个 js 条目加载，向全局挂载 `DX`。
 * 内容对应逆向出的 @consts / @common/types/msg-types / 超星任务目录。
 */
(function () {
  "use strict";
  if (globalThis.DX) return;

  /** 存储命名空间（原插件用 college_ai_ 前缀） */
  var STORAGE_PREFIX = "dxrep_";

  /** 存储键 */
  var SK = {
    USER_INFO: "userInfo",
    OPERATE_TYPE: "operateType",
    COURSE_NAME: "courseName",
    COURSE_LIST: "courseList",
    // 视频助手
    ENABLE_VIDEO: "enableVideo",
    PLAYBACK_RATE: "playbackRate",
    MUTE_VIDEO: "muteVideo",
    AUTO_NEXT: "autoNext",
    SKIP_DONE: "skipDone",
    /** 与原插件同名：自动跳转开关的原始表达（"1" 开 / "2" 关），保留以便对照 */
    JUMP_VAL: "jumpVal",
    ENABLE_VIDEO_QUIZ: "enableVideoQuiz",
    // 解题助手
    ENABLE_EXAM: "enableExam",
    AUTO_FILL: "autoWork", // 布尔：true 自动填充 / false 关闭（原插件是 "1"/"2" 字符串，本复刻统一布尔）
    AUTO_SUBMIT: "autoSubmitWork", // 布尔：true 直接提交 / false 仅暂存（原插件是 "auto"/"normal"）
    ANSWER_SOURCE: "answerSource", // "bank" 仅题库(默认) | "relay" 答题中转 | "llm" 大模型 | "origin" 原插件服务器
    // 答题中转（自己架一次，朋友零配置：见 server/answer-relay.mjs）
    RELAY_URL: "relayUrl",
    RELAY_TOKEN: "relayToken",
    // LLM
    LLM_BASE_URL: "llmBaseUrl",
    LLM_API_KEY: "llmApiKey",
    LLM_MODEL: "llmModel",
    LLM_TEMPERATURE: "llmTemperature",
    LLM_JSON_MODE: "llmJsonMode",
    LLM_TIMEOUT_MS: "llmTimeoutMs",
    // 网页版 DeepSeek（免费通道）：等它答完的上限
    WEB_TIMEOUT_MS: "webTimeoutMs",
    // 本地答案题库
    USE_CACHE: "useCache",
    // 面板
    PANEL_POS: "panelPos",
    PANEL_COLLAPSED: "panelCollapsed",
    LOG_ENABLED: "logEnabled",
  };

  /**
   * 与原插件对齐的消息类型（本复刻只用到其中一部分，
   * 值保持一致以便对照逆向结论）。
   */
  var MSG = {
    GET_SETTINGS: "GetSettings",
    SET_SETTINGS: "SetSettings",
    SOLVE_EXERCISE: "SolveExercise",
    // 整页题目一次性批量求解（网页版 DeepSeek 专用：
    // 每题刷新一次会话+发一条消息会被 DeepSeek 判定「消息发送频繁」限流，
    // 整份测验合并成**一条消息**问完才是正解）
    SOLVE_EXERCISE_BATCH: "SolveExerciseBatch",
    SOLVE_VIDEO_QUIZ: "SolveVideoQuiz",
    TEST_LLM: "TestLlm",
    TEST_RELAY: "TestRelay",
    // 网页版 DeepSeek 通道连通性自检（本复刻净增）
    TEST_WEB: "TestWeb",
    POST_TO_FRAMES: "PostToFrames",
    LOG: "ReportLog",
    FETCH_ORIGIN: "FetchOrigin",
    GET_TAB_ID: "GetCurrentTabId",
    PANEL_STATE: "PanelState",
    // 对应逆向出的 CommonMsgEventType.GetPlaybackSpeed（读超星 doubleSpeedValue cookie）
    GET_PLAYBACK_SPEED: "GetPlaybackSpeed",
    // 本地答案题库（本复刻净增能力，原插件每题都发服务器）
    CACHE_STATS: "CacheStats",
    CACHE_EXPORT: "CacheExport",
    CACHE_IMPORT: "CacheImport",
    CACHE_CLEAR: "CacheClear",
  };

  /** MAIN world 适配器 <-> ISOLATED content script 的 postMessage 协议 */
  var BRIDGE = {
    // task-scan.js -> side-bar.js
    CX_TYPES: "cxTypes",
    // side-bar.js -> ueditor.js（经 background 广播到所有 frame 的 MAIN world）
    SET_EDITOR_CONTENT: "brushCxUeditorSetContent",
    // side-bar.js -> video-rate.js（可选，运行时校准）
    SET_RATE: "dxSetPlaybackRate",
  };

  /** 超星任务目录：rawType(来自 /ananas/modules/<x>/) -> 平台任务类型 */
  var CX_TASK_CATALOG = {
    video: { helper: "video", rawTypes: ["video"] },
    audio: { helper: "video", rawTypes: ["audio"] },
    pdf: { helper: "video", rawTypes: ["pdf"] },
    work: { helper: "exam", rawTypes: ["work"] },
    text: { helper: "video", rawTypes: [] },
  };

  var RAW_TYPES = [
    "video", "audio", "pdf", "work", "live", "innerbook", "insertbbs",
    "downloadfile", "questionnaire", "flash", "zt", "ballchart",
  ];

  var NOT_SUPPORT_TYPE = [
    "innerbook", "insertbbs", "live", "downloadfile",
    "questionnaire", "zt", "flash", "ballchart",
  ];

  var BRUSH_STATUS = {
    START: "start",
    PROCESSING: "processing",
    DONE: "done",
    STOP: "stop",
    COMPLETE: "complete",
  };

  /** 题目类型码（来自超星隐藏 input#answertype 的 value） */
  var QUESTION_TYPE_MAP = {
    0: "单选题",
    1: "多选题",
    2: "填空题",
    3: "判断题",
    4: "简答题",
    5: "名词解释",
    6: "论述题",
    7: "计算题",
    8: "其他题",
    9: "分录题",
    10: "资料题",
    11: "连线题",
    14: "完形填空",
    15: "阅读理解",
  };

  var CHOICE_TYPES = ["单选题", "多选题", "判断题"];
  var BLANK_TYPES = ["填空题", "分录题", "资料题"];
  var TEXT_TYPES = ["简答题", "名词解释", "论述题", "计算题", "其他题"];

  globalThis.DX = {
    STORAGE_PREFIX: STORAGE_PREFIX,
    SK: SK,
    MSG: MSG,
    BRIDGE: BRIDGE,
    CX_TASK_CATALOG: CX_TASK_CATALOG,
    RAW_TYPES: RAW_TYPES,
    NOT_SUPPORT_TYPE: NOT_SUPPORT_TYPE,
    BRUSH_STATUS: BRUSH_STATUS,
    QUESTION_TYPE_MAP: QUESTION_TYPE_MAP,
    CHOICE_TYPES: CHOICE_TYPES,
    BLANK_TYPES: BLANK_TYPES,
    TEXT_TYPES: TEXT_TYPES,

    isCxTaskType: function (t) {
      return Object.prototype.hasOwnProperty.call(CX_TASK_CATALOG, t);
    },
    getCxTaskMeta: function (t) {
      return globalThis.DX.isCxTaskType(t) ? CX_TASK_CATALOG[t] : undefined;
    },
    /** 从 iframe src 提取 /ananas/modules/<name> */
    extractCxRawTaskType: function (src) {
      if (!src) return "";
      var path = src;
      try {
        path = new URL(src, location.href).pathname;
      } catch (e) {
        /* keep raw */
      }
      var m = path.match(/\/ananas\/modules\/([^/?#]+)/);
      if (m) return m[1].toLowerCase();
      if (path.indexOf("/ananas/dialog/ballchart") !== -1) return "ballchart";
      return "";
    },
    resolveCxTaskType: function (raw) {
      if (!raw) return undefined;
      var keys = Object.keys(CX_TASK_CATALOG);
      for (var i = 0; i < keys.length; i++) {
        if (CX_TASK_CATALOG[keys[i]].rawTypes.indexOf(raw) !== -1) return keys[i];
      }
      return undefined;
    },
    questionTypeName: function (code) {
      return QUESTION_TYPE_MAP[parseInt(code, 10)];
    },

    /**
     * 任务归一化（复刻逆向出的 adapter/checkRouteAdapter.normalizeTasks）。
     * 过滤出 source 为 iframe/blockquote 且 id 为字符串、order 为数字的条目，
     * 从 src 推出 rawType 再映射到平台任务类型；
     * 结果为空时退化为单个 synthetic 的 text 任务（对应原实现 `r.length ? r : [i()]`）。
     */
    normalizeCxTasks: function (rawTasks, routeHref) {
      var list = Array.isArray(rawTasks) ? rawTasks : [];
      var out = list
        .filter(function (t) {
          return (
            !!t &&
            typeof t.id === "string" &&
            (t.source === "iframe" || t.source === "blockquote") &&
            typeof t.order === "number"
          );
        })
        .map(function (t) {
          var raw = globalThis.DX.extractCxRawTaskType(t.src) || (t.source === "blockquote" ? "work" : "");
          var type = globalThis.DX.resolveCxTaskType(raw) || raw || "unknown";
          var copy = {};
          for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) copy[k] = t[k];
          copy.type = type;
          copy.rawType = raw || undefined;
          return copy;
        });
      if (out.length) return out;
      var href = routeHref || (typeof location !== "undefined" ? location.href : "");
      return [{ id: "text-" + (href || "unknown"), type: "text", source: "page", order: 0, src: href }];
    },

    /** 队列指纹（id:type 用 | 连接），用于判断是否需要重建队列 */
    fingerprintCxTasks: function (tasks) {
      return (tasks || [])
        .map(function (t) {
          return t.id + ":" + t.type;
        })
        .join("|");
    },
  };
})();
