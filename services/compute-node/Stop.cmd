@echo off
setlocal
"%~dp0node.exe" stop
set "node_exit=%errorlevel%"
if "%node_exit%"=="0" (echo Stopped. No node compute process remains.) else (echo Stop NOT confirmed. Read the error above.)
pause
exit /b %node_exit%
