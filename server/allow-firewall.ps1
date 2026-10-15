# =====================================================================
#  放行防火墙端口 —— 让同一个 Wi-Fi 下的同学能连上你的中转
#
#  这一步需要管理员权限。直接双击 放行防火墙.bat 会自动弹 UAC 提权。
#
#  它做的事：加一条入站规则，放行 TCP 8787。
#  重复运行是安全的（已存在就更新）。
# =====================================================================

$ErrorActionPreference = 'Stop'
$Port = 8787
$Rule = "answer-relay $Port"

try {
  $existing = Get-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue
  if ($existing) {
    Set-NetFirewallRule -DisplayName $Rule -Enabled True -Direction Inbound -Action Allow -Profile Any -ErrorAction Stop
    Write-Host "  [OK]   规则已存在，已确保启用：$Rule" -ForegroundColor Green
  } else {
    New-NetFirewallRule -DisplayName $Rule -Direction Inbound -Action Allow -Protocol TCP `
      -LocalPort $Port -Profile Any -ErrorAction Stop | Out-Null
    Write-Host "  [OK]   已新增入站规则：$Rule (TCP $Port)" -ForegroundColor Green
  }

  Write-Host ''
  Write-Host '  完成。同一个 Wi-Fi 下的同学现在能连上你的中转了。' -ForegroundColor Green
  Write-Host '  （换 Wi-Fi / 重启路由器后 IP 可能变，重新跑一遍 启动中转.bat 看新地址。）' -ForegroundColor Yellow
} catch {
  Write-Host "  [失败] $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  请确认你是以管理员身份运行的。' -ForegroundColor Yellow
}

Write-Host ''
try { $null = Read-Host '按回车关闭' } catch { }
