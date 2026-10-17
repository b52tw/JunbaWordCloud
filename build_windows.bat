@echo off
chcp 65001 >nul
cd /d "%~dp0"
where go >nul 2>nul
if errorlevel 1 (
 echo 請先安裝 Go 1.25 或更新版本。此程式目標為 Windows 10 或更新版本。
 pause
 exit /b 1
)
set CGO_ENABLED=0
set GOOS=windows
set GOARCH=amd64
go build -mod=vendor -buildvcs=false -trimpath -ldflags="-s -w" -o ..\JunbaWordCloud_v1.1_Win64.exe .
if errorlevel 1 exit /b 1
set GOARCH=386
go build -mod=vendor -buildvcs=false -trimpath -ldflags="-s -w" -o ..\JunbaWordCloud_v1.1_Win32.exe .
if errorlevel 1 exit /b 1
echo 已完成 64 與 32 位元版，兩者皆不支援 XP。
pause
