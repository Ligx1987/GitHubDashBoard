param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dashboardPort = if ($env:PORT) { [int]$env:PORT } else { 4173 }
$dashboardUrl = "http://127.0.0.1:$dashboardPort/"

function Test-Dashboard {
    try {
        $response = Invoke-WebRequest -Uri $dashboardUrl -UseBasicParsing -TimeoutSec 2
        return $response.StatusCode -eq 200 -and $response.Content.Contains('<title>GitHub Pulse')
    } catch { return $false }
}

try {
    if (-not (Test-Dashboard)) {
        $nodeCommand = Get-Command node -ErrorAction Stop
        $logDirectory = Join-Path $projectRoot '.scratch'
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
        $errorLog = Join-Path $logDirectory 'dashboard-error.log'
        $serverProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList 'scripts/serve.mjs' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory 'dashboard.log') -RedirectStandardError $errorLog -PassThru
        $ready = $false
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            if (Test-Dashboard) { $ready = $true; break }
            if ($serverProcess.HasExited) { break }
            Start-Sleep -Milliseconds 250
        }
        if (-not $ready) { throw "Dashboard did not start. Check $errorLog (port $dashboardPort may already be in use)." }
    }
    Write-Output "GitHub Pulse is ready: $dashboardUrl"
    if (-not $NoBrowser) { Start-Process $dashboardUrl }
} catch {
    Write-Error "Unable to open GitHub Pulse: $($_.Exception.Message)"
    exit 1
}
