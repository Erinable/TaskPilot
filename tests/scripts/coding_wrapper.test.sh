#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P -- "$(dirname -- "$0")/../.." && pwd -P)"
WRAPPER_SOURCE="$ROOT/scripts/taskpilot-coding-wrapper.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/taskpilot-wrapper-test.XXXXXX")"
trap 'rm -rf -- "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
expect_fail() {
  if "$@" >/dev/null 2>&1; then
    fail "expected failure: $*"
  fi
}

installed="$TMP/installed-wrapper.sh"
cp "$WRAPPER_SOURCE" "$installed"
chmod 755 "$installed"
cmp "$WRAPPER_SOURCE" "$installed" || fail 'installed artifact differs from reviewed wrapper'
bash -n "$installed"

run_root="$TMP/runs"
agent_home="$TMP/agent-home"
mkdir -m 700 "$run_root" "$agent_home"
fake_args="$TMP/fake-args"
fake_env="$TMP/fake-env"
fake_input="$TMP/fake-input"
mkdir -p "$agent_home/.local/bin"
cat >"$TMP/fake-cli" <<FAKE
#!/bin/bash
set -eu
printf '%s\n' "\$#" > "$fake_args"
printf '%s\n' "\$@" >> "$fake_args"
/usr/bin/env > "$fake_env"
/bin/cat > "$fake_input"
FAKE
chmod 755 "$TMP/fake-cli"
for cli in codex claude pi grok opencode; do cp "$TMP/fake-cli" "$agent_home/.local/bin/$cli"; done

config="$TMP/coding-agent.conf"
cat >"$config" <<CONFIG
RUNTIME_POLICY='taskpilot-coding-cli-v1'
RUN_ROOT='$run_root'
AGENT_HOME='$agent_home'
MKDIR_PATH=/bin/mkdir
TAR_PATH=/usr/bin/tar
GIT_PATH=/usr/bin/git
NPM_PATH=/usr/local/bin/npm
RM_PATH=/bin/rm
CAT_PATH=/bin/cat
ENV_PATH=/usr/bin/env
CONFIG

run_wrapper() {
  TASKPILOT_WRAPPER_TEST=1 TASKPILOT_WRAPPER_TEST_CONFIG="$config" MAIN_USER_SECRET='must-not-cross' bash "$installed" "$@"
}

expect_fail run_wrapper
run_wrapper mkdir "$run_root/run-1"
expect_fail run_wrapper mkdir "$run_root/run-1/nested"
expect_fail run_wrapper mkdir "$run_root/../escape"

expect_fail run_wrapper model-config pi
expect_fail run_wrapper model-config pi arbitrary-file
expect_fail run_wrapper model-config unknown primary
[[ -z "$(run_wrapper model-config pi primary)" ]] || fail 'missing native config was not empty'
mkdir -p "$agent_home/.pi/agent"
printf '{"providers":{}}' > "$agent_home/.pi/agent/models.json"
[[ "$(run_wrapper model-config pi primary)" == '{"providers":{}}' ]] || fail 'native config was not read from dedicated HOME'
rm "$agent_home/.pi/agent/models.json"
printf 'not-dedicated-config' > "$TMP/external-config"
ln -s "$TMP/external-config" "$agent_home/.pi/agent/models.json"
expect_fail run_wrapper model-config pi primary
rm "$agent_home/.pi/agent/models.json"
rmdir "$agent_home/.pi/agent"
ln -s "$TMP" "$agent_home/.pi/agent"
printf '{}' > "$TMP/models.json"
expect_fail run_wrapper model-config pi primary
rm "$agent_home/.pi/agent"
mkdir "$agent_home/.pi/agent"
/bin/dd if=/dev/zero of="$agent_home/.pi/agent/models.json" bs=4194305 count=1 2>/dev/null
expect_fail run_wrapper model-config pi primary
rm "$agent_home/.pi/agent/models.json"

source="$TMP/source"
mkdir -p "$source"
cd "$source"
/usr/bin/git init --quiet
/usr/bin/git config user.name test
/usr/bin/git config user.email test@example.invalid
printf 'baseline\n' >README.md
/usr/bin/git add README.md
/usr/bin/git commit --quiet -m baseline
archive="$TMP/baseline.tar"
/usr/bin/git archive HEAD >"$archive"
cat "$archive" | run_wrapper extract "$run_root/run-1"
run_wrapper init "$run_root/run-1"
printf 'changed\n' >"$run_root/run-1/README.md"
patch="$(run_wrapper diff "$run_root/run-1")"
grep -q 'changed' <<<"$patch" || fail 'diff did not contain the changed file'
ln -s "$run_root/run-1" "$run_root/run-link"
expect_fail run_wrapper diff "$run_root/run-link"

bad_source="$TMP/bad-source"
mkdir -p "$bad_source"
ln -s /tmp "$bad_source/escape-link"
bad_archive="$TMP/bad.tar"
/usr/bin/tar -cf "$bad_archive" -C "$bad_source" escape-link
run_wrapper mkdir "$run_root/run-2"
expect_fail bash -c 'TASKPILOT_WRAPPER_TEST=1 TASKPILOT_WRAPPER_TEST_CONFIG="$1" MAIN_USER_SECRET=bad bash "$2" extract "$3" < "$4"' bash "$config" "$installed" "$run_root/run-2" "$bad_archive"
hard_source="$TMP/hard-source"
mkdir -p "$hard_source"
printf 'same\n' >"$hard_source/original"
ln "$hard_source/original" "$hard_source/hardlink"
hard_archive="$TMP/hard.tar"
/usr/bin/tar -cf "$hard_archive" -C "$hard_source" original hardlink
run_wrapper mkdir "$run_root/run-3"
expect_fail bash -c 'TASKPILOT_WRAPPER_TEST=1 TASKPILOT_WRAPPER_TEST_CONFIG="$1" bash "$2" extract "$3" < "$4"' bash "$config" "$installed" "$run_root/run-3" "$hard_archive"

