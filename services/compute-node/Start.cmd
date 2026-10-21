@echo off
setlocal
"%~dp0node.exe" start
set "node_exit=%errorlevel%"
if not "%node_exit%"=="0" echo Start failed. Read the message above; click Start again to retry preparation.
pause
exit /b %node_exit%
