$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  throw "node was not found in PATH."
}

$serverScript = Join-Path $root "userscript-server.js"
Start-Process -FilePath $node -ArgumentList @($serverScript) -WorkingDirectory $root -WindowStyle Hidden
Start-Sleep -Milliseconds 500

try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:17830/health" -TimeoutSec 3
  "Waifu2x userscript server started: $($response.Content)"
} catch {
  throw "server start failed: $($_.Exception.Message)"
}
