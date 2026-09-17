@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "ROOT=%CD%"
set "DIST_ROOT=%ROOT%\dist"
set "DIST=%DIST_ROOT%\BlueSPite-Portable"
set "ZIP_FILE=%DIST_ROOT%\BlueSPite-Portable.zip"

echo ============================================================
echo  BlueSPite portable builder
echo ============================================================
echo.

where node.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required only on this build PC.
  echo         The person using the portable build will not need Node.js.
  pause
  exit /b 1
)

for /f "delims=" %%I in ('where node.exe') do if not defined NODE_EXE set "NODE_EXE=%%I"
for /f "delims=" %%I in ('node.exe -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%I"
if not defined NODE_MAJOR (
  echo [ERROR] Could not read the installed Node.js version.
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 20 (
  echo [ERROR] Node.js 20 or newer is required on this build PC. Found Node.js %NODE_MAJOR%.
  pause
  exit /b 1
)

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [ERROR] The Windows C# compiler was not found.
  echo         Enable/install .NET Framework 4.x on this build PC and try again.
  pause
  exit /b 1
)

if not exist "%ROOT%\tools\PortableLauncher.cs" (
  echo [ERROR] Missing tools\PortableLauncher.cs
  pause
  exit /b 1
)
if not exist "%ROOT%\server\server.mjs" (
  echo [ERROR] Run this file from the BlueSPite project root.
  pause
  exit /b 1
)

echo [1/6] Preparing a clean output folder...
if exist "%DIST%" rmdir /s /q "%DIST%"
if exist "%ZIP_FILE%" del /q "%ZIP_FILE%"
mkdir "%DIST%\runtime" || goto :build_failed
mkdir "%DIST%\app" || goto :build_failed
mkdir "%DIST%\data" || goto :build_failed
mkdir "%DIST%\Generated Media" || goto :build_failed

echo [2/6] Copying the private Node.js runtime...
copy /y "%NODE_EXE%" "%DIST%\runtime\node.exe" >nul || goto :build_failed

echo [3/6] Copying BlueSPite application files...
xcopy "%ROOT%\server" "%DIST%\app\server\" /e /i /y /q >nul || goto :build_failed
xcopy "%ROOT%\shared" "%DIST%\app\shared\" /e /i /y /q >nul || goto :build_failed
xcopy "%ROOT%\web" "%DIST%\app\web\" /e /i /y /q >nul || goto :build_failed
xcopy "%ROOT%\extension" "%DIST%\extension\" /e /i /y /q >nul || goto :build_failed
copy /y "%ROOT%\package.json" "%DIST%\app\package.json" >nul || goto :build_failed

echo [4/6] Building BlueSPite.exe launcher...
"%CSC%" /nologo /target:exe /platform:anycpu /optimize+ /out:"%DIST%\BlueSPite.exe" "%ROOT%\tools\PortableLauncher.cs"
if errorlevel 1 goto :build_failed

(
  echo BLUESPITE PORTABLE - START HERE
  echo ========================================
  echo.
  echo 1. Extract the whole BlueSPite-Portable folder before using it.
  echo 2. Double-click BlueSPite.exe. No Node.js or installer is required.
  echo 3. Keep runtime, app, and extension beside BlueSPite.exe.
  echo.
  echo CHROME EXTENSION - FIRST TIME ONLY
  echo 1. Open chrome://extensions in Chrome.
  echo 2. Turn on Developer mode.
  echo 3. Click Load unpacked and choose this package's extension folder.
  echo 4. Keep Chrome open, then run BlueSPite.exe.
  echo.
  echo PORTABLE DATA
  echo - Settings/history are saved in the data folder.
  echo - Generated images/videos are saved in the Generated Media folder.
  echo - Copy the whole folder to move the app and its data to another PC.
) > "%DIST%\START HERE.txt"

echo [5/6] Verifying the portable server starts...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$env:BLUESPITE_DATA_DIR='%DIST%\data'; $env:BLUESPITE_MEDIA_DIR='%DIST%\Generated Media'; $p=Start-Process -FilePath '%DIST%\runtime\node.exe' -ArgumentList ('\"%DIST%\app\server\server.mjs\"') -WorkingDirectory '%DIST%\app' -WindowStyle Hidden -RedirectStandardOutput '%DIST_ROOT%\portable-test-out.log' -RedirectStandardError '%DIST_ROOT%\portable-test-error.log' -PassThru; try { $ok=$false; 1..40 | ForEach-Object { if ($p.HasExited) { break }; 24242..24251 | ForEach-Object { try { $r=Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $_ + '/') -TimeoutSec 1; if ($r.Content -match 'BlueSPite') { $ok=$true } } catch {} }; if ($ok) { break }; Start-Sleep -Milliseconds 200 }; if (-not $ok) { exit 1 } } finally { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } }"
if errorlevel 1 (
  echo [ERROR] Portable server verification failed.
  echo         See dist\portable-test-out.log and portable-test-error.log
  goto :build_failed
)
del /q "%DIST_ROOT%\portable-test-out.log" >nul 2>nul
del /q "%DIST_ROOT%\portable-test-error.log" >nul 2>nul
del /q "%DIST%\data\bluespite.json" >nul 2>nul

echo [6/6] Creating BlueSPite-Portable.zip...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -LiteralPath '%DIST%' -DestinationPath '%ZIP_FILE%' -CompressionLevel Optimal -Force"
if errorlevel 1 goto :build_failed

echo.
echo ============================================================
echo  BUILD COMPLETE
echo  Folder: %DIST%
echo  ZIP:    %ZIP_FILE%
echo ============================================================
echo.
echo Send BlueSPite-Portable.zip to the other user.
pause
exit /b 0

:build_failed
echo.
echo [ERROR] Portable build failed.
echo Check the message above, then run build_portable.bat again.
pause
exit /b 1
