$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtensionManifest = Join-Path $Root "manifest.json"
$ManifestTemplate = Join-Path $Root "native-host\com.yisal.waifu2x.json"
$LocalManifest = Join-Path $Root "native-host\com.yisal.waifu2x.local.json"
$HostProject = Join-Path $Root "native-host\Waifu2xNativeHost.csproj"
$HostExe = Join-Path $Root "native-host\bin\Release\net9.0\win-x64\publish\Waifu2xNativeHost.exe"

if (-not (Test-Path $HostExe)) {
  $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
  if (-not $dotnet) {
    throw "Native host executable not found and dotnet SDK is not installed. Install .NET SDK, then run this script again."
  }

  Write-Host "Publishing native host..."
  & $dotnet.Source publish $HostProject -c Release -r win-x64 --self-contained false | Write-Host
  if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed."
  }
}

if (-not (Test-Path $HostExe)) {
  throw "Native host executable not found after publish: $HostExe"
}

$extensionJson = Get-Content -LiteralPath $ExtensionManifest -Raw | ConvertFrom-Json
if (-not $extensionJson.key) {
  throw "manifest.json does not contain a fixed extension key."
}

$keyBytes = [Convert]::FromBase64String($extensionJson.key)
$sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($keyBytes)
$alphabet = "abcdefghijklmnop"
$builder = New-Object System.Text.StringBuilder
for ($i = 0; $i -lt 16; $i++) {
  [void]$builder.Append($alphabet[[int](($sha[$i] -band 0xF0) -shr 4)])
  [void]$builder.Append($alphabet[[int]($sha[$i] -band 0x0F)])
}
$ExtensionId = $builder.ToString()

$json = Get-Content -LiteralPath $ManifestTemplate -Raw | ConvertFrom-Json
$json.path = (Resolve-Path -LiteralPath $HostExe).Path
$json.allowed_origins = @("chrome-extension://$ExtensionId/")
$json | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $LocalManifest -Encoding ascii

$Key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.yisal.waifu2x"
New-Item -Path $Key -Force | Out-Null
Set-ItemProperty -Path $Key -Name "(default)" -Value $LocalManifest

Write-Host "Registered native host:"
Write-Host $LocalManifest
Write-Host "Host executable: $HostExe"
Write-Host "Allowed origin: chrome-extension://$ExtensionId/"
