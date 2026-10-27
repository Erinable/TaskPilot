#!/bin/sh
# Stage 1: first come, first served.
check() { if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "not ok - $1"; fi; }

check "fcfs runs jobs in arrival order" "$(printf 'a 0 3\nb 1 2\n' | build/fcfs)" "$(printf 'a 3\nb 5')"
check "fcfs idles until a late job arrives" "$(printf 'a 0 2\nb 5 1\n' | build/fcfs)" "$(printf 'a 2\nb 6')"
