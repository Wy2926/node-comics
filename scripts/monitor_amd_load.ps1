param([int]$EngineProcessId, [string]$OutputPath, [string]$StopPath)
$ErrorActionPreference = 'Stop'
$writer = [IO.StreamWriter]::new($OutputPath, $false, [Text.UTF8Encoding]::new($false))
$previousCpu = 0.0
$previousTime = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0
try {
    while (-not (Test-Path -LiteralPath $StopPath)) {
        # A Windows venv python.exe can be a small redirector whose child owns
        # the actual model and GPU allocations. Follow that process lineage.
        $descendants = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $EngineProcessId" |
            Where-Object Name -eq 'python.exe' | Sort-Object {[long]$_.WorkingSetSize} -Descending)
        if ($descendants.Count) { $EngineProcessId = [int]$descendants[0].ProcessId; $previousCpu = 0.0 }
        $process = Get-Process -Id $EngineProcessId -ErrorAction SilentlyContinue
        if (-not $process) { break }
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0
        $cpu = $process.TotalProcessorTime.TotalSeconds
        $engines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine |
            Where-Object Name -like "pid_${EngineProcessId}_*" |
            Select-Object Name, UtilizationPercentage)
        $memory = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory |
            Where-Object Name -like "pid_${EngineProcessId}_*" |
            Select-Object Name, DedicatedUsage, SharedUsage, TotalCommitted)
        $adapters = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory |
            Select-Object Name, DedicatedUsage, SharedUsage)
        $row = @{
            timestamp = $now; cpu_seconds = $cpu; engine_process_id = $EngineProcessId
            cpu_logical_core_percent = 100.0 * ($cpu - $previousCpu) / [Math]::Max(0.001, $now - $previousTime)
            working_set_bytes = $process.WorkingSet64; private_bytes = $process.PrivateMemorySize64
            gpu_engines = $engines; gpu_process_memory = $memory; gpu_adapters = $adapters
        }
        $writer.WriteLine(($row | ConvertTo-Json -Depth 5 -Compress))
        $writer.Flush()
        $previousCpu = $cpu
        $previousTime = $now
        Start-Sleep -Milliseconds 1000
    }
} finally { $writer.Dispose() }
