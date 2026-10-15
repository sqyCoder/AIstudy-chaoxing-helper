@echo off
title Answer Relay 8787
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-relay.ps1"
echo.
echo Relay stopped.
pause
