$ErrorActionPreference = 'Stop'
$bundle = 'apps/mobile/src-tauri/target/x86_64-pc-windows-msvc/release/bundle'
$installer = Get-ChildItem -Path $bundle -Filter '*.exe' -File -Recurse | Select-Object -First 1
if (-not $installer) { throw 'No Windows NSIS installer was built' }
Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait
$uninstall = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object {
  Get-ItemProperty $_.PSPath
} | Where-Object { $_.DisplayName -like 'Beeline Preview*' } | Select-Object -First 1
$uninstall | Format-List DisplayName, InstallLocation
$roots = @($uninstall.InstallLocation, (Join-Path $env:LOCALAPPDATA 'Programs'), $env:LOCALAPPDATA, $env:ProgramFiles) |
  Where-Object { $_ -and (Test-Path $_) }
$app = $null
foreach ($root in $roots) {
  $app = Get-ChildItem -Path $root -Filter '*beeline*.exe' -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike '*setup*' -and $_.Name -notlike '*uninstall*' } |
    Select-Object -First 1
  if ($app) { break }
}
if (-not $app) { throw 'The installed Beeline Preview executable was not found' }
Write-Host "Installed executable: $($app.FullName)"
$env:BEELINE_DESKTOP_NOTIFICATION_PROOF = '1'
$process = Start-Process -FilePath $app.FullName -PassThru
Start-Sleep -Seconds 7
if ($process.HasExited) { throw "Beeline Preview exited before capture with status $($process.ExitCode)" }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$path = Join-Path $env:RUNNER_TEMP 'desktop-native-notification-windows.png'
$bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
if ((Get-Item $path).Length -eq 0) { throw 'The desktop screenshot is empty' }
