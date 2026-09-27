@echo off
rem Abre o MODO DEMONSTRACAO para treinar a equipe (dados de teste, banco separado).
cd /d "%~dp0.."
set ENV_FILE=%CD%\.env.demo
echo Recriando os dados de demonstracao...
node server\dist\scripts\demo.js
start "" cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:3011"
echo.
echo Demonstracao rodando em http://localhost:3011  (tablet: http://IP-DESTE-COMPUTADOR:3011/cozinha)
echo Logins: admin / caixa / cozinha - senha 1234
echo Feche esta janela para encerrar a demonstracao.
echo.
node server\dist\index.js
