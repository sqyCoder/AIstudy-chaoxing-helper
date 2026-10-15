/**
 * src/popup/popup.js — 工具栏弹窗：总开关 + 关键设置 + 当前页状态。
 */
(function () {
  "use strict";

  var DX = globalThis.DX || {};
  var MSG = DX.MSG || { GET_SETTINGS: "GetSettings", SET_SETTINGS: "SetSettings" };

  var KEYS = [
    "enableVideo",
    "enableExam",
    "playbackRate",
    "answerSource",
    "autoSubmitWork",
  ];

  function $(id) {
    return document.getElementById(id);
  }

  function bg(messageType, data) {
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

  function isChaoxingUrl(u) {
    return typeof u === "string" && /(^|\.)(chaoxing\.com|xuexitong\.com)\//.test(u);
  }

  async function refreshStatus() {
    var el = $("status");
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      var tab = tabs && tabs[0];
      if (!tab) {
        el.textContent = "没有活动标签页。";
        return;
      }
      if (!isChaoxingUrl(tab.url || "")) {
        el.textContent = "当前页面不是超星学习通，请先打开课程章节页。";
        return;
      }
      var r = await chrome.tabs.sendMessage(tab.id, { messageType: "PanelState" }).catch(function () {
        return null;
      });
      if (r && r.found) {
        el.textContent =
          "面板已就绪｜" +
          (r.status || "待机中") +
          "｜队列 " +
          (r.queueLength || 0) +
          " 项，当前第 " +
          ((r.currentIndex || 0) + 1) +
          " 项";
      } else {
        el.textContent = "页面已加载但面板未就绪，按 F5 刷新页面后重试。";
      }
    } catch (e) {
      el.textContent = "读取状态失败：" + String((e && e.message) || e);
    }
  }

  async function init() {
    var s = await bg(MSG.GET_SETTINGS);
    if (!s || s.errNo === -1) s = {};

    KEYS.forEach(function (k) {
      var el = $(k);
      if (!el) return;
      if (el.type === "checkbox") el.checked = !!s[k];
      else el.value = String(s[k] === undefined || s[k] === null ? "" : s[k]);
    });

    KEYS.forEach(function (k) {
      var el = $(k);
      if (!el) return;
      el.addEventListener("change", async function () {
        var patch = {};
        if (el.type === "checkbox") patch[k] = el.checked;
        else if (k === "playbackRate") patch[k] = parseFloat(el.value) || 1;
        else patch[k] = el.value;
        await bg(MSG.SET_SETTINGS, patch);
        var r = await bg(MSG.GET_SETTINGS);
        el.setAttribute("data-ok", r ? "1" : "0");
      });
    });

    var b1 = $("btnOptions");
    if (b1)
      b1.addEventListener("click", function () {
        chrome.runtime.openOptionsPage();
        window.close();
      });

    var b2 = $("btnReload");
    if (b2)
      b2.addEventListener("click", async function () {
        var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs && tabs[0]) chrome.tabs.reload(tabs[0].id);
        window.close();
      });

    refreshStatus();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
