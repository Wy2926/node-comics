@echo off
setlocal
"%~dp0node.exe" autostart disable
set "node_exit=%errorlevel%"
if "%node_exit%"=="0" (echo Automatic logon startup disabled. Use Stop.cmd to stop a running node.) else (echo Disable NOT confirmed. Read the error above.)
pause
exit /b %node_exit%
