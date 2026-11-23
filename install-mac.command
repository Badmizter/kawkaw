#!/bin/bash
# Double-click on macOS to install KawKaw
bash "$(dirname "$0")/installer/install-mac.sh"
read -n 1 -s -r -p "Press any key to close"
