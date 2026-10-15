# =====================================================================
#  一键启动「答题中转」
#
#  上游有两种，脚本按 server\relay-config.json 自动判断：
#     A. 云端 API（推荐，默认 DeepSeek）—— 不占你电脑、答题质量最好
#     B. 本机 Ollama                    —— 完全免费，但要 4.7 GB 模型 + 显卡
#
#  你只需要双击 server\启动中转.bat。脚本会自动：
#    1. 找到 Node
#    2. 读配置（第一次跑会带你把 Key 填好并写盘，以后就一键了）
#    3. 按上游类型做连通性自检（云端验 Key，本机拉起 Ollama 并确认模型）
#    4. 放行防火墙端口（同一个 Wi-Fi 下的同学才能连上）
#    5. 探测你电脑的局域网 IP
#    6. 启动中转，并打印「该填到扩展里的地址/口令」和「该改的那三行常量」
#
#  配置文件 server\relay-config.json 里有你花钱的 Key，
#  打包脚本已排除整个 server 目录，所以它绝不会被发给别人。
# =====================================================================

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = '答题中转 - 请勿关闭这个窗口'

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Ok($t)   { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [注意] $t" -ForegroundColor Yellow }
# 非交互模式下 Read-Host 会抛异常（被重定向/自动化调用时），吞掉即可
function Pause($m) { try { $null = Read-Host $m } catch { } }
function Ask($m)  { try { return (Read-Host $m) } catch { return '' } }
function Die($t)  { Write-Host "  [失败] $t" -ForegroundColor Red; Write-Host ''; Pause '按回车关闭'; exit 1 }

$ConfigPath = Join-Path $PSScriptRoot 'relay-config.json'

# ---------- 0. 标题 ----------
Say ''
Say '=====================================================================' Cyan
Say '   答题中转 · 一键启动' Cyan
Say '=====================================================================' Cyan

# ---------- 1. Node ----------
Say ''
Say '[1/6] 查找 Node...'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if (Test-Path $p) { $node = $p; break }
  }
}
if (-not $node) { Die '找不到 Node。先去 https://nodejs.org 装一个 LTS 版，然后重跑本脚本。' }
Ok "Node: $node  ($(& $node --version))"

# ---------- 2. 配置 ----------
Say ''
Say '[2/6] 读配置...'

function Read-Cfg {
  if (-not (Test-Path $ConfigPath)) { return $null }
  try {
    $raw = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.UTF8Encoding]::new($false))
    return $raw | ConvertFrom-Json
  } catch {
    Warn "relay-config.json 读不出来（$($_.Exception.Message)）"
    return $null
  }
}

function Save-Cfg($o) {
  $json = $o | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($ConfigPath, $json, [System.Text.UTF8Encoding]::new($false))
}

$cfg = Read-Cfg

function Ask-Setup {
  Say ''
  Say '  第一次跑，需要你做一次选择。答案会存进 server\relay-config.json，以后不用再选。' White
  Say ''
  Say '    1) 云端 API（推荐）—— 用 DeepSeek，便宜、中文题准、不占电脑' White
  Say '       DeepSeek Key 到 https://platform.deepseek.com/api_keys 申请，约 ¥1 / 百万字' White
  Say '    2) 本机 Ollama —— 完全免费，但需要先下 4.7 GB 模型，且没显卡会慢' White
  Say ''
  $pick = Ask '  输入 1 或 2 然后回车'
  if ($pick -eq '2') {
    $o = [ordered]@{
      '_comment'      = 'Local Ollama upstream. No paid key in this file.'
      'upstreamBase'  = 'http://127.0.0.1:11434/v1'
      'upstreamKey'   = 'ollama'
      'upstreamModel' = 'qwen2.5:7b'
      'upstreamVision'= 'auto'
      'port'          = 8787
      'relayToken'    = ''
    }
    Save-Cfg $o
    Ok '已写成「本机 Ollama」配置'
    return [pscustomobject]$o
  }
  Say ''
  $k = Ask '  把你的 DeepSeek Key 粘进来（sk- 开头）'
  if (-not $k -or $k -notmatch '^sk-') { Die 'Key 看起来不对（应该以 sk- 开头）。' }
  $o = [ordered]@{
    '_comment'      = 'PRIVATE. Contains your paid API key. NEVER shipped or shared.'
    'upstreamBase'  = 'https://api.deepseek.com/v1'
    'upstreamKey'   = $k.Trim()
    'upstreamModel' = 'deepseek-chat'
    'upstreamVision'= '0'
    'port'          = 8787
    'relayToken'    = ''
  }
  Save-Cfg $o
  Ok '已写进 server\relay-config.json（这个文件不会被发出去）'
  return [pscustomobject]$o
}

if (-not $cfg -or -not $cfg.upstreamBase) { $cfg = Ask-Setup }

