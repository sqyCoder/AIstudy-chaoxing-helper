/**
 * src/content/cx-course.js — ISOLATED, 顶层 frame。
 * 复刻自逆向结论：原插件 cx.0d72b60b.js 只是一个「课程名记录器」，
 * 在 /mycourse/stu?courseid=... 页面把当前课程名写入
 * courseName / courseList，供解题助手填报courseName 使用。
 */
(function () {
  "use strict";
  var DXU = globalThis.DXU || null;
  var storage =
    DXU && DXU.storage
      ? DXU.storage
      : null;
  if (!storage) return;

  function record() {
    if (location.href.indexOf("/mycourse/stu?") === -1) return;
    var courseIdEl = document.querySelector("#courseid");
    var nameEl = document.querySelector(".nav_side .classDl dd");
    var courseId = courseIdEl ? courseIdEl.value : "";
    var courseName = nameEl ? (nameEl.innerText || "").trim() : "";
    if (!courseName) return;
    storage.set("courseName", courseName).then(function () {
      if (!courseId) return;
      storage.get("courseList").then(function (list) {
        var map = list || {};
        map[String(courseId)] = courseName;
        storage.set("courseList", map);
      });
    });
  }

  record();
  setTimeout(record, 1500);
})();
