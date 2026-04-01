#!/bin/bash
osascript -e 'tell application "Terminal" to do script "cd '"$PWD"' && source backend/venv/bin/activate && python backend/app.py"'
cd desktop && npm start