$Port        = if ($env:PORT)          { $env:PORT }          elseif ($cfg.port)          { "$($cfg.port)" }          else { '8787' }
$Upstream    = "$($cfg.upstreamBase)".TrimEnd('/')
$UpKey       = if ($env:UPSTREAM_KEY)  { $env:UPSTREAM_KEY }  else { "$($cfg.upstreamKey)" }
$Model       = if ($env:UPSTREAM_MODEL){ $env:UPSTREAM_MODEL}elseif ($cfg.upstreamModel) { "$($cfg.upstreamModel)" } else { 'deepseek-chat' }
$RelayToken  = if ($env:RELAY_TOKEN)   { $env:RELAY_TOKEN }   else { "$($cfg.relayToken)" }
$Vision      = if ($env:UPSTREAM_VISION){ $env:UPSTREAM_VISION } elseif ($null -ne $cfg.upstreamVision) { "$($cfg.upstreamVision)" }
               elseif ($Model -match 'vl|vision|llava|minicpm|gemma3|moondream') { 'auto' }
               else { '0' }

$IsLocal = $Upstream -match '127\.0\.0\.1|localhost'

if ($UpKey -match '在这里填|PUT-YOUR|^$' -and -not $IsLocal) {
  Die "配置里的 Key 还是空的/占位符。打开 server\relay-config.json 填好 upstreamKey，或删掉该文件重跑本脚本按提示重填。"
}

Ok "上游    : $Upstream"
Ok "模型    : $Model"
Ok "图片支持: $(if ($Vision -eq '0') { '关闭（纯文本模型）' } else { $Vision })"
if (-not $IsLocal) {
  $shown = if ($UpKey.Length -gt 12) { $UpKey.Substring(0,7) + '****' + $UpKey.Substring($UpKey.Length-4) } else { '****' }
  Ok "Key     : $shown（只显示头尾，不落盘到日志）"
}

# 没给口令就自动生成一个，避免同学的地址被别人薅
$tokenGenerated = $false
if (-not $RelayToken) {
  $RelayToken = -join ((48..57) + (97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
  $tokenGenerated = $true
}

# ---------- 3. 上游自检 ----------
Say ''
Say '[3/6] 上游自检...'

if ($IsLocal) {
  $ollamaExe = (Get-Command ollama -ErrorAction SilentlyContinue).Source
  if (-not $ollamaExe) {
    foreach ($p in @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "$env:ProgramFiles\Ollama\ollama.exe")) {
      if (Test-Path $p) { $ollamaExe = $p; break }
    }
  }
  if (-not $ollamaExe) { Die "找不到 Ollama。http://127.0.0.1:11434 连不上，也没装 Ollama。装一个，或把 relay-config.json 改成云端 API。" }
  Ok "Ollama: $ollamaExe"

  function Test-Ollama {
    try { $null = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3; return $true } catch { return $false }
  }
  if (Test-Ollama) {
    Ok 'Ollama 服务已在运行'
  } else {
    Warn 'Ollama 没在跑，正在拉起它...'
    $app = Join-Path (Split-Path $ollamaExe) 'ollama app.exe'
    if (Test-Path $app) { Start-Process $app | Out-Null } else { Start-Process $ollamaExe -ArgumentList 'serve' -WindowStyle Hidden | Out-Null }
    $up = $false
    foreach ($i in 1..30) { Start-Sleep -Milliseconds 800; if (Test-Ollama) { $up = $true; break } }
    if (-not $up) { Die 'Ollama 起不来。手动双击一下 Ollama 的图标，等托盘出现羊驼图标后重跑本脚本。' }
    Ok 'Ollama 已启动'
  }

  $tags = (Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 5).models
  $has = $false
  foreach ($m in $tags) { if ($m.name -eq $Model -or $m.name -eq "$Model`:latest") { $has = $true; break } }
  if ($has) {
    Ok "模型已在本地：$Model"
  } else {
    Warn "本地没有 $Model，开始下载（约 4.7 GB，几分钟到几十分钟，别关这个窗口）"
    & $ollamaExe pull $Model
    if ($LASTEXITCODE -ne 0) { Die "ollama pull $Model 失败。检查网络后重跑。" }
    Ok "模型下载完成：$Model"
  }
} else {
  # 云端：直接发一个最小请求验 Key，错了立刻报清楚，别等到答题时才炸
  try {
    $body = @{
      model      = $Model
      messages   = @(@{ role = 'user'; content = 'ping' })
      max_tokens = 4
    } | ConvertTo-Json -Depth 6
    $r = Invoke-RestMethod -Uri "$Upstream/chat/completions" -Method Post `
           -Headers @{ Authorization = "Bearer $UpKey" } `
           -ContentType 'application/json' -Body $body -TimeoutSec 45
    if ($r.choices) { Ok '云端 Key 有效，连通正常' }
    else { Warn '云端返回了内容但结构不像预期，先继续，答题时若报错再看这里。' }
  } catch {
    $detail = $_.Exception.Message
    if ($_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
    Die "云端连不上或 Key 无效：$detail`n  检查：1) Key 有没有填错 2) https://platform.deepseek.com 里余额是否够 3) 网络能否访问 api.deepseek.com"
  }
}

# ---------- 4. 防火墙 ----------
Say ''
Say "[4/6] 放行防火墙端口 $Port ..."
$ruleName = "answer-relay $Port"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
  Ok "规则已存在（$ruleName）"
} else {
  try {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any -ErrorAction Stop | Out-Null
    Ok "已放行入站 TCP $Port"
  } catch {
    Warn "放行失败（不是管理员）。同一个 Wi-Fi 下的同学会连不上 ——"
    Warn "  双击 server\放行防火墙.bat（会弹一次 UAC），然后重跑本脚本即可。"
  }
}

# ---------- 5. 局域网 IP ----------
# 坑：Radmin VPN / VMware / Hyper-V 这些虚拟网卡也是 Up、也可能有默认网关，
#     直接按「有网关」挑会挑到 26.x / 192.168.x 这类别人根本连不上的地址。
#     所以：先排除 Virtual=True 与名字里带 VPN/TAP/Virtual 的，优先物理网卡。
Say ''
Say '[5/6] 探测局域网 IP...'
$ip = $null
try {
  $cands = Get-NetIPConfiguration | Where-Object {
    $_.NetAdapter.Status -eq 'Up' -and
    $_.IPv4Address -ne $null -and
    $_.IPv4DefaultGateway -ne $null -and
    -not $_.NetAdapter.Virtual -and
    $_.InterfaceAlias -notmatch 'VPN|TAP|Virtual|VMware|Hyper-V|vEthernet|Loopback|Bluetooth|ZeroTier|Tailscale'
  }
  # 物理网卡里再优先 WLAN / Ethernet / Wi-Fi / 以太网
  $nic = $cands | Where-Object { $_.InterfaceAlias -match 'WLAN|Wi-?Fi|Ethernet|以太网|无线' } | Select-Object -First 1
  if (-not $nic) { $nic = $cands | Select-Object -First 1 }
  if ($nic) { $ip = ($nic.IPv4Address | Select-Object -First 1).IPAddress }
} catch { }
if (-not $ip) {
  # 退路：仍然排除虚拟网段的常见前缀
  $ip = (Get-NetIPAddress -AddressFamily IPv4 |
         Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and
                        $_.IPAddress -notlike '26.*' -and $_.IPAddress -notlike '25.*' -and
                        $_.PrefixOrigin -ne 'WellKnown' } |
         Select-Object -First 1).IPAddress
}
if (-not $ip) { $ip = '127.0.0.1'; Warn '探测不到局域网 IP，只能本机用' }
else { Ok "局域网 IP: $ip" }

