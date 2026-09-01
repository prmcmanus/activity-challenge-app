# Builds the companion Android app locally on machines behind a Zscaler-intercepting
# corporate proxy (e.g. Company network) where the JDK does not trust the intercepting
# certificate and does not automatically use the OS/PAC proxy configuration.
#
# Root cause (see README.md "Corporate network / proxy notes" for full detail):
#   1. Java's own SSL stack doesn't trust the corporate TLS-inspection root CA that
#      Windows already trusts -> PKIX path building failed.
#   2. Java doesn't consult the OS PAC file by default, so it either goes direct
#      (fails on #1) or needs -Djava.net.useSystemProxies=true to route like curl.
#
# Fix applied once per machine/JDK:
#   - Import the Zscaler Root CA + both Intermediate CAs (already trusted by Windows)
#     into the JDK's cacerts keystore.
#   - Run Gradle with -Djava.net.useSystemProxies=true so it honours the PAC file.
#
# Usage: .\build-local.ps1 [-Task assembleDebug] [-JavaHome <path>] [-GradleHome <path>]

param(
    [string]$Task = "assembleDebug",
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$GradleHome = "C:\Gradle\gradle-8.9"
)

if (-not $JavaHome -or -not (Test-Path $JavaHome)) {
    Write-Error "JAVA_HOME not set or invalid. Pass -JavaHome <path-to-jdk-17> or set JAVA_HOME."
    exit 1
}

$gradleBat = Join-Path $GradleHome "bin\gradle.bat"
if (-not (Test-Path $gradleBat)) {
    Write-Error "Gradle not found at $gradleBat. Install Gradle 8.9+ (see README) or pass -GradleHome."
    exit 1
}

$env:JAVA_HOME = $JavaHome
$env:GRADLE_OPTS = "-Djava.net.useSystemProxies=true"

Push-Location $PSScriptRoot
try {
    & $gradleBat $Task --no-daemon
} finally {
    Pop-Location
}
