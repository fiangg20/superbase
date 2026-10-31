# Superbase installer for Windows PowerShell 5.1 and PowerShell 7.
#
# One line (read the script first if you want to, it is short):
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/fiangg20/superbase/main/install.ps1 | iex"
#
# What it does:
#   1. checks that Node.js 18 or newer is installed
#   2. downloads Superbase into %LOCALAPPDATA%\Superbase (git when it is installed, a zip when it is not)
#   3. runs "npm install" for the one dependency
#   4. runs scripts\install.js, which registers the MCP server in the AI clients it finds
#
# Settings (environment variables, all optional):
#   SUPERBASE_DIR    where to install               default: %LOCALAPPDATA%\Superbase
#   SUPERBASE_REF    branch or tag to download      default: main
#   SUPERBASE_ARGS   arguments for scripts\install.js, for example "--yes" or "--client cursor,codex"
#   SUPERBASE_START  set to 1 to start the bridge when everything is done
#
# Uninstall the MCP entries again: node scripts\install.js --uninstall

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$Repo = 'fiangg20/superbase'
$Ref = if ($env:SUPERBASE_REF) { $env:SUPERBASE_REF } else { 'main' }

function Say($text) { Write-Host "[superbase] $text" }

function Stop-Setup($text) {
  Write-Host "[superbase] $text" -ForegroundColor Red
  exit 1
}

# Use the folder this script sits in when it is run from a checkout, otherwise the install folder.
$Dir = $env:SUPERBASE_DIR
if (-not $Dir -and $PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'scripts\install.js'))) { $Dir = $PSScriptRoot }
if (-not $Dir) {
  $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
  $Dir = Join-Path $base 'Superbase'
}

# 1. Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Stop-Setup 'Node.js is not installed. Install it with "winget install OpenJS.NodeJS.LTS" (or from https://nodejs.org), open a new terminal and run this again.'
}
$nodeVersion = (& node --version).Trim()
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 18) {
  Stop-Setup "Node.js $nodeVersion is too old, Superbase needs 18 or newer. Update it with ""winget upgrade OpenJS.NodeJS.LTS""."
}
Say "Node.js $nodeVersion found."

# 2. The code
$git = Get-Command git -ErrorAction SilentlyContinue
if ((Test-Path (Join-Path $Dir 'scripts\install.js')) -and -not (Test-Path (Join-Path $Dir '.git'))) {
  Say "Using the files that are already in $Dir."
  if ($Dir -ne $PSScriptRoot) { Say 'Not a git checkout, so it is not updated. Delete the folder to download a fresh copy.' }
} elseif ($git -and (Test-Path (Join-Path $Dir '.git'))) {
  Say "Updating $Dir"
  & git -C $Dir pull --ff-only
  if ($LASTEXITCODE -ne 0) { Stop-Setup 'git pull failed. Fix the folder or delete it and run this again.' }
} elseif ($git) {
  if ((Test-Path $Dir) -and (Get-ChildItem $Dir -Force | Select-Object -First 1)) { Stop-Setup "$Dir exists and is not empty. Set SUPERBASE_DIR to another folder." }
  Say "Cloning into $Dir"
  & git clone --depth 1 --branch $Ref "https://github.com/$Repo.git" $Dir
  if ($LASTEXITCODE -ne 0) { Stop-Setup 'git clone failed.' }
} else {
  Say 'git is not installed, downloading a zip instead.'
  $temp = Join-Path ([IO.Path]::GetTempPath()) ('superbase-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    $zip = Join-Path $temp 'superbase.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Repo/archive/$Ref.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $temp -Force
    $inner = Get-ChildItem $temp -Directory | Where-Object { $_.Name -like 'superbase-*' } | Select-Object -First 1
    if (-not $inner) { Stop-Setup 'The downloaded zip has an unexpected layout.' }
    New-Item -ItemType Directory -Path $Dir -Force | Out-Null
    Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $Dir -Recurse -Force
  } finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
  Say "Files are in $Dir"
}

# 3. Dependencies
Push-Location $Dir
try {
  Say 'Installing the dependency (npm install)...'
  & npm install --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Stop-Setup 'npm install failed.' }

  # 4. Register the MCP server in the AI clients
  $installArgs = @()
  if ($env:SUPERBASE_ARGS) { $installArgs = @($env:SUPERBASE_ARGS -split '\s+' | Where-Object { $_ }) }
  & node (Join-Path $Dir 'scripts\install.js') @installArgs
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}

Write-Host ''
Say "Superbase is in $Dir"
Say "Start the bridge with:  cd ""$Dir""; npm start"
if ($env:SUPERBASE_START -eq '1') {
  Say 'Starting the bridge...'
  Push-Location $Dir
  try { & npm start } finally { Pop-Location }
}
exit $code
