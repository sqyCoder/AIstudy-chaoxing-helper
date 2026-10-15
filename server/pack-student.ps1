# =====================================================================
#  打包给同学 —— 自动把中转地址写进扩展，打出一个「装上就能用」的 zip
#
#  用法（在 server 目录里）：
#     powershell -ExecutionPolicy Bypass -File 打包给同学.ps1 `
#         -RelayUrl "http://172.56.144.233:8787/solve" -RelayToken "abcd1234"
#
#  不给参数就直接双击运行，会交互式问你。
#
#  它会：
#    1. 复制一份干净的扩展源码到临时目录（**不动你的源文件**）
#    2. 在副本里改写 src/background/index.js 顶部三个常量
#    3. 语法自检 + 跑一遍自测
#    4. **删掉整个 server 目录**（里面有你的 relay-config.json / API Key）
#       再做一次「密钥泄漏扫描」，确认包里一个 Key 都没有
#    5. 打出 zip，路径打印出来
# =====================================================================

param(
  [string]$RelayUrl,
  [string]$RelayToken,
  [string]$OutName,
  # relay = 烘进你的中转地址口令（默认）；web = 烘「网页版 DeepSeek」，
  # 不需要地址口令，每个同学用自己浏览器里已登录的 chat.deepseek.com 算答案。
  [string]$AnswerSource = 'relay'
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM，JS 文件不要 BOM，统一用 .NET 显式控制
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$ServerDir = $PSScriptRoot
$Root      = Split-Path $ServerDir -Parent          # dxstj-chaoxing\
$Deliver   = Split-Path $Root -Parent               # deliverable\
$Work      = Join-Path (Split-Path $Deliver -Parent) 'work'
$Stage     = Join-Path $Work 'pack-student\dxstj-chaoxing'

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Ok($t)   { Write-Host "  [OK]   $t" -ForegroundColor Green }
# 非交互模式下 Read-Host 会抛异常（脚本被重定向或自动化调用时），吞掉即可
function Pause($m) { try { $null = Read-Host $m } catch { } }
function Ask($m)  { try { return (Read-Host $m) } catch { return '' } }
function Die($t)  { Write-Host "  [失败] $t" -ForegroundColor Red; Write-Host ''; Pause '按回车关闭'; exit 1 }

Say ''
Say '=====================================================================' Cyan
Say '   打包给同学 - 生成零配置安装包' Cyan
Say '=====================================================================' Cyan
Say ''

# ---------- 参数 ----------
$IsWebPack = ($AnswerSource -eq 'web')
if ($IsWebPack) {
  # 网页版模式不需要任何地址/口令：每个同学用他自己已登录的 chat.deepseek.com
  $RelayUrl = ''
  $RelayToken = ''
  Ok '模式：网页版 DeepSeek（免费）—— 不需要中转地址与口令'
} else {
  if (-not $RelayUrl) {
    Say '中转地址（就是「启动中转」脚本最后打印给你的那一行）' White
    Say '  例：http://172.56.144.233:8787/solve' DarkGray
    $RelayUrl = (Ask '  地址').Trim()
  }
  if (-not $RelayUrl) { Die '地址不能为空。' }
  if ($RelayUrl -notmatch '^https?://') { $RelayUrl = "http://$RelayUrl" }
  if ($RelayUrl -notmatch '/solve$')    { $RelayUrl = $RelayUrl.TrimEnd('/') + '/solve' }

  if (-not $RelayToken) {
    Say ''
    Say '中转口令（没设就留空，直接回车）' White
    $RelayToken = (Ask '  口令').Trim()
  }

  Ok "地址：$RelayUrl"
  if ($RelayToken) { Ok "口令：$RelayToken" } else { Ok '口令：(空)' }
}

# ---------- 1. 复制干净源码 ----------
Say ''
Say '[1/5] 复制干净源码到临时目录...'
Remove-Item (Join-Path $Work 'pack-student') -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
robocopy $Root $Stage /E /XD tools /NFL /NDL /NJH /NJS /NP | Out-Null
$n = (Get-ChildItem -Recurse -File $Stage).Count
if ($n -lt 10) { Die "复制出来的文件太少（$n 个），检查 robocopy 是否失败。" }
Ok "已复制 $n 个文件"

# ---------- 2. 改写常量 ----------
Say ''
Say '[2/5] 把中转地址写进副本...'

# 2a. service worker 顶部的三个常量
$bg = Join-Path $Stage 'src\background\index.js'
if (-not (Test-Path $bg)) { Die "找不到 $bg" }
$src = [System.IO.File]::ReadAllText($bg, $Utf8NoBom)

# 用 String.Replace（纯字面量），避开 -replace 的正则与 $ 转义坑
$patUrl   = 'const DEFAULT_RELAY_URL = "";'
$patToken = 'const DEFAULT_RELAY_TOKEN = "";'
# 工作副本的默认来源可能是 bank（干净源码）也可能是 web（自己用网页版 DeepSeek）
if ($src.IndexOf('const DEFAULT_ANSWER_SOURCE = "bank";') -ge 0) {
  $patSrc = 'const DEFAULT_ANSWER_SOURCE = "bank";'
} else {
  $patSrc = 'const DEFAULT_ANSWER_SOURCE = "web";'
}
foreach ($p in @($patUrl, $patToken, $patSrc)) {
  if ($src.IndexOf($p) -lt 0) { Die "源码里找不到这一行：$p`n请检查 src\background\index.js 顶部常量有没有被改过。" }
}

# -AnswerSource web：烘「网页版 DeepSeek（免费）」
#   不需要任何中转地址/口令 —— 每个同学用他自己浏览器里已登录的 chat.deepseek.com
#   算答案，彼此独立、不依赖你的电脑、不花任何人的钱。
if ($AnswerSource -eq 'web') {
  $newUrl   = ''
  $newToken = ''
  $newSrc   = 'const DEFAULT_ANSWER_SOURCE = "web";'
  Say '  模式：网页版 DeepSeek（免费）—— 每个同学用自己登录的 chat.deepseek.com'
} else {
  $newUrl   = $RelayUrl
  $newToken = $RelayToken
  $newSrc   = 'const DEFAULT_ANSWER_SOURCE = "relay";'
  Say '  模式：答题中转 —— 算力在你这边，朋友零配置'
}

$src = $src.Replace($patUrl,   'const DEFAULT_RELAY_URL = "' + $newUrl + '";')
$src = $src.Replace($patToken, 'const DEFAULT_RELAY_TOKEN = "' + $newToken + '";')
$src = $src.Replace($patSrc,   $newSrc)

[System.IO.File]::WriteAllText($bg, $src, $Utf8NoBom)

# 回读校验
$check = [System.IO.File]::ReadAllText($bg, $Utf8NoBom)
if ($check.IndexOf('const DEFAULT_RELAY_URL = "' + $newUrl + '";') -lt 0) { Die '写入校验失败（URL）' }
if ($check.IndexOf('const DEFAULT_RELAY_TOKEN = "' + $newToken + '";') -lt 0) { Die '写入校验失败（Token）' }
if ($check.IndexOf($newSrc) -lt 0) { Die '写入校验失败（answerSource）' }
Ok ('service worker 的三个常量已写入副本（answerSource=' + $AnswerSource + '）')

# 2b. 设置页的 DEFAULTS 也要跟着改。
#     否则：① 设置页首次打开/后台失联时的回退值仍是 bank，会显示成「仅本地题库」；
#           ② 同学点了「恢复默认」会把 relay 配置整片抹掉，零配置包当场失效；
#           ③ 自测里「设置页 DEFAULTS 与 background 默认一致」这一条会挂。
$opt = Join-Path $Stage 'src\options\options.js'
if (-not (Test-Path $opt)) { Die "找不到 $opt" }
$osrc = [System.IO.File]::ReadAllText($opt, $Utf8NoBom)

# options.js 的本地默认同样可能是 bank 或 web
if ($osrc.IndexOf('answerSource: "bank",') -ge 0) {
  $oPatSrc = 'answerSource: "bank",'
} else {
  $oPatSrc = 'answerSource: "web",'
}
$oPatUrl   = 'relayUrl: "",'
$oPatToken = 'relayToken: "",'
foreach ($p in @($oPatSrc, $oPatUrl, $oPatToken)) {
  if ($osrc.IndexOf($p) -lt 0) { Die "options.js 里找不到这一行：$p`n请检查 src\options\options.js 的 DEFAULTS 有没有被改过。" }
}

$osrc = $osrc.Replace($oPatSrc,   'answerSource: "' + $AnswerSource + '",')
$osrc = $osrc.Replace($oPatUrl,   'relayUrl: "' + $newUrl + '",')
$osrc = $osrc.Replace($oPatToken, 'relayToken: "' + $newToken + '",')

[System.IO.File]::WriteAllText($opt, $osrc, $Utf8NoBom)

$ocheck = [System.IO.File]::ReadAllText($opt, $Utf8NoBom)
if ($ocheck.IndexOf('answerSource: "' + $AnswerSource + '",') -lt 0) { Die '写入校验失败（options.answerSource）' }
if ($ocheck.IndexOf('relayUrl: "' + $newUrl + '",') -lt 0) { Die '写入校验失败（options.relayUrl）' }
if ($ocheck.IndexOf('relayToken: "' + $newToken + '",') -lt 0) { Die '写入校验失败（options.relayToken）' }
Ok '设置页 DEFAULTS 已同步（点「恢复默认」不会把配置抹掉）'

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
# 告诉自测：这是打包版。web 口味用 DXSTJ_PACKAGED_WEB，其余仍按 relay 校验。
if ($AnswerSource -eq 'web') {
  $env:DXSTJ_PACKAGED_WEB = '1'
} else {
  $env:DXSTJ_PACKAGED = '1'
}
$out = & node test/logic.test.mjs 2>&1
Remove-Item Env:\DXSTJ_PACKAGED -ErrorAction SilentlyContinue
Remove-Item Env:\DXSTJ_PACKAGED_WEB -ErrorAction SilentlyContinue
Pop-Location
$line = ($out | Select-String -Pattern '通过\s*\d+\s*项，失败\s*\d+\s*项' | Select-Object -Last 1).Line
if (-not $line) {
  Say '   自测没有输出结果行，原始输出：' Red
  $out | Select-Object -Last 20 | ForEach-Object { Say "     $_" DarkGray }
  Die '自测崩了，先修好再打包。'
}
Say "   自测：$line"
if ("$line" -notmatch '失败\s*0\s*项') {
  $out | Select-String -Pattern '✗' | Select-Object -First 15 | ForEach-Object { Say "     $($_.Line)" Red }
  Die '自测没过，先修好再打包。'
}
Ok '自测全过'

# ---------- 4. 清掉 server 目录 + 密钥泄漏扫描 ----------
Say ''
Say '[4/5] 清理与泄漏扫描...'
$stageServer = Join-Path $Stage 'server'
if (Test-Path $stageServer) {
  Remove-Item $stageServer -Recurse -Force
  Ok '已从副本里删除 server 目录（你的 API Key 在里面，不能发出去）'
}
Get-ChildItem -Recurse -File $Stage -Filter 'relay-config*.json' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item $_.FullName -Force; Say "   顺手删掉：$($_.Name)" DarkGray }

