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
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$timings = [ordered]@{}
try {
  Add-Type -AssemblyName System.Drawing

  # The Win32 calls are declared without compiling C#. Add-Type starts the C# compiler, which was the
  # slowest step of a capture and sometimes took more than 10 seconds on a busy computer.
  function New-NativeType {
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object System.Reflection.AssemblyName 'SuperbaseNative'), [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
    $module = $assembly.DefineDynamicModule('SuperbaseNative')
    $builder = $module.DefineType('SuperbaseWin', [System.Reflection.TypeAttributes]'Public, Class')
    $methods = @(
      @('GetWindowRect', [bool], [Type[]]@([IntPtr], [IntPtr])),
      @('IsIconic', [bool], [Type[]]@([IntPtr])),
      @('ShowWindow', [bool], [Type[]]@([IntPtr], [int])),
      @('SetForegroundWindow', [bool], [Type[]]@([IntPtr])),
      @('SetProcessDPIAware', [bool], [Type[]]@())
    )
    foreach ($entry in $methods) {
      $method = $builder.DefinePInvokeMethod($entry[0], 'user32.dll', [System.Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [System.Reflection.CallingConventions]::Standard, $entry[1], $entry[2], [System.Runtime.InteropServices.CallingConvention]::Winapi, [System.Runtime.InteropServices.CharSet]::Auto)
      $method.SetImplementationFlags([System.Reflection.MethodImplAttributes]'PreserveSig')
    }
    $type = $builder.CreateType()
    # A call with a null window proves that the declarations work.
    $type::IsIconic([IntPtr]::Zero) | Out-Null
    return $type
  }

  # Fallback when the first way is not available on this computer.
  function New-NativeTypeCompiled {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SuperbaseWinCompiled {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, IntPtr rect);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
    return [SuperbaseWinCompiled]
  }

  $native = $null
  $nativeKind = 'reflection'
  try { $native = New-NativeType } catch { $native = $null }
  if ($null -eq $native) {
    $nativeKind = 'compiled'
    $native = New-NativeTypeCompiled
  }
  $native::SetProcessDPIAware() | Out-Null
  $timings['native'] = $clock.ElapsedMilliseconds

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
  $timings['find'] = $clock.ElapsedMilliseconds

  if ($native::IsIconic($handle)) {
    if (-not $focus) {
      Write-Output '{"error":"minimized"}'
      exit 0
    }
    $native::ShowWindow($handle, 9) | Out-Null
    Start-Sleep -Milliseconds 400
  }
  if ($focus) {
    $native::SetForegroundWindow($handle) | Out-Null
    Start-Sleep -Milliseconds 350
  }

  $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(16)
  try {
    $found = $native::GetWindowRect($handle, $buffer)
    $left = [System.Runtime.InteropServices.Marshal]::ReadInt32($buffer, 0)
    $top = [System.Runtime.InteropServices.Marshal]::ReadInt32($buffer, 4)
    $right = [System.Runtime.InteropServices.Marshal]::ReadInt32($buffer, 8)
    $bottom = [System.Runtime.InteropServices.Marshal]::ReadInt32($buffer, 12)
  } finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
  }
  $width = $right - $left
  $height = $bottom - $top
  if (-not $found -or $width -le 0 -or $height -le 0 -or $width -gt 16384 -or $height -gt 16384) {
    Write-Output '{"error":"empty"}'
    exit 0
  }

  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size)
  $graphics.Dispose()
  $timings['capture'] = $clock.ElapsedMilliseconds

  $maxWidth = [int]$env:SB_MAX_WIDTH
  $output = $bitmap
  if ($maxWidth -gt 0 -and $width -gt $maxWidth) {
    $newHeight = [int][Math]::Round($height * $maxWidth / $width)
    $output = New-Object System.Drawing.Bitmap($maxWidth, $newHeight)
    $scaler = [System.Drawing.Graphics]::FromImage($output)
    $scaler.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
    $scaler.DrawImage($bitmap, 0, 0, $maxWidth, $newHeight)
    $scaler.Dispose()
  }
  $timings['scale'] = $clock.ElapsedMilliseconds

  $codec = $null
  foreach ($candidate in [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()) {
    if ($candidate.MimeType -eq 'image/jpeg') { $codec = $candidate; break }
  }
  $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]80)
  $stream = New-Object System.IO.MemoryStream
  $output.Save($stream, $codec, $encoderParams)
  $encoded = [Convert]::ToBase64String($stream.ToArray())
  $timings['encode'] = $clock.ElapsedMilliseconds

  # The base64 text is built by hand, because ConvertTo-Json is slow on large strings.
  $titleJson = ConvertTo-Json -InputObject ([string]$proc.MainWindowTitle) -Compress
  $timingsJson = $timings | ConvertTo-Json -Compress
  Write-Output ('{"ok":true,"mimeType":"image/jpeg","width":' + $output.Width + ',"height":' + $output.Height + ',"title":' + $titleJson + ',"native":"' + $nativeKind + '","timings":' + $timingsJson + ',"data":"' + $encoded + '"}')
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
    ...(result.timings ? { timings: result.timings, native: result.native } : {}),
  };
}

module.exports = { captureRobloxWindow, ScreenshotError, clampWidth, POWERSHELL_SCRIPT };
