param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][int]$ParentPid
)
# Tray icon for the local dashboard. It only opens the dashboard in the browser and starts or stops the
# runner through the dashboard's own local API. It stores nothing and sends nothing anywhere else.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'agent-bridge-tray', [ref]$created)
if (-not $created) { exit 3 }

$labels = @{
  open = '대시보드 열기'; settings = '설정 열기'; start = '실행기 시작'; stop = '실행기 중지'
  quit = '종료'; tip = 'agent-bridge'; running = '실행기 가동 중'; stopped = '실행기 중지됨'; failed = '실행기를 바꾸지 못했어요'
}

function Get-Token { (Invoke-RestMethod -Uri "$Url/api/bootstrap" -TimeoutSec 5).token }
function Get-Running { (Invoke-RestMethod -Uri "$Url/api/state" -TimeoutSec 5).runner.running }
function Send-Runner($action) {
  Invoke-RestMethod -Method Post -Uri "$Url/api/runner/$action" -TimeoutSec 10 -ContentType 'application/json' -Body '{}' `
    -Headers @{ 'x-bridge-token' = (Get-Token) } | Out-Null
}

# A small round icon drawn here, so no image file has to ship with the app.
$bitmap = New-Object System.Drawing.Bitmap 32, 32
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = 'AntiAlias'
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(33, 79, 202))), 2, 2, 28, 28)
$g.FillEllipse([System.Drawing.Brushes]::White, 10, 10, 12, 12)
$g.Dispose()
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icon
$tray.Text = $labels.tip
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$status = $menu.Items.Add($labels.stopped); $status.Enabled = $false
$toggle = $menu.Items.Add($labels.start)
[void]$menu.Items.Add('-')
$open = $menu.Items.Add($labels.open)
$settings = $menu.Items.Add($labels.settings)
[void]$menu.Items.Add('-')
$quit = $menu.Items.Add($labels.quit)
$tray.ContextMenuStrip = $menu

$state = @{ running = $false }
function Update-Menu {
  try { $state.running = [bool](Get-Running) } catch { return }
  $status.Text = $(if ($state.running) { $labels.running } else { $labels.stopped })
  $toggle.Text = $(if ($state.running) { $labels.stop } else { $labels.start })
  $tray.Text = "$($labels.tip) - $($status.Text)"
}

$toggle.add_Click({
  try { Send-Runner $(if ($state.running) { 'stop' } else { 'start' }) }
  catch { $tray.ShowBalloonTip(3000, $labels.tip, $labels.failed, 'Warning') }
  Update-Menu
})
$open.add_Click({ Start-Process $Url })
$settings.add_Click({ Start-Process "$Url/#settings" })
$tray.add_DoubleClick({ Start-Process $Url })
$quit.add_Click({ [System.Windows.Forms.Application]::Exit() })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
  # Leave when the dashboard process is gone, so the icon never outlives it.
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { [System.Windows.Forms.Application]::Exit(); return }
  Update-Menu
})
$timer.Start()
Update-Menu

try { [System.Windows.Forms.Application]::Run() }
finally {
  $timer.Stop(); $tray.Visible = $false; $tray.Dispose(); $icon.Dispose(); $bitmap.Dispose()
  $mutex.ReleaseMutex(); $mutex.Dispose()
}
