#!/usr/bin/env bash
# t3-stop.sh <state-dir>: kill the process groups started by t3-serve.sh
for pid in $(cat "$1/pids" 2>/dev/null); do kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null; done; true
