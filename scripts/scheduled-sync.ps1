param(
    [datetime]$ScheduledTime = (Get-Date),
    [switch]$PlanOnly,
    [switch]$VerifyConnection
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
# 计划任务进程可能继承旧环境，显式读取用户当前凭据；不写入参数或日志。
if (-not $env:GITHUB_TOKEN) {
    $env:GITHUB_TOKEN = [Environment]::GetEnvironmentVariable('GITHUB_TOKEN', 'User')
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$fullBatch = $ScheduledTime.Hour -ge 5 -and $ScheduledTime.Hour -le 8
$collectorArgs = @((Join-Path $PSScriptRoot 'sync-github-data.mjs'))
if ($fullBatch) {
    $collectorArgs += @('--limit', '3000', '--budget', '4600', '--discovery-pages', '2')
    if ($ScheduledTime.DayOfWeek -eq [DayOfWeek]::Monday -and $ScheduledTime.Hour -eq 6) {
        $collectorArgs += @('--harvest', '--harvest-min', '1000')
    }
} else {
    $collectorArgs += @('--no-discover', '--limit', '300', '--budget', '450')
}
$collectorArgs += @('--translate-limit', '250')
if ($PlanOnly) {
    [PSCustomObject]@{Time=$ScheduledTime.ToString('HH:mm'); FullBatch=$fullBatch; Node=$nodePath; Arguments=$collectorArgs; TokenAvailable=[bool]$env:GITHUB_TOKEN} | ConvertTo-Json -Compress
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
$outputLog = Join-Path $logDirectory "$stamp.log"
$errorLog = Join-Path $logDirectory "$stamp-error.log"
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