$relayUrl = "http://${ip}:${Port}/solve"

# 口令是随机生成的，存回配置，下次跑还是同一个（不然同学那边一重启就失效）
if ($tokenGenerated) {
  try {
    $cfg | Add-Member -NotePropertyName relayToken -NotePropertyValue $RelayToken -Force
    Save-Cfg $cfg
    Ok '口令已生成并存回配置（下次启动不变）'
  } catch { Warn '口令没能存回配置，下次启动会换一个新的，同学那边可能要重填。' }
}

# ---------- 6. 启动 ----------
Say ''
Say '[6/6] 启动中转...'
Say ''
Say '=====================================================================' Cyan
Say '  复制下面这两行，接下来要用：' Cyan
Say '=====================================================================' Cyan
Say ''
Say "   扩展设置页 → 答案来源选「答题中转」→ 中转地址填：" White
Say "       $relayUrl" Green
Say ''
Say "   中转口令填：" White
Say "       $RelayToken" Green
Say ''
Say '   （上面两行填进扩展设置页，你自己这份就能答题了）' DarkGray
Say ''
Say '   要让同学也零配置（装上就能答题，不用他们填任何东西）：' White
Say '      双击 server\打包给同学.bat，把上面地址和口令粘进去' White
Say '      它会自动改写常量、自检、打出 zip，你直接发给同学即可。' White
Say ''
Say '   它等价于手工改 src\background\index.js 顶部这三行：' DarkGray
Say "       const DEFAULT_RELAY_URL = `"$relayUrl`";" DarkGray
Say "       const DEFAULT_RELAY_TOKEN = `"$RelayToken`";" DarkGray
Say '       const DEFAULT_ANSWER_SOURCE = "relay";' DarkGray
Say ''
Say '=====================================================================' Cyan
Say '  现在启动服务。这个窗口不要关 —— 关了中转就停了。' Yellow
Say '  按 Ctrl+C 可以停止。' Yellow
Say '=====================================================================' Cyan
Say ''

$env:PORT                = $Port
$env:UPSTREAM_BASE       = $Upstream
$env:UPSTREAM_KEY        = $UpKey
$env:UPSTREAM_MODEL      = $Model
$env:UPSTREAM_VISION     = $Vision
$env:RELAY_TOKEN         = $RelayToken
$env:UPSTREAM_TIMEOUT_MS = if ($env:UPSTREAM_TIMEOUT_MS) { $env:UPSTREAM_TIMEOUT_MS } else { '180000' }

& $node (Join-Path $PSScriptRoot 'answer-relay.mjs')
