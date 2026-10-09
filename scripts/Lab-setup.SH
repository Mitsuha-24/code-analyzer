#!/bin/bash
# lab_setup.sh — run once on each Ubuntu lab machine before the session.
# Installs VS Code + extensions for Python, Java, and C/C++, so the same
# image works whichever lab (language) you're assigned.

set -e

echo "== Installing VS Code =="
if ! command -v code &> /dev/null; then
    sudo snap install --classic code
fi

echo "== Installing language extensions =="
code --install-extension ms-python.python          # Python
code --install-extension vscjava.vscode-java-pack  # Java (includes debugger, Maven, etc.)
code --install-extension ms-vscode.cpptools        # C / C++

echo "== Installing your telemetry logger =="
# Update this path to wherever you've put the .vsix on the lab machine (USB/shared folder)
code --install-extension ./lab-telemetry-logger.vsix

echo "Done. Launch VS Code, open a folder, and set telemetryLogger.serverUrl in Settings."

#set Server Url 
cntl+shift+p -> Preferences: Open Settings (JSON) -> add the following line:
"telemetryLogger.serverUrl": "http://localhost:4000/ingest" # for own server or to testing purpose 
"telemetryLogger.serverUrl": "http://<LAN -IP of my laptop>:4000/ingest"  # for shared server
# To retrive ip address of your laptop, run the following command in terminal:
ipconfig

#to delete the extension, run the following command in terminal:
code --uninstall-extension mitsuha24.telemetry-logger

# to delete the data collected by the extension, run the following command in terminal:
Remove-Item "C:\Users\Anushka\AppData\Roaming\Code\User\globalStorage\mitsuha24.telemetry-logger\telemetry_session_log.jsonl"

# to run the server, run the following command in terminal:
 cd "D:\Code analyzer\telemetry-logger\server" 
 node server.js