@echo off
setlocal
cd /d "%~dp0"

if /I "%~1"=="server" (
  if not defined PRISMATIC_PNPM (
    echo [PRISMATIC] The package manager was not passed to the server process.
    exit /b 1
  )
  call "%PRISMATIC_PNPM%" dev
  exit /b %errorlevel%
)

echo [PRISMATIC] Releasing port 4100...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":4100 .*LISTENING"') do taskkill /F /PID %%P >nul 2>&1

set "BUNDLED_PNPM=C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
if exist "%BUNDLED_PNPM%" (
  set "PRISMATIC_PNPM=%BUNDLED_PNPM%"
  set "PATH=C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;%PATH%"
) else (
  where pnpm >nul 2>&1 || (
    echo [PRISMATIC] pnpm was not found. Install Node.js 22+ and pnpm, then try again.
    pause
    exit /b 1
  )
  set "PRISMATIC_PNPM=pnpm.cmd"
)

if not exist "node_modules" (
  echo [PRISMATIC] Installing project dependencies...
  call "%PRISMATIC_PNPM%" install || exit /b 1
)
if not exist "remotion\node_modules" call "%PRISMATIC_PNPM%" --dir remotion install || exit /b 1
if not exist "hyperframes\node_modules" call "%PRISMATIC_PNPM%" --dir hyperframes install || exit /b 1

echo [PRISMATIC] Starting on http://localhost:4100
start "PRISMATIC" /D "%~dp0" cmd /k call "%~f0" server
powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(30); while((Get-Date)-lt $deadline){try{Invoke-WebRequest -UseBasicParsing http://localhost:4100/api/health | Out-Null; exit 0}catch{Start-Sleep -Milliseconds 500}}; exit 1"
if errorlevel 1 (
  echo [PRISMATIC] The server did not become ready. Check the PRISMATIC window for details.
  pause
  exit /b 1
)
start "" http://localhost:4100
endlocal
