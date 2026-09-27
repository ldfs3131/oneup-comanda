@echo off
rem Faz um backup manual imediato nas pastas configuradas no .env
cd /d "%~dp0.."
node -e "import('./server/dist/services/backup.js').then(m=>m.runBackup()).then(r=>{for(const x of r)console.log(x.ok?'OK  '+x.file:'ERRO '+x.dir+': '+x.error)})"
pause
