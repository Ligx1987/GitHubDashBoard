param(
    [datetime]$ScheduledTime = (Get-Date),
    [switch]$PlanOnly,
    [switch]$VerifyConnection,
    [string]$ScheduleRevision = '',
    [switch]$RecoveryWatch
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$config = Import-PowerShellDataFile (Join-Path $PSScriptRoot 'sync-task-config.psd1')
if (-not $PlanOnly -and -not $VerifyConnection -and $ScheduleRevision -ne $config.Revision) {
    $directory = Join-Path $projectRoot '.scratch/scheduled-sync'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $entry = [PSCustomObject]@{at=(Get-Date).ToUniversalTime().ToString('o');stage='skipped';reason='retired-task-definition';requests=0} | ConvertTo-Json -Compress
    Add-Content -LiteralPath (Join-Path $directory 'retired-entry.jsonl') -Value $entry -Encoding UTF8
    Write-Output $entry
    exit 0
}
# 计划任务进程可能继承旧环境，显式读取用户当前凭据；不写入参数或日志。
if (-not $env:GITHUB_TOKEN) {
    $env:GITHUB_TOKEN = [Environment]::GetEnvironmentVariable('GITHUB_TOKEN', 'User')
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$fullBatch = $ScheduledTime.Hour -lt 6
$collectorArgs = @((Join-Path $PSScriptRoot 'sync-scheduled.mjs'))
if ($RecoveryWatch) {
    $fullBatch = $false
    $collectorArgs += @('--watch')
} elseif ($fullBatch) {
    $collectorArgs += @('--profile', 'full')
    if ($ScheduledTime.DayOfWeek -eq [DayOfWeek]::Monday -and $ScheduledTime.Hour -eq 2) {
        $collectorArgs += @('--harvest')
    }
} else {
    $collectorArgs += @('--profile', 'hot')
}
$translationLimit = if ($RecoveryWatch) { '0' } else { '250' }
$collectorArgs += @('--budget', '4600', '--translate-limit', $translationLimit)
$collectorArgs += @('--regular-times', ($config.Times -join ','))
$historyTimes = @($config.Times | Where-Object { [int]$_.Split(':')[0] -ge 8 })
if ($historyTimes.Count) { $collectorArgs += @('--history-times', ($historyTimes -join ',')) }
if ($null -ne $config.MaxNewPerRound) { $collectorArgs += @('--max-new-per-round', [string]$config.MaxNewPerRound) }
if ($PlanOnly) {
    [PSCustomObject]@{Time=$ScheduledTime.ToString('HH:mm'); FullBatch=$fullBatch; HistoryBackfill=$true; Node=$nodePath; Arguments=$collectorArgs; TokenAvailable=[bool]$env:GITHUB_TOKEN} | ConvertTo-Json -Compress
    exit 0
}
if ($VerifyConnection) {
    # 只检查计划任务身份下的网络与凭据，不触发采集或修改数据。
    'const r=await fetch("https://api.github.com/rate_limit",{headers:{Accept:"application/vnd.github+json",...(process.env.GITHUB_TOKEN?{Authorization:"Bearer "+process.env.GITHUB_TOKEN}:{})},signal:AbortSignal.timeout(20000)});const p=await r.json();console.log(JSON.stringify({status:r.status,tokenAvailable:!!process.env.GITHUB_TOKEN,coreLimit:p.resources?.core?.limit}));if(!r.ok||!process.env.GITHUB_TOKEN)process.exitCode=1;' | & $nodePath --input-type=module
    exit $LASTEXITCODE
}
$logDirectory = Join-Path $projectRoot '.scratch/scheduled-sync'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$prefix = if ($RecoveryWatch) { "$stamp-watch" } else { $stamp }
$outputLog = Join-Path $logDirectory "$prefix.log"
$errorLog = Join-Path $logDirectory "$prefix-error.log"
$quotedArgs = @('"' + $collectorArgs[0] + '"') + $collectorArgs[1..($collectorArgs.Length - 1)]
$child = Start-Process -FilePath $nodePath -ArgumentList $quotedArgs -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru
try {
    $null = $child.Handle
    $child.WaitForExit()
    $child.Refresh()
    if ($null -eq $child.ExitCode) { throw '无法读取采集器退出状态' }
    exit $child.ExitCode
} finally {
    if (-not $child.HasExited) { Stop-Process -Id $child.Id }
}
