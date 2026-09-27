@echo off
rem Reinicia o sistema (use depois de atualizar os arquivos ou se algo travar).
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
schtasks /End /TN "Happy Alpha" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -like '*server*dist*index.js*' -and $_.CommandLine -like '*--producao*' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }"
schtasks /Run /TN "Happy Alpha"
echo Sistema reiniciado. Aguarde alguns segundos e abra http://localhost:3010
pause
