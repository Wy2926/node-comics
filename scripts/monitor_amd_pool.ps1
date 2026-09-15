param([string]$EngineProcessIds, [string]$OutputPath, [string]$StopPath)
$ErrorActionPreference = 'Stop'
$rootIds = @($EngineProcessIds.Split(',') | ForEach-Object { [int]$_ })
$writer = [IO.StreamWriter]::new($OutputPath, $false, [Text.UTF8Encoding]::new($false))
$previousCpu = 0.0
$previousTime = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0
try {
    while (-not (Test-Path -LiteralPath $StopPath)) {
        $pythonProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'python.exe'")
        # Include both the model and CPU panel worker. Following only the largest
        # child would eventually drop the GPU process after it spawns a helper.
        $trackedIds = @($rootIds)
        do {
            $previousCount = $trackedIds.Count
            $trackedIds = @(@($trackedIds) + @($pythonProcesses |
                Where-Object { $trackedIds -contains [int]$_.ParentProcessId } |
                ForEach-Object { [int]$_.ProcessId }) | Sort-Object -Unique)
        } while ($trackedIds.Count -gt $previousCount)
        $processes = @(Get-Process -Id $trackedIds -ErrorAction SilentlyContinue)
        if (-not $processes.Count) { break }
        $pattern = '^pid_(' + ($trackedIds -join '|') + ')_'
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0
        $cpu = ($processes | ForEach-Object { $_.TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum
        $rawEngines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object Name -match $pattern)
        $engines = @($rawEngines | Group-Object { $_.Name -replace '^pid_\d+_', '' } | ForEach-Object {
            @{ Name = $_.Name; UtilizationPercentage = [Math]::Min(100, ($_.Group | Measure-Object UtilizationPercentage -Sum).Sum) }
        })
        $memory = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory |
            Where-Object Name -match $pattern | Select-Object Name, DedicatedUsage, SharedUsage, TotalCommitted)
        $adapters = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory |
            Select-Object Name, DedicatedUsage, SharedUsage)
        $row = @{
            timestamp = $now; cpu_seconds = $cpu; engine_process_ids = $trackedIds
            cpu_logical_core_percent = 100.0 * ($cpu - $previousCpu) / [Math]::Max(0.001, $now - $previousTime)
            working_set_bytes = ($processes | Measure-Object WorkingSet64 -Sum).Sum
            private_bytes = ($processes | Measure-Object PrivateMemorySize64 -Sum).Sum
            gpu_engines = $engines; gpu_process_memory = $memory; gpu_adapters = $adapters
        }
        $writer.WriteLine(($row | ConvertTo-Json -Depth 5 -Compress)); $writer.Flush()
        $previousCpu = $cpu; $previousTime = $now
        Start-Sleep -Milliseconds 1000
    }
} finally { $writer.Dispose() }
