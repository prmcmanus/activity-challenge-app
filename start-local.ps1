param(
  [int]$Port = 3000,
  [string]$DataDir = (Join-Path $PSScriptRoot '.local-data'),
  [string]$AdminEmail = 'admin@example.com',
  [string]$AdminPassword = 'ChangeMe123!'
)

$ErrorActionPreference = 'Stop'
$nodeVersion = '24.20.0'
$nodeUrl = 'https://github.com/actions/node-versions/releases/download/24.20.0-33034074684/node-24.20.0-win32-x64.7z'

function Get-UsableNode {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    $versionText = & $node.Source --version
    $version = [version]($versionText.TrimStart('v').Split('-')[0])
    if ($version -ge [version]'22.0.0') {
      return $node.Source
    }
  }

  $toolsDir = Join-Path $PSScriptRoot '.tools'
  $nodeDir = Join-Path $toolsDir "node-$nodeVersion-win-x64"
  $nodeExe = Join-Path $nodeDir 'node.exe'

  if (!(Test-Path $nodeExe)) {
    $archive = Join-Path $toolsDir "node-$nodeVersion-win-x64.7z"
    New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

    if (!(Test-Path $archive)) {
      Write-Host "Downloading portable Node.js $nodeVersion..."
      curl.exe -L --fail --show-error --output $archive $nodeUrl
    }

    Write-Host "Extracting portable Node.js $nodeVersion..."
    New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
    tar.exe -xf $archive -C $nodeDir
  }

  return $nodeExe
}

$nodeExe = Get-UsableNode
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$env:PORT = [string]$Port
$env:DATA_DIR = $DataDir
$env:APP_ORIGIN = "http://localhost:$Port"
$env:SEED_ADMIN_EMAIL = $AdminEmail
$env:SEED_ADMIN_PASSWORD = $AdminPassword

Write-Host "Starting Active Together at $env:APP_ORIGIN"
Write-Host "Admin login: $AdminEmail / $AdminPassword"
& $nodeExe (Join-Path $PSScriptRoot 'server.js')
