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

# The Windows Server base image these runners use ships with the toast master
# switch off, which silently drops every app's toast regardless of that app's
# own notification settings.
New-Item -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\PushNotifications' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\PushNotifications' -Name 'ToastEnabled' -Value 1 -Type DWord

$env:BEELINE_DESKTOP_NOTIFICATION_PROOF = '1'
$process = Start-Process -FilePath $app.FullName -PassThru
Start-Sleep -Seconds 2
$process.Refresh()
Add-Type -Namespace BeelineProof -Name NativeWindow -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);'
if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
  [BeelineProof.NativeWindow]::ShowWindow($process.MainWindowHandle, 6) | Out-Null
} else {
  (New-Object -ComObject Shell.Application).MinimizeAll()
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Screenshot presence alone never proved the toast rendered, only that a
# screenshot was taken. Run the same "read the pixels" verification the macOS
# capture does (there via Vision), here via the built-in Windows OCR engine,
# so this script and its macOS sibling hold the fixture to the same bar. This
# WinRT accelerator syntax (`ContentType = WindowsRuntime`) needs the .NET
# Framework runtime Windows PowerShell hosts; this script is invoked with
# `powershell.exe`, not `pwsh`, specifically so it works.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Wait-WinRtTask($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
$ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $ocrEngine) { throw 'No OCR engine is available for the runner locale' }

function Get-OcrText([string]$ImagePath) {
  $file = Wait-WinRtTask ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
  $stream = Wait-WinRtTask ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Wait-WinRtTask ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Wait-WinRtTask ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Wait-WinRtTask ($ocrEngine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $result.Text
}

# The fixture fires its notification 5s after launch, and a Windows toast is
# only visible for a few seconds before it moves into Action Center. Poll for
# it instead of gambling on a single capture instant.
$path = Join-Path $env:RUNNER_TEMP 'desktop-native-notification-windows.png'
$found = $false
$lastText = ''
for ($i = 0; $i -lt 8; $i++) {
  Start-Sleep -Seconds 1
  if ($process.HasExited) { throw "Beeline Preview exited before capture with status $($process.ExitCode)" }
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
  if ((Get-Item $path).Length -eq 0) { throw 'The desktop screenshot is empty' }
  $lastText = Get-OcrText $path
  if ($lastText -like '*Safe test fixture*') { $found = $true; break }
}
Write-Host "Visible desktop text: $lastText"
if (-not $found) { throw 'Native fixture notification is not visible in the Windows screenshot' }
