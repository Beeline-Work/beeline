$ErrorActionPreference = 'Stop'
$bundle = 'apps/mobile/src-tauri/target/x86_64-pc-windows-msvc/release/bundle'
$installer = Get-ChildItem -Path $bundle -Filter '*.exe' -File -Recurse | Select-Object -First 1
if (-not $installer) { throw 'No Windows NSIS installer was built' }
Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait
$programs = Join-Path $env:LOCALAPPDATA 'Programs'
$app = Get-ChildItem -Path $programs -Filter 'Beeline Preview.exe' -File -Recurse | Select-Object -First 1
if (-not $app) { throw 'The installed Beeline Preview executable was not found' }
$env:BEELINE_DESKTOP_NOTIFICATION_PROOF = '1'
Start-Process -FilePath $app.FullName
Start-Sleep -Seconds 7
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
