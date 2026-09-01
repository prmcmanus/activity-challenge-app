# One-time fix for corporate (Zscaler TLS-inspecting proxy) networks where the JDK
# cannot resolve Gradle/Maven/Kotlin plugin dependencies due to:
#   javax.net.ssl.SSLHandshakeException: PKIX path building failed ... unable to
#   find valid certification path to requested target
#
# This imports the Zscaler Root CA and Intermediate CA certificates (already trusted
# by Windows) into the target JDK's cacerts keystore, so Java trusts the same
# TLS-intercepted connections that curl/Windows apps already trust.
#
# Usage: .\import-zscaler-certs.ps1 -JavaHome "C:\path\to\jdk-17"
#
# After running this once per JDK install, build Gradle with:
#   $env:GRADLE_OPTS = "-Djava.net.useSystemProxies=true"
# so Java also honours the PAC-based proxy configuration (see README.md).

param(
    [Parameter(Mandatory = $true)]
    [string]$JavaHome,

    [string]$ProbeHost = "repo.maven.apache.org"
)

$keytool = Join-Path $JavaHome "bin\keytool.exe"
if (-not (Test-Path $keytool)) {
    Write-Error "keytool not found at $keytool. Check -JavaHome."
    exit 1
}

$cacerts = Join-Path $JavaHome "lib\security\cacerts"
if (-not (Test-Path $cacerts)) {
    Write-Error "cacerts not found at $cacerts."
    exit 1
}

Write-Host "Capturing TLS certificate chain presented for https://$ProbeHost ..."

$tcp = New-Object System.Net.Sockets.TcpClient($ProbeHost, 443)
$capturedElems = $null
$callback = {
    param($sender, $cert, $chain, $errors)
    $script:capturedElems = $chain.ChainElements | ForEach-Object { $_.Certificate }
    $true
}
$ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, $callback)
$ssl.AuthenticateAsClient($ProbeHost)
$ssl.Close()
$tcp.Close()

if (-not $script:capturedElems -or $script:capturedElems.Count -lt 2) {
    Write-Error "Could not capture a certificate chain (or no interception detected). Aborting."
    exit 1
}

# Element 0 is the leaf (the intercepted host cert) - skip it, import only the CA certs.
$tempDir = Join-Path $env:TEMP "zscaler-certs"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

$i = 0
foreach ($cert in $script:capturedElems) {
    if ($i -gt 0) {
        $file = Join-Path $tempDir "ca$i.cer"
        [IO.File]::WriteAllBytes($file, $cert.Export('Cert'))
        Write-Host "Importing CA cert: $($cert.Subject)"
        & $keytool -importcert -alias "zscaler-ca-$i" -file $file -keystore $cacerts -storepass changeit -noprompt
    }
    $i++
}

Write-Host ""
Write-Host "Done. Now build with:"
Write-Host "  `$env:JAVA_HOME = '$JavaHome'"
Write-Host "  `$env:GRADLE_OPTS = '-Djava.net.useSystemProxies=true'"
