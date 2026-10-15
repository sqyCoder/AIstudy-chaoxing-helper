/**
 * src/options/options.js — 设置页。
 * 与 background 用 {messageType: ...} 通信（见 DX.MSG）。
 *
 * 引擎默认指向本机 Ollama（零花费）；题库相关操作全部经 background 单点写，
 * 避免设置页与 service worker 同时改同一个存储键导致丢更新。
 */
(function () {
  "use strict";

  var DX = globalThis.DX || {};
  var MSG = DX.MSG || {
    GET_SETTINGS: "GetSettings",
    SET_SETTINGS: "SetSettings",
    TEST_LLM: "TestLlm",
    TEST_RELAY: "TestRelay",
  };

  // ⚠ 这份 DEFAULTS 必须与 src/background/index.js 的 DEFAULTS 保持一致
  //   （同一个键不能一边 true 一边 false，否则设置页显示的和运行时读的不一样）。
  var DEFAULTS = {
    enableVideo: true,
    enableExam: true,
    // 默认 1 倍速（用户要求「一直一倍，不要二倍速」）；要变速在面板里自己选
    playbackRate: 1,
    muteVideo: true,
    autoNext: true,
    skipDone: true,
    enableVideoQuiz: true,
    autoWork: true,
    autoSubmitWork: true,
    // bank 仅题库 | relay 答题中转 | web 网页版DeepSeek(免费) | llm 大模型 | origin 原服务器
    // ⚠ 必须和 src/background/index.js 的 DEFAULT_ANSWER_SOURCE 一致
    answerSource: "web",
    relayUrl: "",
    relayToken: "",
    llmBaseUrl: "",
    llmApiKey: "",
    llmModel: "gpt-4o-mini",
    llmTemperature: 0.1,
    llmJsonMode: true,
    llmTimeoutMs: 180000,
    webTimeoutMs: 120000,
    useCache: true,
    sourceAppId: "",
    logEnabled: true,
  };

  /** 复选框控件 id */
  var CHECKBOXES = [
    "enableVideo",
    "muteVideo",
    "autoNext",
    "skipDone",
    "enableVideoQuiz",
    "enableExam",
    "autoWork",
    "autoSubmitWork",
    "llmJsonMode",
    "useCache",
    "logEnabled",
  ];
  /** 文本/数字/下拉控件 id */
  var INPUTS = [
    "playbackRate",
    "answerSource",
    "relayUrl",
    "relayToken",
    "llmBaseUrl",
    "llmApiKey",
    "llmModel",
    "llmTemperature",
    "llmTimeoutMs",
    "webTimeoutMs",
    "sourceAppId",
  ];
  /** 需要按数字读入的控件 */
  var NUMERIC = ["playbackRate", "llmTemperature", "llmTimeoutMs", "webTimeoutMs"];

  /** 本机 Ollama 预设（完全免费） */
  var PRESETS = {
    presetOllama: { llmBaseUrl: "http://127.0.0.1:11434/v1", llmApiKey: "ollama", llmModel: "qwen2.5:7b" },
    presetOllamaVl: { llmBaseUrl: "http://127.0.0.1:11434/v1", llmApiKey: "ollama", llmModel: "qwen2.5vl:7b" },
  };

  function $(id) {
    return document.getElementById(id);
  }

  function bgSend(messageType, data) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ messageType: messageType, data: data }, function (res) {
          if (chrome.runtime.lastError) {
            resolve({ errNo: -1, errMsg: chrome.runtime.lastError.message });
            return;
          }
          resolve(res);
        });
      } catch (e) {
        resolve({ errNo: -1, errMsg: String((e && e.message) || e) });
      }
    });
  }

  function fillForm(s) {
    CHECKBOXES.forEach(function (id) {
      var el = $(id);
      if (el) el.checked = !!s[id];
    });
    INPUTS.forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.value = s[id] === undefined || s[id] === null ? "" : String(s[id]);
    });
    syncVisibility();
  }

  function readForm() {
    var out = {};
    CHECKBOXES.forEach(function (id) {
      var el = $(id);
      if (el) out[id] = el.checked;
    });
    INPUTS.forEach(function (id) {
      var el = $(id);
      if (!el) return;
      if (NUMERIC.indexOf(id) !== -1) {
        var n = Number(el.value);
        out[id] = Number.isFinite(n) && n > 0 ? n : DEFAULTS[id];
      } else {
        out[id] = el.value.trim();
      }
    });
    return out;
  }

  function syncVisibility() {
    var src = ($("answerSource") || {}).value;
    var llmBox = $("llmBox");
    var originBox = $("originBox");
    var relayBox = $("relayBox");
    var bankBox = $("bankBox");
    var webBox = $("webBox");
    if (llmBox) llmBox.hidden = src !== "llm";
    if (originBox) originBox.hidden = src !== "origin";
    if (relayBox) relayBox.hidden = src !== "relay";
    if (bankBox) bankBox.hidden = src !== "bank";
    if (webBox) webBox.hidden = src !== "web";
  }

  function flash(el, text, isErr) {
    if (!el) return;
    el.textContent = text;
    el.className = "result" + (isErr ? " err" : "");
    setTimeout(function () {
      if (el.textContent === text) el.textContent = "";
    }, 6000);
  }

  /* ------------------------------------------------- 题库 */

  function fmtTime(ts) {
    if (!ts) return "—";
    try {
      var d = new Date(ts);
      return (
        d.getFullYear() +
        "-" +
        String(d.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(d.getDate()).padStart(2, "0") +
        " " +
        String(d.getHours()).padStart(2, "0") +
        ":" +
        String(d.getMinutes()).padStart(2, "0")
      );
    } catch (e) {
      return "—";
    }
  }

  async function refreshBankStats() {
    var box = $("bankStats");
    if (!box) return;
    var s = await bgSend(MSG.CACHE_STATS);
    if (!s || s.errNo === -1 || typeof s.count !== "number") {
      box.textContent = "统计读取失败：" + ((s && s.errMsg) || "未知错误");
      return;
    }
    var engines = Object.keys(s.byEngine || {})
      .map(function (k) {
        return k + " " + s.byEngine[k];
      })
      .join(" · ");
    box.textContent =
      "题库 " +
      s.count +
      " 条｜命中 " +
      s.hits +
      " 次 / 未命中 " +
      s.miss +
      " 次（命中率 " +
      (s.rate * 100).toFixed(1) +
      "%）｜因缓存省下 " +
      s.reused +
      " 次引擎调用｜最后使用 " +
      fmtTime(s.lastAt) +
      (engines ? "｜来源：" + engines : "");
  }

  function downloadJson(obj, filename) {
    var text = JSON.stringify(obj, null, 1);
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
    return text.length;
  }

  function stamp() {
    var d = new Date();
    return (
      d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0") +
      "-" +
      String(d.getHours()).padStart(2, "0") +
      String(d.getMinutes()).padStart(2, "0")
    );
  }

  function wireBank() {
    var btnRefresh = $("btnBankRefresh");
    if (btnRefresh) btnRefresh.addEventListener("click", refreshBankStats);

    var btnExport = $("btnBankExport");
    if (btnExport)
      btnExport.addEventListener("click", async function () {
        var r = await bgSend(MSG.CACHE_EXPORT);
        if (!r || !r.entries) {
          flash($("bankResult"), "导出失败：" + ((r && r.errMsg) || "未知错误"), true);
          return;
        }
        var n = Object.keys(r.entries).length;
        if (!n) {
          flash($("bankResult"), "题库是空的，没什么可导出", true);
          return;
        }
        downloadJson(r, "网课助手题库-" + stamp() + ".json");
        flash($("bankResult"), "已导出 " + n + " 条 ✓", false);
      });

    var fileEl = $("bankFile");
    var btnImport = $("btnBankImport");
    if (btnImport && fileEl)
      btnImport.addEventListener("click", function () {
        fileEl.value = "";
        fileEl.click();
      });

    if (fileEl)
      fileEl.addEventListener("change", function () {
        var f = fileEl.files && fileEl.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = async function () {
          var data = null;
          try {
            data = JSON.parse(String(reader.result));
          } catch (e) {
            flash($("bankResult"), "导入失败：文件不是合法 JSON", true);
            return;
          }
          var r = await bgSend(MSG.CACHE_IMPORT, data);
          if (!r || r.errMsg) {
            flash($("bankResult"), "导入失败：" + ((r && r.errMsg) || "未知错误"), true);
            return;
          }
          flash(
            $("bankResult"),
            "新增 " + r.added + " 条，更新 " + r.updated + " 条，现共 " + r.total + " 条 ✓",
            false
          );
          refreshBankStats();
        };
        reader.onerror = function () {
          flash($("bankResult"), "导入失败：读取文件出错", true);
        };
        reader.readAsText(f);
      });

    var btnClear = $("btnBankClear");
    if (btnClear)
      btnClear.addEventListener("click", async function () {
        if (!confirm("确定清空本地题库？该操作不可撤销（建议先导出备份）。")) return;
        var r = await bgSend(MSG.CACHE_CLEAR);
        if (!r || !r.ok) {
          flash($("bankResult"), "清空失败：" + ((r && r.errMsg) || "未知错误"), true);
          return;
        }
        flash($("bankResult"), "题库已清空 ✓", false);
        refreshBankStats();
      });
  }

  /* ------------------------------------------------- 初始化 */

  async function init() {
    var s = await bgSend(MSG.GET_SETTINGS);
    if (!s || typeof s !== "object" || s.errNo === -1) {
      fillForm(DEFAULTS);
    } else {
      fillForm(Object.assign({}, DEFAULTS, s));
    }

    var srcEl = $("answerSource");
    if (srcEl) srcEl.addEventListener("change", syncVisibility);

    /* 引擎预设：填好并直接保存，一键可用 */
    Object.keys(PRESETS).forEach(function (id) {
      var btn = $(id);
      if (!btn) return;
      btn.addEventListener("click", async function () {
        var p = PRESETS[id];
        fillForm(Object.assign(readForm(), p));
        var r = await bgSend(MSG.SET_SETTINGS, readForm());
        if (r && r.errNo === -1) {
          flash($("testResult"), "预设保存失败：" + (r.errMsg || ""), true);
          return;
        }
        flash($("testResult"), "已填入 " + p.llmModel + "，可直接点「测试连接」", false);
      });
    });

    var btnSave = $("btnSave");
    if (btnSave)
      btnSave.addEventListener("click", async function () {
        var patch = readForm();
        var r = await bgSend(MSG.SET_SETTINGS, patch);
        if (r && r.errNo === -1) flash($("saveResult"), "保存失败：" + (r.errMsg || ""), true);
        else flash($("saveResult"), "已保存 ✓", false);
      });

    var btnReset = $("btnReset");
    if (btnReset)
      btnReset.addEventListener("click", async function () {
        fillForm(DEFAULTS);
        await bgSend(MSG.SET_SETTINGS, DEFAULTS);
        flash($("saveResult"), "已恢复默认 ✓", false);
      });

    var btnTest = $("btnTest");
    if (btnTest)
      btnTest.addEventListener("click", async function () {
        var cur = readForm();
        var el = $("testResult");
        if (el) {
          el.textContent = "测试中…（本机模型第一次可能要十几秒）";
          el.className = "result";
        }
        var r = await bgSend(MSG.TEST_LLM, {
          baseUrl: cur.llmBaseUrl,
          apiKey: cur.llmApiKey,
          model: cur.llmModel,
          timeoutMs: cur.llmTimeoutMs,
        });
        if (r && r.errNo === 0) {
          flash(el, "连接成功 ✓ 模型回答：" + (r.result && r.result.option), false);
        } else {
          flash(el, "失败：" + ((r && r.errMsg) || "未知错误"), true);
        }
      });

    var btnTestRelay = $("btnTestRelay");
    if (btnTestRelay)
      btnTestRelay.addEventListener("click", async function () {
        var cur = readForm();
        var el = $("testRelayResult");
        if (el) {
          el.textContent = "测试中…";
          el.className = "result";
        }
        var r = await bgSend(MSG.TEST_RELAY, {
          relayUrl: cur.relayUrl,
          relayToken: cur.relayToken,
          timeoutMs: cur.llmTimeoutMs,
        });
        if (r && r.errNo === 0) {
          flash(el, "中转可用 ✓ " + ((r.result && r.result.note) || ""), false);
        } else {
          flash(el, "失败：" + ((r && r.errMsg) || "未知错误"), true);
        }
      });

    // 网页版 DeepSeek：只做连通性自检（会后台开/复用一个 chat.deepseek.com 标签页）
    var btnTestWeb = $("btnTestWeb");
    if (btnTestWeb)
      btnTestWeb.addEventListener("click", async function () {
        var el = $("testWebResult");
        if (el) {
          el.textContent = "检查中…";
          el.className = "result";
        }
        var r = await bgSend(MSG.TEST_WEB, {});
        if (r && r.ok) {
          flash(el, "可用 ✓ " + (r.info || ""), false);
        } else {
          flash(el, "失败：" + ((r && r.errMsg) || "未知错误"), true);
        }
      });

    wireBank();
    refreshBankStats();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
