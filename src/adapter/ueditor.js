/**
 * src/adapter/ueditor.js — MAIN world, document_end, all_frames。
 *
 * 复刻自逆向结论：原插件 cxExam.4968e635.js 在超星作业/考试页监听
 * {type:"brushCxUeditorSetContent", data:{name, content}}，然后：
 *   UE.getEditor(name, {...}) -> setContent("<p>"+content+"</p>") -> focus()
 *   -> 找到 #name 的三层父节点下的 .savebtndiv .saveButtonClass -> 去 href -> click()
 * 本复刻保留该路径，并补充 TinyMCE 与纯 textarea 兜底。
 */
(function () {
  "use strict";

  var MARK = "__dxUeditorAdapterInstalled";
  if (window[MARK]) return;
  window[MARK] = true;

  var MSG_TYPE = "brushCxUeditorSetContent";

  function focusEditor(editor) {
    try {
      editor.focus();
    } catch (e) {
      /* ignore */
    }
  }

  function saveViaUEditor(name, content) {
    if (!window.UE || typeof window.UE.getEditor !== "function") return false;
    try {
      var ed = window.UE.getEditor(name, {
        initialFrameHeight: 56,
        toolbars: [],
        pasteplain: true,
        disablePasteImage: true,
        disableDraggable: true,
        autoClearinitialContent: false,
        focus: true,
      });
      if (!ed) return false;
      ed.setContent("<p>" + content + "</p>");
      focusEditor(ed);
      return true;
    } catch (e) {
      return false;
    }
  }

  function saveViaTinyMce(content) {
    try {
      var ed = window.tinymce && window.tinymce.activeEditor;
      if (!ed) return false;
      ed.setContent(content);
      ed.fire("change");
      ed.fire("input");
      ed.fire("save");
      return true;
    } catch (e) {
      return false;
    }
  }

  function saveViaTextarea(name, content) {
    var ta = document.querySelector('textarea[name="' + name + '"]') ||
             document.querySelector('textarea[id="' + name + '"]');
    if (!ta) return false;
    ta.value = content;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  /** 写完答案后，自动点一次该题的「保存」按钮（超星要求逐题保存） */
  function clickSaveButton(name) {
    try {
      var host = document.getElementById(name);
      var wrap = host && host.parentElement && host.parentElement.parentElement &&
                 host.parentElement.parentElement.parentElement;
      var container = wrap || document;
      var btn = container.querySelector(".savebtndiv .saveButtonClass") ||
                document.querySelector(".savebtndiv .saveButtonClass");
      if (!btn) return false;
      btn.removeAttribute("href");
      btn.click();
      return true;
    } catch (e) {
      return false;
    }
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.type !== MSG_TYPE) return;
    var payload = d.data || {};
    var name = payload.name;
    var content = payload.content == null ? "" : String(payload.content);
    if (!name) return;

    var ok = saveViaUEditor(name, content);
    if (!ok) ok = saveViaTinyMce(content);
    if (!ok) ok = saveViaTextarea(name, content);

    // 部分题型（含 .savebtndiv）在 setContent 后需要手动点保存
    if (ok) {
      setTimeout(function () {
        clickSaveButton(name);
      }, 200);
    }
  });
})();
