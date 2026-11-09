param([switch]$InteractiveOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$config = Import-PowerShellDataFile (Join-Path $PSScriptRoot 'sync-task-config.psd1')
$runner = Join-Path $PSScriptRoot 'scheduled-sync.ps1'
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$logonType = if ($InteractiveOnly) { 'Interactive' } else { 'S4U' }
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType $logonType -RunLevel Limited
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -ScheduleRevision $($config.Revision)" -WorkingDirectory $projectRoot
$times = $config.Times
$triggers = @($times | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ })
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 55) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
try { $null = $service.GetFolder($config.Path.TrimEnd('\')) }
catch { $null = $service.GetFolder('\').CreateFolder($config.Path.Trim('\')) }
$task = Register-ScheduledTask -TaskName $config.Name -TaskPath $config.Path -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description '每日八轮，间隔至少65分钟；08:05、09:10、10:15补当期历史，末轮判断覆盖是否完成；预检容量并限制新增候选；S4U注销后运行。' -Force
$logDirectory = Join-Path $projectRoot '.scratch/scheduled-sync'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$definition = Export-ScheduledTask -InputObject $task
$definition | Set-Content -LiteralPath (Join-Path $logDirectory 'task-definition.xml') -Encoding UTF8
$health = & (Join-Path $PSScriptRoot 'check-sync-task.ps1') -AllowInteractive:$InteractiveOnly
$health | Set-Content -LiteralPath (Join-Path $logDirectory 'task-registration.json') -Encoding UTF8
$legacy = Get-ScheduledTask -TaskName $config.LegacyName -TaskPath '\' -ErrorAction SilentlyContinue
if ($legacy) {
    $backup = Join-Path $logDirectory 'task-definition-legacy-before-migration.xml'
    if (-not (Test-Path -LiteralPath $backup)) { Export-ScheduledTask -InputObject $legacy | Set-Content -LiteralPath $backup -Encoding UTF8 }
    $legacy | Disable-ScheduledTask | Out-Null
}
$info = Get-ScheduledTaskInfo -InputObject $task
[PSCustomObject]@{Name=$task.TaskName;Path=$task.TaskPath;State=[string]$task.State;LogonType=$logonType;Times=$times;NextRun=$info.NextRunTime} | ConvertTo-Json -Compress
