param([switch]$InteractiveOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'scheduled-sync.ps1'
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$logonType = if ($InteractiveOnly) { 'Interactive' } else { 'S4U' }
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType $logonType -RunLevel Limited
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`"" -WorkingDirectory $projectRoot
$times = @('05:13', '06:13', '07:13', '08:13', '09:13', '13:13', '17:13', '21:13')
$triggers = @($times | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ })
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 55) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$task = Register-ScheduledTask -TaskName 'GitHub Pulse 每日同步与翻译' -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description '上海时间每天八轮；优先补齐当期官方历史，随后早间全量或日间热榜采集，再补新候选。每轮共享4600次请求预算，记录覆盖率；使用现有用户凭据。' -Force
$info = Get-ScheduledTaskInfo -InputObject $task
[PSCustomObject]@{Name=$task.TaskName;State=[string]$task.State;LogonType=$logonType;Times=$times;NextRun=$info.NextRunTime} | ConvertTo-Json -Compress
