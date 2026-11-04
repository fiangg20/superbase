# Superbase tray icon (Windows). Started by the background bridge, never by hand.
# It shows the Superbase icon in the notification area and a menu to open the dashboard, copy the loader line, show
# the log, restart the bridge and stop it. It talks to the bridge over HTTP (the status), and stops or restarts it by
# itself, so the bridge needs no extra code for the menu. It closes when the bridge is gone.
# The token, when there is one, arrives in the SUPERBASE_TRAY_TOKEN environment variable, not on the command line.

param(
    [Parameter(Mandatory = $true)][int]$Port,
    [string]$BridgeHost = "127.0.0.1",
    [Parameter(Mandatory = $true)][int]$BridgePid,
    [string]$Version = "",
    [string]$NodePath = "node",
    [string]$CliPath = "",
    [string]$LogFile = "",
    [string]$IconFile = ""
)

$ErrorActionPreference = "SilentlyContinue"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$base = "http://" + $BridgeHost + ":" + $Port
$token = $env:SUPERBASE_TRAY_TOKEN
$releasesUrl = "https://github.com/fiangg20/superbase/releases/latest"

# The icon: assets/icon.png scaled to 32 x 32. Without the file the default application icon is used.
function New-TrayIcon([string]$Path) {
    try {
        if ($Path -and (Test-Path -LiteralPath $Path)) {
            $source = New-Object System.Drawing.Bitmap($Path)
            $bitmap = New-Object System.Drawing.Bitmap(32, 32)
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.DrawImage($source, 0, 0, 32, 32)
            $graphics.Dispose()
            $source.Dispose()
            return [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
        }
    } catch {
    }
    return [System.Drawing.SystemIcons]::Application
}

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = New-TrayIcon $IconFile
$icon.Text = "Superbase"
$icon.Visible = $true

function Set-Tip([string]$Text) {
    # A notification icon tooltip holds at most 63 characters.
    if ($Text.Length -gt 63) { $Text = $Text.Substring(0, 60) + "..." }
    $icon.Text = $Text
}

function Show-Balloon([string]$Title, [string]$Text) {
    $icon.BalloonTipTitle = $Title
    $icon.BalloonTipText = $Text
    $icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
    $icon.ShowBalloonTip(4000)
}

function Close-Tray {
    $timer.Stop()
    $icon.Visible = $false
    $icon.Dispose()
    [System.Windows.Forms.Application]::Exit()
}

# The menu ---------------------------------------------------------------------------------------------------------

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$titleItem = $menu.Items.Add("Superbase " + $Version)
$titleItem.Enabled = $false
$statusItem = $menu.Items.Add("Starting...")
$statusItem.Enabled = $false
$updateItem = $menu.Items.Add("Update available")
$updateItem.Visible = $false
[void]$menu.Items.Add("-")

$dashboardItem = $menu.Items.Add("Open dashboard")
$copyItem = $menu.Items.Add("Copy loader line")
$logItem = $menu.Items.Add("Show log")
[void]$menu.Items.Add("-")
$restartItem = $menu.Items.Add("Restart bridge")
$stopItem = $menu.Items.Add("Stop Superbase")

$dashboardItem.Add_Click({ Start-Process ($base + "/") })
$icon.Add_DoubleClick({ Start-Process ($base + "/") })

$copyItem.Add_Click({
    $query = ""
    if ($token) { $query = "?token=" + [System.Uri]::EscapeDataString($token) }
    Set-Clipboard -Value ('loadstring(game:HttpGet("' + $base + '/client.lua' + $query + '"))()')
    Show-Balloon "Copied" "Paste the line into your executor and run it."
})

$logItem.Add_Click({
    if ($LogFile -and (Test-Path -LiteralPath $LogFile)) {
        $logArg = '"' + $LogFile + '"'
        Start-Process -FilePath "notepad.exe" -ArgumentList $logArg
    } else {
        Show-Balloon "No log yet" "The bridge has not written a log file."
    }
})

$updateItem.Add_Click({ Start-Process $releasesUrl })

$restartItem.Add_Click({
    # The same command as "npm run restart": it stops this bridge and starts a new one, which brings its own tray icon.
    $cliArg = '"' + $CliPath + '"'
    Start-Process -FilePath $NodePath -ArgumentList @($cliArg, "restart") -WindowStyle Hidden
    Close-Tray
})

$stopItem.Add_Click({
    Stop-Process -Id $BridgePid -Force
    Close-Tray
})

$icon.ContextMenuStrip = $menu

# The status, and a check that the bridge is still there --------------------------------------------------------------

function Update-Status {
    if (-not (Get-Process -Id $BridgePid)) {
        Close-Tray
        return
    }

    $info = $null
    try {
        $headers = @{ "x-superbase-client" = "tray" }
        if ($token) { $headers["x-bridge-token"] = $token }
        $info = Invoke-RestMethod -Uri ($base + "/status") -Headers $headers -TimeoutSec 2
    } catch {
    }

    if ($null -eq $info) {
        $statusItem.Text = "The bridge does not answer"
        Set-Tip "Superbase: not answering"
        return
    }

    $clients = @($info.clients)
    if ($clients.Count -eq 0) {
        $statusItem.Text = "Waiting for Roblox"
        Set-Tip "Superbase: waiting for Roblox"
    } elseif ($clients.Count -eq 1) {
        $name = $clients[0].userName
        if (-not $name) { $name = $clients[0].id }
        $statusItem.Text = "Roblox: " + $name
        Set-Tip ("Superbase: " + $name + " connected")
    } else {
        $statusItem.Text = "Roblox: " + $clients.Count + " windows connected"
        Set-Tip ("Superbase: " + $clients.Count + " windows connected")
    }

    if ($info.update -and $info.update.available) {
        $updateItem.Text = "Update available: " + $info.update.latest
        $updateItem.Visible = $true
    } else {
        $updateItem.Visible = $false
    }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.Add_Tick({ Update-Status })
$timer.Start()

Update-Status
Show-Balloon "Superbase is running" "The bridge runs in the background. Right-click this icon to open the dashboard or to stop it."

[System.Windows.Forms.Application]::Run()
