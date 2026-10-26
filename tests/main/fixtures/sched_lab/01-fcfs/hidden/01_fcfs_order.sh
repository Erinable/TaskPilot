#!/bin/sh
# hidden-marker-fcfs
check() { if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "not ok - $1"; fi; }

check "fcfs sorts jobs given out of arrival order" "$(printf 'b 2 1\na 0 1\n' | build/fcfs)" "$(printf 'a 1\nb 3')"
