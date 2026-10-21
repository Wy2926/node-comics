@echo off
setlocal
"%~dp0node.exe" autostart enable
set "node_exit=%errorlevel%"
if "%node_exit%"=="0" (echo Enabled for this Windows user's next sign-in. This does not start the node now.) else (echo Enable failed. Complete Start.cmd setup first and read the error above.)
pause
exit /b %node_exit%
