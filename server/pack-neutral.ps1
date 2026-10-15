# =====================================================================
#  打中性包 —— 源码发布版（不含任何你的私有东西）
#
#  用法（在 server 目录里）：
#     powershell -ExecutionPolicy Bypass -File pack-neutral.ps1
#     powershell -ExecutionPolicy Bypass -File pack-neutral.ps1 -OutName "xx.zip"
#
#  和「打包给同学」的区别：
#     「打包给同学」= 把你的中转地址口令烘进去，对方零配置（给别人用）
#     「中性包」    = 干净的源码，默认仅本地题库，谁装上都能自己配（存档/发布用）
#
#  它会：
#     1. 复制源码到临时目录，**排除 tools/**（开发工具，不属于交付物）
#     2. **排除 relay-config.json**（你的 API Key）与 answer-bank.json（你的题库数据）
#     3. 语法自检 + 跑两套自测（干净源码模式，不是打包模式）
#     4. 密钥泄漏扫描
#     5. 打出 zip
# =====================================================================

param(
  [string]$OutName
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM，JS 文件不要 BOM，统一用 .NET 显式控制
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$ServerDir = $PSScriptRoot
$Root      = Split-Path $ServerDir -Parent          # dxstj-chaoxing\
$Deliver   = Split-Path $Root -Parent               # deliverable\
$Work      = Join-Path (Split-Path $Deliver -Parent) 'work'
$Stage     = Join-Path $Work 'pack-neutral\dxstj-chaoxing'

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Ok($t)   { Write-Host "  [OK]   $t" -ForegroundColor Green }
# 非交互模式下 Read-Host 会抛异常（脚本被重定向或自动化调用时），吞掉即可
function Pause($m) { try { $null = Read-Host $m } catch { } }
function Die($t)  { Write-Host "  [失败] $t" -ForegroundColor Red; Write-Host ''; Pause '按回车关闭'; exit 1 }

Say ''
Say '=====================================================================' Cyan
Say '   打中性包 - 干净源码发布版' Cyan
Say '=====================================================================' Cyan
Say ''

# ---------- 1. 复制源码（排除私有文件） ----------
Say '[1/5] 复制源码到临时目录...'
$stageRoot = Split-Path $Stage -Parent
Remove-Item $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

# robocopy 的 /XF 按文件名排除，/XD 按目录名排除（tools = 开发工具）
robocopy $Root $Stage /E /XD tools /XF relay-config.json answer-bank.json /NFL /NDL /NJH /NJS /NP | Out-Null
$n = (Get-ChildItem -Recurse -File $Stage).Count
if ($n -lt 10) { Die "复制出来的文件太少（$n 个），检查 robocopy 是否失败。" }
Ok "已复制 $n 个文件（已排除 tools/、relay-config.json、answer-bank.json）"

# 保险：万一 robocopy 的 /XF 没生效，再扫一遍删掉
foreach ($bad in @('relay-config.json', 'answer-bank.json')) {
  Get-ChildItem -Recurse -File $Stage -Filter $bad -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Force; Say "   已删除私有文件：$bad" DarkGray }
}

# ---------- 2. 必须是「干净源码」状态 ----------
Say ''
Say '[2/5] 校验副本是干净源码状态...'
$bg  = Join-Path $Stage 'src\background\index.js'
$opt = Join-Path $Stage 'src\options\options.js'
if (-not (Test-Path $bg))  { Die "找不到 $bg" }
if (-not (Test-Path $opt)) { Die "找不到 $opt" }

$src  = [System.IO.File]::ReadAllText($bg, $Utf8NoBom)
$osrc = [System.IO.File]::ReadAllText($opt, $Utf8NoBom)

# 中性包必须「谁装上都不会立刻报错」⇒ 默认来源一律改回 bank（纯题库、零依赖、不联网）。
# 工作副本允许被改成 web（网页版 DeepSeek 免费通道）等，所以这里是**改写**而不是报错。
$neutralSrc = 'const DEFAULT_ANSWER_SOURCE = "web";'
if ($src.IndexOf($neutralSrc) -ge 0) {
  $src = $src.Replace($neutralSrc, 'const DEFAULT_ANSWER_SOURCE = "bank";')
  [System.IO.File]::WriteAllText($bg, $src, $Utf8NoBom)
  Ok '默认来源已由 web 改回 bank（中性包不带任何联网依赖）'
}
if ($osrc.IndexOf('answerSource: "web",') -ge 0) {
  $osrc = $osrc.Replace('answerSource: "web",', 'answerSource: "bank",')
  [System.IO.File]::WriteAllText($opt, $osrc, $Utf8NoBom)
  Ok '设置页 DEFAULTS 已同步改回 bank'
}