# 真·泄漏扫描：任何形如 sk-xxxx…（20 位以上）的串都不允许出现在包里
$leaks = @()
Get-ChildItem -Recurse -File $Stage | ForEach-Object {
  if ($_.Extension -in @('.zip', '.png', '.jpg', '.ico', '.woff', '.woff2', '.ttf')) { return }
  $t = Get-Content $_.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  if ($t -and $t -match 'sk-[A-Za-z0-9]{20,}') { $leaks += $_.FullName }
}
if ($leaks.Count) {
  Say '   以下文件里还有疑似 API Key：' Red
  $leaks | ForEach-Object { Say "     $_" Red }
  Die '中止打包 —— 先把 Key 清掉，别把它发给同学。'
}
Ok '泄漏扫描通过：包里没有任何 sk-… 密钥'

# ---------- 5. 打 zip ----------
Say ''
Say '[5/5] 打包...'
if (-not $OutName) {
  $stamp = Get-Date -Format 'yyyyMMdd'
  if ($AnswerSource -eq 'web') {
    $OutName = "网课助手-网页版免费包-$stamp.zip"
  } else {
    $OutName = "网课助手-零配置版-$stamp.zip"
  }
}
$outZip = Join-Path $Deliver $OutName
Remove-Item $outZip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path $Stage -DestinationPath $outZip -CompressionLevel Optimal
$size = [math]::Round((Get-Item $outZip).Length / 1KB, 1)
Ok "已生成：$outZip  ($size KB)"

