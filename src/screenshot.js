"use strict";

// Captures the Roblox window on Windows with a short PowerShell script.
// The bridge exposes this as GET /screenshot. Nothing from the request is placed in the script:
// the width and the focus flag travel through environment variables.

const { spawn } = require("child_process");

const DEFAULT_MAX_WIDTH = 1280;
const MIN_WIDTH = 320;
const MAX_WIDTH = 1920;
const CAPTURE_TIMEOUT_MS = 20000;

class ScreenshotError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SuperbaseWin {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
  [SuperbaseWin]::SetProcessDPIAware() | Out-Null

  $candidates = @(Get-Process -Name RobloxPlayerBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
  if ($candidates.Count -eq 0) {
    $candidates = @(Get-Process | Where-Object { $_.MainWindowTitle -eq 'Roblox' -and $_.MainWindowHandle -ne [IntPtr]::Zero })
  }
  if ($candidates.Count -eq 0) {
    Write-Output '{"error":"not_found"}'
    exit 0
  }

  $proc = $candidates[0]
  $handle = $proc.MainWindowHandle
  $focus = ($env:SB_FOCUS -eq '1')

  if ([SuperbaseWin]::IsIconic($handle)) {
    if (-not $focus) {
      Write-Output '{"error":"minimized"}'
      exit 0
    }
    [SuperbaseWin]::ShowWindow($handle, 9) | Out-Null
    Start-Sleep -Milliseconds 400
  }
  if ($focus) {
    [SuperbaseWin]::SetForegroundWindow($handle) | Out-Null
    Start-Sleep -Milliseconds 350
  }

  $rect = New-Object SuperbaseWin+RECT
  [SuperbaseWin]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) {
    Write-Output '{"error":"empty"}'
    exit 0
  }

  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
  $graphics.Dispose()

  $maxWidth = [int]$env:SB_MAX_WIDTH
  $output = $bitmap
  if ($maxWidth -gt 0 -and $width -gt $maxWidth) {
    $newHeight = [int][Math]::Round($height * $maxWidth / $width)
    $output = New-Object System.Drawing.Bitmap($maxWidth, $newHeight)
    $scaler = [System.Drawing.Graphics]::FromImage($output)
    $scaler.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $scaler.DrawImage($bitmap, 0, 0, $maxWidth, $newHeight)
    $scaler.Dispose()
  }

  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]80)
  $stream = New-Object System.IO.MemoryStream
  $output.Save($stream, $codec, $encoderParams)

  $result = @{
    ok = $true
    mimeType = 'image/jpeg'
    width = $output.Width
    height = $output.Height
    title = $proc.MainWindowTitle
    data = [Convert]::ToBase64String($stream.ToArray())
  }
  Write-Output ($result | ConvertTo-Json -Compress)
} catch {
  $message = $_.Exception.Message -replace '[\\r\\n"\\\\]', ' '
  Write-Output ('{"error":"failed","detail":"' + $message + '"}')
}
`;

function runPowerShell(script, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { env: { ...process.env, ...env }, windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new ScreenshotError(504, "The screenshot took too long."));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ScreenshotError(500, `Could not start PowerShell: ${error.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
}

function clampWidth(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return DEFAULT_MAX_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, number));
}

// Returns { mimeType, data (base64), width, height, title }.
// The platform and the runner can be replaced, which the tests do.
async function captureRobloxWindow({
  maxWidth = DEFAULT_MAX_WIDTH,
  focus = false,
  platform = process.platform,
  run = runPowerShell,
  timeoutMs = CAPTURE_TIMEOUT_MS,
} = {}) {
  if (platform !== "win32") {
    throw new ScreenshotError(501, "Screenshots are only supported on Windows.");
  }

  const { stdout, stderr } = await run(
    POWERSHELL_SCRIPT,
    { SB_MAX_WIDTH: String(clampWidth(maxWidth)), SB_FOCUS: focus ? "1" : "0" },
    timeoutMs,
  );

  const lastLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();

  let result;
  try {
    result = JSON.parse(lastLine);
  } catch {
    throw new ScreenshotError(500, `PowerShell returned no usable result. ${stderr.trim().slice(0, 300)}`.trim());
  }

  if (result.error === "not_found") {
    throw new ScreenshotError(404, "No Roblox window was found. Is the game running?");
  }
  if (result.error === "minimized") {
    throw new ScreenshotError(409, "The Roblox window is minimized. Restore it, or set focus to true.");
  }
  if (result.error === "empty") {
    throw new ScreenshotError(409, "The Roblox window has no visible area.");
  }
  if (result.error) {
    throw new ScreenshotError(500, `The screenshot failed${result.detail ? `: ${result.detail}` : "."}`);
  }

  return {
    mimeType: result.mimeType,
    data: result.data,
    width: result.width,
    height: result.height,
    title: result.title || null,
  };
}

module.exports = { captureRobloxWindow, ScreenshotError, clampWidth, POWERSHELL_SCRIPT };