if ($src.IndexOf('const DEFAULT_ANSWER_SOURCE = "bank";') -lt 0) {
  Die '源码里的 DEFAULT_ANSWER_SOURCE 既不是 "bank" 也不是 "web" —— 工作副本被改成别的东西了，先确认一下。'
}
if ($src.IndexOf('const DEFAULT_RELAY_URL = "";') -lt 0) {
  Die '源码里的 DEFAULT_RELAY_URL 不为空 —— 工作副本被污染了，先清空再打中性包。'
}
if ($osrc.IndexOf('answerSource: "bank",') -lt 0) {
  Die 'options.js 的 DEFAULTS.answerSource 不是 "bank" —— 工作副本被污染了。'
}
Ok '默认来源是 bank（零依赖，谁装上都不会立刻报错）'
Ok 'DEFAULT_RELAY_URL 为空（不含任何私有地址）'

# ---------- 3. 自检 ----------
Say ''
Say '[3/5] 自检...'
$bad = 0
Get-ChildItem -Recurse -File $Stage -Include *.js, *.mjs | ForEach-Object {
  & node --check $_.FullName 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { $bad++; Say "   语法错误：$($_.Name)" Red }
}
if ($bad) { Die "有 $bad 个文件语法不过" }
Ok 'node --check 全部通过'

Push-Location $Stage
Remove-Item Env:\DXSTJ_PACKAGED -ErrorAction SilentlyContinue   # 中性包 = 干净源码模式
$out1 = & node test/logic.test.mjs 2>&1
$out2 = & node test/relay.e2e.mjs 2>&1
Pop-Location

foreach ($pair in @(@('自测', $out1), @('中转 e2e', $out2))) {
  $label = $pair[0]; $out = $pair[1]
  $line = ($out | Select-String -Pattern '(通过|失败)\s*\d+\s*项' | Select-Object -Last 1).Line
  if (-not $line) {
    Say "   $label 没有输出结果行，原始输出：" Red
    $out | Select-Object -Last 20 | ForEach-Object { Say "     $_" DarkGray }
    Die "$label 崩了，先修好再打包。"
  }
  Say "   $label：$line"
  if ("$line" -notmatch '失败\s*0\s*项') {
    $out | Select-String -Pattern '✗' | Select-Object -First 15 | ForEach-Object { Say "     $($_.Line)" Red }
    Die "$label 没过，先修好再打包。"
  }
}
Ok '两套自测全过'

# ---------- 4. 密钥泄漏扫描 ----------
Say ''
Say '[4/5] 泄漏扫描...'
$leaks = @()
Get-ChildItem -Recurse -File $Stage | ForEach-Object {
  if ($_.Extension -in @('.zip', '.png', '.jpg', '.ico', '.woff', '.woff2', '.ttf')) { return }
  $t = Get-Content $_.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  if ($t -and $t -match 'sk-[A-Za-z0-9]{20,}') { $leaks += $_.FullName }
}
if ($leaks.Count) {
  Say '   以下文件里还有疑似 API Key：' Red
  $leaks | ForEach-Object { Say "     $_" Red }
  Die '中止打包 —— 先把 Key 清掉。'
}
Ok '泄漏扫描通过：包里没有任何 sk-… 密钥'

# ---------- 5. 打 zip ----------
Say ''
Say '[5/5] 打包...'
if (-not $OutName) {
  $stamp = Get-Date -Format 'yyyyMMdd'
  $OutName = "网课助手复刻版-源码版-$stamp.zip"
}
$outZip = Join-Path $Deliver $OutName
Remove-Item $outZip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path $Stage -DestinationPath $outZip -CompressionLevel Optimal
$size = [math]::Round((Get-Item $outZip).Length / 1KB, 1)
$fileCount = (Get-ChildItem -Recurse -File $Stage).Count
Ok "已生成：$outZip  ($size KB, $fileCount 个文件)"

Say ''
Say '=====================================================================' Cyan
Say '  中性包完成：' Cyan
Say ''
Say "     $outZip" Green
Say ''
Say '  这一份是干净源码，默认「仅本地题库」（不联网、不会报错）。' White
Say '  装上后想答题，在设置页选一种来源：' White
Say '    中转 / 自己的大模型 API / 原版服务器' White
Say ''
Say '  想发一个「对方零配置」的包，用 打包给同学.bat。' Yellow
Say '=====================================================================' Cyan
Say ''
Pause '按回车关闭'
