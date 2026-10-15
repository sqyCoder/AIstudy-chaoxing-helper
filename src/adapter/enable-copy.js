/**
 * src/adapter/enable-copy.js — MAIN world, document_end, all_frames。
 *
 * 复刻自逆向结论：原插件 enableCopy.b42c53bc.js 在超星作业/考试页
 * 注入 <style> 强制 user-select:text，并把 document 以及每个元素的
 * oncontextmenu / onselectstart / ondragstart / onmousedown 处理器置空，
 * 以解除「禁止复制粘贴」限制（答案填充大量依赖 textarea / UEditor 输入）。
 */
(function () {
  "use strict";

  var MARK = "__dxEnableCopyInstalled";
  if (window[MARK]) return;
  window[MARK] = true;

  var HANDLERS = ["oncontextmenu", "onselectstart", "ondragstart", "onmousedown", "oncopy", "oncut", "onpaste"];

  function neutralize(el) {
    if (!el) return;
    try {
      el.style && (el.style.userSelect = "text");
      el.style && (el.style.webkitUserSelect = "text");
    } catch (e) {
      /* ignore */
    }
    HANDLERS.forEach(function (h) {
      try {
        el[h] = null;
      } catch (e) {
        /* ignore */
      }
    });
  }

  function injectStyle() {
    if (document.getElementById("__dx-enable-copy")) return;
    var st = document.createElement("style");
    st.id = "__dx-enable-copy";
    st.textContent =
      "*{ -webkit-user-select:text !important; -moz-user-select:text !important; user-select:text !important; }";
    (document.head || document.documentElement).appendChild(st);
  }

  function run() {
    injectStyle();
    neutralize(document);
    neutralize(document.body);
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) neutralize(all[i]);
  }

  run();
  // 局部刷新的题目区域也要覆盖
  try {
    new MutationObserver(function () {
      run();
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {
    /* ignore */
  }
})();
