@echo off
rem Mantem o servidor sempre de pe: se parar, reinicia em 5 segundos.
cd /d "%~dp0.."
if not exist data mkdir data
:loop
echo [%date% %time%] Iniciando servidor >> data\servidor.log
node server\dist\index.js --producao >> data\servidor.log 2>&1
echo [%date% %time%] Servidor parou. Reiniciando em 5s >> data\servidor.log
timeout /t 5 /nobreak > nul
goto loop
