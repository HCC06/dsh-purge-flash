@echo off
rem dsh-purge-flash one-click installer (all messages come from install.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 pause
if "%1"=="" pause