Say ''
Say '=====================================================================' Cyan
Say '  打包完成。把这个 zip 发给同学：' Cyan
Say ''
Say "     $outZip" Green
Say ''
Say '  同学那边只需要三步：' White
Say '    1. 解压，得到 dxstj-chaoxing 文件夹' White
Say '    2. edge://extensions -> 开发人员模式 -> 加载解压缩的扩展 -> 选那个文件夹' White
Say '    3. 打开学习通章节页 -> 把「视频助手 / 开启」打开 -> 自动开始' White
Say ''
if ($IsWebPack) {
  Say '  不用填地址、不用填口令、不用装任何东西、也不花任何人的钱。' Green
  Say ''
  Say '  唯一的额外前提：同学自己要在这个浏览器里登录 chat.deepseek.com。' Yellow
  Say '  未登录的话第一次答题会失败并提示；登录一次之后就好了。' Yellow
  Say '  答题时会在后台自动开一个 DeepSeek 标签页——别关它，也别退出登录。' Yellow
  Say '  它用的是同学自己的免费账号，与你无关，你电脑关不关都不影响。' Green
} else {
  Say '  不用填地址、不用填口令、不用装任何东西。' Green
  Say '  前提：你的电脑开着，且「启动中转」那个窗口没关。' Yellow
}
Say '=====================================================================' Cyan
Say ''
Pause '按回车关闭'
