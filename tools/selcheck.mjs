#!/usr/bin/env node
/**
 * selcheck.mjs —— 交付物保真审计：把自建 JS 里的 DOM 选择器逐个回原 bundle 验证。
 *
 * 用法：
 *   node selcheck.mjs <myFile> <originalBundleOrDir> [--all]
 *
 * 第二个参数可以是**单个文件**，也可以是**目录**（推荐把整个原始扩展解包目录传进来）。
 * 原插件是按模块拆成几十个文件的，只查一个文件会误报 —— 例如 #courseid 在
 * cx.0d72b60b.js 而不是 SideBar.*.js 里。
 *
 * 扫描 myFile 中所有
 *   querySelector("...") / querySelectorAll("...")
 *   getElementById("...") / getElementsByClassName("...") / closest("...") / matches("...")
 * 的字符串字面量，为每个选择器派生出若干「关键 token」，逐个在语料里查找。
 * 一个都没命中的选择器会被标为 MISS（疑似臆造），并给出其在 myFile 中的行号。
 *
 * --all 也会打印命中项。
 */
import fs from "node:fs";
import path from "node:path";

const [, , myPath, origPath, ...rest] = process.argv;
const showAll = rest.includes("--all");
if (!myPath || !origPath) {
  console.error("usage: selcheck.mjs <myFile> <originalBundleOrDir> [--all]");
  process.exit(2);
}

const src = fs.readFileSync(myPath, "utf8");

/** 语料：单文件直接用；目录则把所有 .js/.mjs 拼起来（原插件按模块拆文件，必须全查） */
function readCorpus(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return { text: fs.readFileSync(p, "utf8"), files: 1, label: p };
  let text = "";
  let files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (/\.(js|mjs|cjs)$/i.test(e.name)) {
        text += "\n/*FILE:" + fp + "*/\n" + fs.readFileSync(fp, "utf8");
        files++;
      }
    }
  };
  walk(p);
  return { text, files, label: p + " (" + files + " 个 js)" };
}
const corpus = readCorpus(origPath);
const orig = corpus.text;

/** 收集 { selector, kind, line } */
const found = new Map(); // key = kind + "\u0000" + selector

function lineOf(idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

function add(kind, sel, idx) {
  if (!sel || typeof sel !== "string") return;
  // 跳过明显非选择器的字符串（含空格拼接、模板占位等留给 tokens 处理）
  const key = kind + "\u0000" + sel;
  if (!found.has(key)) found.set(key, { kind, sel, line: lineOf(idx) });
}

const callRe =
  /(?:querySelectorAll|querySelector|getElementById|getElementsByClassName|closest|matches)\s*\(\s*("(?:[^"\\]|\\.)*")/g;
let m;
while ((m = callRe.exec(src))) {
  const kind = m[0].slice(0, m[0].indexOf("(")).trim();
  let raw;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    continue;
  }
  add(kind, raw, m.index);
}

/** 由选择器派生要回查的 token 列表 */
function tokensFor(sel) {
  const out = new Set();
  const push = (s) => {
    const t = (s || "").trim();
    if (t) out.add(t);
  };
  push(sel);
  // .class / #id / [attr] / tag
  for (const part of sel.match(/\.[A-Za-z0-9_-]+/g) || []) push(part);
  for (const part of sel.match(/#[A-Za-z0-9_-]+/g) || []) push(part);
  for (const part of sel.match(/\[[^\]]+\]/g) || []) push(part);
  // 形如 ".a .b" 里的每一段
  for (const part of sel.split(/[\s>+~]+/)) push(part);
  // 去掉转义引号等
  return [...out].filter((t) => t.length >= 2);
}

const hits = [];
const misses = [];
for (const { kind, sel, line } of found.values()) {
  const toks = tokensFor(sel);
  const matched = toks.filter((t) => orig.includes(t));
  const rec = { kind, sel, line, toks, matched };
  if (matched.length) hits.push(rec);
  else misses.push(rec);
}

misses.sort((a, b) => a.line - b.line);
hits.sort((a, b) => a.line - b.line);

console.log(`### ${myPath}`);
console.log(`### 语料: ${corpus.label}  (${(orig.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`### 选择器总数 ${found.size}  命中 ${hits.length}  未命中 ${misses.length}`);
console.log("");

if (misses.length) {
  console.log(`================ 未命中（疑似臆造，需人工确认） ================`);
  for (const r of misses) {
    console.log(`L${r.line}  ${r.kind}("${r.sel}")`);
  }
  console.log("");
}

if (showAll) {
  console.log(`================ 命中 ================`);
  for (const r of hits) {
    console.log(`L${r.line}  ${r.kind}("${r.sel}")  <- ${r.matched.slice(0, 4).join(" , ")}`);
  }
}
