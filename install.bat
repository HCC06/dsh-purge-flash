@echo off
rem dsh-purge-flash one-click installer. All messages come from install.ps1.
rem Unblock-File: a file downloaded from the internet carries a Zone.Identifier mark
rem and PowerShell refuses to run it. This clears the mark, then runs it.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Unblock-File -LiteralPath '%~dp0install.ps1' -ErrorAction SilentlyContinue; & '%~dp0install.ps1' %*"
if errorlevel 1 pause
if "%~1"=="" pause
