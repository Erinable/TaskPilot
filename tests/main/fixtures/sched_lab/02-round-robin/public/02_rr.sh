#!/bin/sh
# Stage 2: round robin.
check() { if [ "$2" = "$3" ]; then echo "ok - $1"; else echo "not ok - $1"; fi; }

check "rr takes turns within the time slice" "$(printf '2\na 0 3\nb 0 2\n' | build/rr)" "$(printf 'b 4\na 5')"
check "rr runs a single job to completion" "$(printf '4\na 1 6\n' | build/rr)" "$(printf 'a 7')"
