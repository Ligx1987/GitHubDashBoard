param([switch]$AllowInteractive, [switch]$RequireCoverage)

$ErrorActionPreference = 'Stop'
$config = Import-PowerShellDataFile (Join-Path $PSScriptRoot 'sync-task-config.psd1')
$task = Get-ScheduledTask -TaskName $config.Name -TaskPath $config.Path -ErrorAction Stop
[xml]$definition = Export-ScheduledTask -InputObject $task
$triggers = @($definition.Task.Triggers.ChildNodes)
if ($triggers.Count -ne 8) { throw '每日同步任务必须有八个触发器' }
$minutes = @()
foreach ($trigger in $triggers) {
    if ($trigger.LocalName -ne 'CalendarTrigger' -or $trigger.ScheduleByDay.DaysInterval -ne '1') { throw '触发器必须每天重复' }
    if ($trigger.Enabled -eq 'false' -or $trigger.EndBoundary) { throw '触发器不能禁用或设置结束日期' }
    $time = [datetimeoffset]::Parse($trigger.StartBoundary).ToOffset([timespan]::FromHours(8))
    $minutes += $time.Hour * 60 + $time.Minute
}
$minutes = @($minutes | Sort-Object)
$gaps = @(for ($i = 1; $i -lt $minutes.Count; $i++) { $minutes[$i] - $minutes[$i - 1] })
$gaps += 1440 + $minutes[0] - $minutes[-1]
$minimumGap = ($gaps | Measure-Object -Minimum).Minimum
if ($minimumGap -lt 65) { throw '轮次间隔必须至少65分钟' }
$actualTimes = @($minutes | ForEach-Object { '{0:00}:{1:00}' -f [math]::Floor($_ / 60), ($_ % 60) })
if (($actualTimes -join ',') -ne ($config.Times -join ',')) { throw '实际触发时段与新版配置不一致' }
if (-not $AllowInteractive -and [string]$task.Principal.LogonType -ne 'S4U') { throw '任务必须允许注销后运行（S4U）' }
if ($definition.Task.Actions.Exec.Arguments -notmatch ('-ScheduleRevision\s+' + [regex]::Escape($config.Revision) + '(\s|$)')) { throw '任务缺少新版入口标识' }
if ($definition.Task.Settings.Enabled -eq 'false') { throw '任务已禁用' }
if ($definition.Task.Settings.DeleteExpiredTaskAfter) { throw '任务不能设置过期自动删除' }
$info = Get-ScheduledTaskInfo -InputObject $task
$watch = Get-ScheduledTask -TaskName $config.RecoveryName -TaskPath $config.Path -ErrorAction Stop
[xml]$watchDefinition = Export-ScheduledTask -InputObject $watch
$watchTriggers = @($watchDefinition.Task.Triggers.ChildNodes)
if ($watchTriggers.Count -ne 1 -or $watchTriggers[0].LocalName -ne 'CalendarTrigger' -or
    $watchTriggers[0].ScheduleByDay.DaysInterval -ne '1' -or
    $watchTriggers[0].Repetition.Interval -ne "PT$($config.RecoveryIntervalMinutes)M" -or
    $watchTriggers[0].Repetition.Duration -ne 'P1D' -or $watchTriggers[0].EndBoundary -or
    $watchTriggers[0].Enabled -eq 'false' -or [string]$watch.State -eq 'Disabled' -or
    $watchDefinition.Task.Settings.DeleteExpiredTaskAfter -or
    $watchDefinition.Task.Actions.Exec.Arguments -notmatch '-RecoveryWatch' -or
    $watchDefinition.Task.Actions.Exec.Arguments -notmatch '-ScheduleRevision\s+v2(\s|$)') { throw '覆盖守护任务配置无效' }
if (-not $AllowInteractive -and [string]$watch.Principal.LogonType -ne 'S4U') { throw '覆盖守护必须使用S4U' }
$watchInfo = Get-ScheduledTaskInfo -InputObject $watch
$statusPath = Join-Path (Split-Path -Parent $PSScriptRoot) '.scratch/scheduled-sync/latest-status.json'
$coverage = $null
if (Test-Path -LiteralPath $statusPath) {
    $latest = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $coverage = [PSCustomObject]@{At=$latest.at;Status=$latest.status;Complete=$latest.coverageComplete;
        Pending=$latest.completion.pending;Cooldown=$latest.completion.cooldownPending;
        QueuedCandidates=$latest.completion.queuedCandidates;Capacity=$latest.capacityAfter.capacityStatus;
        RequiredWindows=$latest.capacityAfter.requiredWindows;FinalRound=$latest.finalHistoryRound}
}
$dailyPath = Join-Path (Split-Path -Parent $PSScriptRoot) '.scratch/scheduled-sync/daily-state.json'
$daily = $null
if (Test-Path -LiteralPath $dailyPath) { $daily = Get-Content -LiteralPath $dailyPath -Raw -Encoding UTF8 | ConvertFrom-Json }
if ($RequireCoverage -and -not $daily -and (-not $coverage -or -not $coverage.Complete -or
    ([datetimeoffset]::Parse($coverage.At).UtcDateTime.Date -ne (Get-Date).ToUniversalTime().Date))) { throw '当期历史未确认补齐，请检查latest-status.json和coverage.jsonl' }
if ($RequireCoverage -and $daily -and (-not $daily.complete -or
    ([datetimeoffset]::Parse($daily.target).UtcDateTime.Date -ne (Get-Date).ToUniversalTime().Date))) { throw '每日验收未通过，请检查daily-state.json' }
[PSCustomObject]@{
    CheckedAt = (Get-Date).ToString('o')
    Name = $task.TaskName
    Path = $task.TaskPath
    Revision = $config.Revision
    State = [string]$task.State
    Daily = $true
    DaysInterval = 1
    Times = $actualTimes
    MinimumGapMinutes = $minimumGap
    Expires = $false
    LogonType = [string]$task.Principal.LogonType
    UserId = $task.Principal.UserId
    LastRun = $info.LastRunTime.ToString('o')
    LastResult = $info.LastTaskResult
    NextRun = $info.NextRunTime.ToString('o')
    Coverage = $coverage
    DailyState = if ($daily) { [PSCustomObject]@{Target=$daily.target;Status=$daily.status;Complete=$daily.complete;
        HistoryComplete=$daily.historyComplete;MetadataComplete=$daily.metadataComplete;Metadata=$daily.metadata;
        Pending=$daily.pending;AttemptCount=$daily.attemptCount;NextRun=$daily.nextRunAt;Overdue=$daily.overdue} } else { $null }
    Watchdog = [PSCustomObject]@{Name=$watch.TaskName;State=[string]$watch.State;LogonType=[string]$watch.Principal.LogonType;
        IntervalMinutes=$config.RecoveryIntervalMinutes;LastRun=$watchInfo.LastRunTime.ToString('o');
        LastResult=$watchInfo.LastTaskResult;NextRun=$watchInfo.NextRunTime.ToString('o')}
} | ConvertTo-Json -Compress
