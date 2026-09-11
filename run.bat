@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Agent Loop Orchestrator

set "PORTABLE_DIR="
for /d %%D in ("%~dp0artifacts\desktop\AgentLoopOrchestrator-*-win32-x64") do (
    if exist "%%~fD\agent-loop-orchestrator.exe" set "PORTABLE_DIR=%%~fD"
)

if not defined PORTABLE_DIR (
    echo Portable desktop build not found. Building it now...
    where npm >nul 2>&1
    if errorlevel 1 (
        echo Node.js and npm are required to build the desktop executable.
        pause
        exit /b 1
    )

    call npm run package:desktop
    if errorlevel 1 (
        echo Desktop build failed.
        pause
        exit /b 1
    )

    for /d %%D in ("%~dp0artifacts\desktop\AgentLoopOrchestrator-*-win32-x64") do (
        if exist "%%~fD\agent-loop-orchestrator.exe" set "PORTABLE_DIR=%%~fD"
    )
)

if not defined PORTABLE_DIR (
    echo Portable desktop executable was not generated.
    pause
    exit /b 1
)

pushd "%PORTABLE_DIR%" >nul
if errorlevel 1 (
    echo Could not enter the portable application directory.
    pause
    exit /b 1
)

start "" "%PORTABLE_DIR%\agent-loop-orchestrator.exe" %*
set "START_ERROR=%ERRORLEVEL%"
popd

if not "%START_ERROR%"=="0" (
    echo Could not start Agent Loop Orchestrator.
    pause
    exit /b %START_ERROR%
)

endlocal
exit /b 0
