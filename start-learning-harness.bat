@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
where powershell.exe >nul 2>nul
if errorlevel 1 (
	>&2 echo powershell.exe not found. Run start-learning-harness.ps1 with PowerShell.
	exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-learning-harness.ps1" %*
exit /b %ERRORLEVEL%
