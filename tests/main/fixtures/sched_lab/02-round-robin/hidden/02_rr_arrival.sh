#!/bin/sh
# hidden-marker-rr
check() { if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "not ok - $1"; fi; }

check "rr queues a new arrival before the preempted job" "$(printf '2\na 0 4\nb 1 2\n' | build/rr)" "$(printf 'b 4\na 6')"
