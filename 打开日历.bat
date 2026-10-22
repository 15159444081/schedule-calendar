@echo off
chcp 65001 >nul
title 日程表
curl -s -m 1 http://127.0.0.1:8770/api/ping >nul 2>&1
if errorlevel 1 (
  start "" wscript.exe "%~dp0启动.vbs"
  timeout /t 2 >nul
)
start "" http://127.0.0.1:8770
