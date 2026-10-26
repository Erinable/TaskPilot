#!/bin/sh
# Runs each lab program and prints one TAP line per test. Every program runs
# under a 10 second alarm, so a hang fails its test instead of the grade.
n=0
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
limit() { perl -e 'alarm 10; exec @ARGV or exit 127' "$@"; }
report() {
  n=$((n + 1))
  if [ "$1" -eq 0 ]; then echo "ok $n - $2"; else echo "not ok $n - $2"; fi
}

out=$(limit build/pingpong)
printf '%s\n' "$out" | grep -Eq '^[0-9]+: received ping$' && printf '%s\n' "$out" | sed -n 2p | grep -Eq '^[0-9]+: received pong$'
report $? "pingpong prints ping then pong"

head -c 1048576 /dev/urandom > "$work/in"
limit build/copy "$work/in" "$work/out" && cmp -s "$work/in" "$work/out"
report $? "copy copies a 1 MB file byte for byte"

limit build/copy "$work/missing" "$work/out2" 2>/dev/null
[ $? -eq 1 ]
report $? "copy exits 1 when the source is missing"

[ "$(limit build/counter 8 200000)" = "1600000" ]
report $? "counter adds up across 8 threads"

[ "$(limit build/bbuf 4 50000)" = "1250025000" ]
report $? "bbuf passes every item through the buffer once"
