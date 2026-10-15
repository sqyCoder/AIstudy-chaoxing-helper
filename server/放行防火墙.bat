@echo off
REM Raise UAC and run allow-firewall.ps1 as administrator (one time only).
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0allow-firewall.ps1'"
