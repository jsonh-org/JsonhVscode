@echo off
call cd client
call npm update
call npm install
call cd ..
call cd server
call npm update
call npm install
call cd ..
call npm update
call npm install
pause