traversal_source="$TMP/traversal-source"
mkdir -p "$traversal_source/nested"
printf 'escape\n' >"$traversal_source/nested/file"
traversal_archive="$TMP/traversal.tar"
# -P keeps the ../ prefix: GNU tar (Linux CI) strips it by default, which would
# leave a harmless archive and test nothing. bsdtar keeps it either way.
(cd "$traversal_source/nested" && /usr/bin/tar -cPf "$traversal_archive" ../nested/file)
/usr/bin/tar -tf "$traversal_archive" | grep -q '^\.\./' || { echo "FAIL: traversal fixture lost its ../ entry" >&2; exit 1; }
run_wrapper mkdir "$run_root/run-4"
expect_fail bash -c 'TASKPILOT_WRAPPER_TEST=1 TASKPILOT_WRAPPER_TEST_CONFIG="$1" bash "$2" extract "$3" < "$4"' bash "$config" "$installed" "$run_root/run-4" "$traversal_archive"

if [[ "$(/usr/bin/id -u)" == 0 ]]; then
  device_source="$TMP/device-source"
  mkdir -p "$device_source"
  /sbin/mknod "$device_source/device" c 1 3
  device_archive="$TMP/device.tar"
  /usr/bin/tar -cf "$device_archive" -C "$device_source" device
  run_wrapper mkdir "$run_root/run-5"
  expect_fail bash -c 'TASKPILOT_WRAPPER_TEST=1 TASKPILOT_WRAPPER_TEST_CONFIG="$1" bash "$2" extract "$3" < "$4"' bash "$config" "$installed" "$run_root/run-5" "$device_archive"
else
  echo 'device archive test skipped: requires root to create a device node'
fi

expect_fail run_wrapper codex "$run_root/run-1" exec --json --sandbox workspace-write -
expect_fail run_wrapper run "$run_root/run-1" codex '' 'default;touch /tmp/injected'
expect_fail run_wrapper run "$run_root/run-1" codex '' 'bogus'
expect_fail run_wrapper run "$run_root/run-1" claude '' 'off'
expect_fail run_wrapper run "$run_root/run-1/../escape" pi '' 'default'
expect_fail run_wrapper run "$run_root/run-1" not-a-cli '' default
printf 'stdin prompt, never argv' | run_wrapper run "$run_root/run-1" codex 'gpt-5-codex' high
grep -qx 'stdin prompt, never argv' "$fake_input" || fail 'coding prompt was not passed on stdin'
grep -qx 'model_reasoning_effort=high' "$fake_args" || fail 'Codex thinking selection was not mapped'
grep -qx 'gpt-5-codex' "$fake_args" || fail 'Codex model selection was not forwarded'
grep -q '^--sandbox$' "$fake_args" && grep -q '^workspace-write$' "$fake_args" || fail 'Codex workspace sandbox was not enforced'

run_wrapper run "$run_root/run-1" claude 'claude-model' high </dev/null
grep -qx -- '--effort' "$fake_args" && grep -qx 'high' "$fake_args" || fail 'Claude effort was not forwarded'
run_wrapper run "$run_root/run-1" pi 'provider/model' xhigh </dev/null
grep -qx 'xhigh' "$fake_args" || fail 'Pi thinking was not forwarded'
run_wrapper run "$run_root/run-1" grok 'grok-model' medium </dev/null
grep -qx -- '--output-format' "$fake_args" && grep -qx 'streaming-messages-json' "$fake_args" || fail 'Grok did not enable JSONL output'
grep -qx -- '--reasoning-effort' "$fake_args" && grep -qx 'medium' "$fake_args" || fail 'Grok reasoning effort was not forwarded'
cp "$TMP/fake-cli" "$agent_home/.local/bin/opencode.real"
rm "$agent_home/.local/bin/opencode"
ln -s opencode.real "$agent_home/.local/bin/opencode"
run_wrapper run "$run_root/run-1" opencode 'provider/model' high </dev/null
grep -qx -- '--variant' "$fake_args" && grep -qx 'high' "$fake_args" || fail 'OpenCode variant was not forwarded'

rm "$agent_home/.local/bin/codex"
ln -s "$TMP/fake-cli" "$agent_home/.local/bin/codex"
expect_fail run_wrapper run "$run_root/run-1" codex '' default
rm "$agent_home/.local/bin/codex"
cp "$TMP/fake-cli" "$agent_home/.local/bin/codex"

if grep -q 'must-not-cross' "$fake_env"; then fail 'main-user environment secret reached the coding child'; fi
grep -q "^HOME=$agent_home$" "$fake_env" || fail 'dedicated HOME did not reach the coding child'
old_config="$TMP/old-config"
printf "RUN_ROOT='%s'\\nAGENT_HOME='%s'\\n" "$run_root" "$agent_home" > "$old_config"
if TASKPILOT_WRAPPER_TEST=1 TASKPILOT_WRAPPER_TEST_CONFIG="$old_config" bash "$installed" status codex '' default 2>"$TMP/old-error"; then fail 'legacy config unexpectedly ran'; fi
grep -q 'predates multi-CLI policy' "$TMP/old-error" || fail 'legacy config lacked remediation guidance'

echo 'coding wrapper tests passed'
