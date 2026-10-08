#!/bin/bash
# Root-installed TaskPilot coding wrapper.
#
# Production reads only the root-owned /etc/taskpilot/coding-agent.conf. Tests
# may set TASKPILOT_WRAPPER_TEST=1 and point TASKPILOT_WRAPPER_TEST_CONFIG at a
# fixture; sudo's env_reset and the exact sudoers rule prevent that in production.
set -euo pipefail

STAT_PATH=/usr/bin/stat
CONFIG_PATH=/etc/taskpilot/coding-agent.conf
if [[ "${TASKPILOT_WRAPPER_TEST:-0}" == 1 ]]; then
  CONFIG_PATH="${TASKPILOT_WRAPPER_TEST_CONFIG:?missing test config}"
fi

fail() { echo "taskpilot coding wrapper: $*" >&2; exit 64; }

[[ -f "$CONFIG_PATH" && ! -L "$CONFIG_PATH" ]] || fail 'configuration is not a regular file'
if [[ "${TASKPILOT_WRAPPER_TEST:-0}" != 1 ]]; then
  config_record="$($STAT_PATH -f '%Su %OLp %HT' "$CONFIG_PATH")" || fail 'cannot inspect configuration'
  read -r config_owner config_mode config_kind <<<"$config_record"
  [[ "$config_owner" == root && "$config_kind" == "Regular File" && "$config_mode" == 644 ]] || fail 'configuration ownership or mode is unsafe'
fi
# The setup script validates every value before writing this root-owned file.
# shellcheck disable=SC1090
source "$CONFIG_PATH"
[[ "${RUNTIME_POLICY-}" == taskpilot-coding-cli-v1 ]] || fail 'configuration predates multi-CLI policy; rerun scripts/setup-coding-agent-user.sh --apply after administrator review'

for required in RUN_ROOT AGENT_HOME MKDIR_PATH TAR_PATH GIT_PATH RM_PATH CAT_PATH ENV_PATH; do
  [[ -n "${!required-}" ]] || fail "missing configuration key: $required; rerun scripts/setup-coding-agent-user.sh --apply after administrator review"
done
for value in "$RUN_ROOT" "$AGENT_HOME" "$MKDIR_PATH" "$TAR_PATH" "$GIT_PATH" "$RM_PATH" "$CAT_PATH" "$ENV_PATH"; do
  [[ "$value" == /* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail 'configuration contains an unsafe path'
done

[[ -d "$RUN_ROOT" && ! -L "$RUN_ROOT" ]] || fail 'run root is not a real directory'
root_canon="$(cd -P -- "$RUN_ROOT" 2>/dev/null && pwd -P)" || fail 'run root is unavailable'
home_canon="$(cd -P -- "$AGENT_HOME" 2>/dev/null && pwd -P)" || fail 'agent home is unavailable'

safe_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]]; }

resolve_cli() {
  local target="$1" link parent canonical count=0
  while [[ -L "$target" ]]; do
    (( count < 16 )) || fail 'CLI symlink chain is too deep'
    ((count+=1))
    link="$(/usr/bin/readlink "$target")" || fail 'cannot resolve CLI symlink'
    if [[ "$link" == /* ]]; then target="$link"; else target="${target%/*}/$link"; fi
  done
  parent="${target%/*}"
  canonical="$(cd -P -- "$parent" 2>/dev/null && pwd -P)/${target##*/}" || fail 'cannot resolve CLI path'
  [[ "$canonical" == "$home_canon/"* && -f "$canonical" && -x "$canonical" && -O "$canonical" ]] || fail 'CLI target must be an executable owned by the dedicated user inside its HOME'
  printf '%s' "$canonical"
}

run_dir() {
  [[ "$#" -eq 1 ]] || fail 'expected one run directory'
  local candidate="$1"
  [[ "$candidate" == "$RUN_ROOT"/* ]] || fail 'run directory is outside the run root'
  local name="${candidate#"$RUN_ROOT/"}"
  safe_name "$name" || fail 'run directory must be one safe direct child name'
  [[ "$candidate" == "$RUN_ROOT/$name" ]] || fail 'run directory is not a direct child'
  [[ -d "$candidate" && ! -L "$candidate" ]] || fail 'run directory is not a real directory'
  local canonical="$(cd -P -- "$candidate" 2>/dev/null && pwd -P)" || fail 'cannot resolve run directory'
  [[ "$canonical" == "$root_canon/$name" ]] || fail 'resolved run directory is outside the run root'
  [[ -O "$candidate" ]] || fail 'run directory is not owned by the agent user'
  printf '%s' "$canonical"
}

case "$1" in
  model-config)
    [[ "$#" -eq 3 ]] || fail 'model-config takes a CLI and a fixed config kind'
    cli="$2"; kind="$3"
    case "$cli:$kind" in
      pi:primary) file="$AGENT_HOME/.pi/agent/models.json" ;;
      pi:auxiliary) file="$AGENT_HOME/.pi/agent/settings.json" ;;
      opencode:primary) file="$AGENT_HOME/.config/opencode/opencode.json" ;;
      opencode:comments) file="$AGENT_HOME/.config/opencode/opencode.jsonc" ;;
      grok:primary) file="$AGENT_HOME/.grok/config.toml" ;;
      grok:managed) file="$AGENT_HOME/.grok/managed_config.toml" ;;
      codex:primary) file="$AGENT_HOME/.codex/config.toml" ;;
      codex:auxiliary) file="$AGENT_HOME/.codex/models_cache.json" ;;
      claude:primary) file="$AGENT_HOME/.claude/settings.json" ;;
      *) fail 'unsupported model config kind' ;;
    esac
    [[ -e "$file" ]] || exit 0
    [[ -f "$file" && ! -L "$file" ]] || fail 'model config is not a regular file'
    canonical_parent="$(cd -P -- "${file%/*}" 2>/dev/null && pwd -P)" || fail 'model config parent unavailable'
    [[ "$canonical_parent/" == "$home_canon/"* ]] || fail 'model config escapes dedicated HOME'
    if [[ "$OSTYPE" == darwin* ]]; then
      size="$("$STAT_PATH" -f '%z' "$file")" || fail 'cannot stat model config'
    else
      size="$("$STAT_PATH" -c '%s' "$file")" || fail 'cannot stat model config'
    fi
    [[ "$size" =~ ^[0-9]+$ && "$size" -le 4194304 ]] || fail 'model config exceeds 4 MiB'
    "$CAT_PATH" -- "$file"
    ;;
  status)
    [[ "$#" -eq 4 ]] || fail 'status takes CLI, model and thinking selections'
    cli="$2"; model="$3"; thinking="$4"
    [[ "$cli" =~ ^(codex|claude|pi|grok|opencode)$ ]] || fail 'unsupported CLI'
    [[ "$thinking" =~ ^(default|off|minimal|low|medium|high|xhigh|max)$ ]] || fail 'unsupported thinking level'
    case "$cli:$thinking" in
      claude:off|claude:minimal|grok:off|grok:minimal|grok:xhigh|grok:max|codex:off|codex:max) fail 'unsupported CLI thinking level' ;;
    esac
    [[ "$model" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@+*-]{0,199}$ || -z "$model" ]] || fail 'invalid model identifier'
    cli_path="$AGENT_HOME/.local/bin/$cli"
    [[ -x "$cli_path" ]] || fail "$cli CLI unavailable; install it in the dedicated user's ~/.local/bin after normal sign-in"
    cli_exec_path="$(resolve_cli "$cli_path")"
    version="$("$cli_exec_path" --version 2>/dev/null)" || fail "$cli CLI version probe failed"
    [[ -n "$version" ]] || fail "$cli CLI returned no version"
    printf 'version=%s\navailable=true\nreason=Sign-in is managed by the dedicated OS user\n' "$version"
    ;;
  mkdir)
    [[ "$#" -eq 2 ]] || fail 'mkdir takes one run directory'
    candidate="$2"
    [[ "$candidate" == "$RUN_ROOT"/* ]] || fail 'mkdir path is outside the run root'
    name="${candidate#"$RUN_ROOT/"}"
    safe_name "$name" || fail 'mkdir requires one safe direct child name'
    [[ "$candidate" == "$RUN_ROOT/$name" ]] || fail 'mkdir path is not a direct child'
    parent="$(cd -P -- "$RUN_ROOT" 2>/dev/null && pwd -P)" || fail 'cannot resolve run root parent'
    [[ "$parent" == "$root_canon" ]] || fail 'run root parent changed'
    [[ ! -e "$candidate" && ! -L "$candidate" ]] || fail 'run directory already exists'
    "$MKDIR_PATH" -m 700 -- "$candidate"
    ;;
  extract)
    [[ "$#" -eq 2 ]] || fail 'extract takes one run directory'
    dir="$(run_dir "$2")"
    archive="$dir/.taskpilot-baseline.tar"
    [[ ! -e "$archive" && ! -L "$archive" ]] || fail 'archive destination already exists'
    (set -C; "$CAT_PATH" >"$archive") || fail 'cannot receive baseline archive'
    entries="$($TAR_PATH -tf "$archive")" || fail 'cannot read baseline archive names'
    listing="$($TAR_PATH -tvf "$archive")" || fail 'cannot read baseline archive types'
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      case "${line:0:1}" in
        -|d) ;;
        *) fail 'archive contains a symlink, hardlink, device or other non-regular entry' ;;
      esac
    done <<< "$listing"
    while IFS= read -r entry; do
      [[ -z "$entry" ]] && continue
      [[ "$entry" != /* ]] || fail 'archive contains an absolute path'
      entry="${entry%/}"
      IFS=/ read -r -a parts <<< "$entry"
      for part in "${parts[@]}"; do
        [[ -n "$part" && "$part" != . && "$part" != .. ]] || fail 'archive contains an unsafe path component'
      done
      case "/$entry/" in
        */.git/*|*/.git/) fail 'archive contains a .git path' ;;
      esac
    done <<< "$entries"
    "$TAR_PATH" -xf "$archive" -C "$dir"
    "$RM_PATH" -f -- "$archive"
    ;;
  init)
    [[ "$#" -eq 2 ]] || fail 'init takes one run directory'
    dir="$(run_dir "$2")"
    "$GIT_PATH" -C "$dir" init --quiet
    "$GIT_PATH" -C "$dir" config user.name 'TaskPilot Coding Agent'
    "$GIT_PATH" -C "$dir" config user.email 'taskpilot-coding-agent@localhost'
    "$GIT_PATH" -C "$dir" add -A -- .
    "$GIT_PATH" -C "$dir" commit --quiet --allow-empty -m 'TaskPilot baseline'
    ;;
  diff)
    [[ "$#" -eq 2 ]] || fail 'diff takes one run directory'
    dir="$(run_dir "$2")"
    "$GIT_PATH" -C "$dir" add -A -- .
    "$GIT_PATH" -C "$dir" diff --cached --binary --no-ext-diff --no-renames -- .
    ;;
  check)
    [[ "$#" -eq 3 ]] || fail 'check takes run directory and check kind'
    dir="$(run_dir "$2")"
    [[ "$3" =~ ^(test|lint|build|smoke)$ ]] || fail 'unsupported check kind'
    IFS= read -r command || fail 'missing check executable'
    IFS= read -r arg_count || fail 'missing check argument count'
    [[ "$arg_count" =~ ^[0-9]{1,2}$ && "$arg_count" -le 32 ]] || fail 'invalid check argument count'
    args=()
    for ((index=0; index<arg_count; index++)); do
      IFS= read -r argument || fail 'missing check argument'
      [[ "$argument" != *$'\n'* && "$argument" != *$'\r'* ]] || fail 'check argument contains a newline'
      args+=("$argument")
    done
    baseline_manifest="$($GIT_PATH -C "$dir" show 'HEAD:package.json' 2>/dev/null)" || fail 'baseline package manifest is unavailable'
    [[ -n "$baseline_manifest" ]] || fail 'baseline package manifest is empty'
    npm_path="${NPM_PATH:-/usr/local/bin/npm}"
    [[ "$command" == "$npm_path" || "$command" == npm ]] || fail 'check executable is not the configured npm'
    [[ "$arg_count" -ge 2 && "${args[0]}" == run && "${args[1]}" =~ ^[A-Za-z0-9:_-]+$ ]] || fail 'check must select an npm script'
    script="${args[1]}"
    /usr/bin/grep -Eq -- "\"$script\"[[:space:]]*:" <<< "$baseline_manifest" || fail 'npm script is not present in the baseline manifest'
    [[ "$arg_count" -eq 2 ]] || fail 'npm check arguments are fixed'
    cd -- "$dir"
    exec "$ENV_PATH" -i HOME="$AGENT_HOME" PATH="${npm_path%/*}:/usr/bin:/bin" LANG=C TERM=dumb NO_COLOR=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSCOPE=1 "$npm_path" --no-audit --no-fund run "$script"
    ;;
  report)
    [[ "$#" -eq 3 ]] || fail 'report takes run directory and relative path'
    dir="$(run_dir "$2")"
    report_path="$3"
    [[ "$report_path" != /* && "$report_path" != *$'\n'* && "$report_path" != *$'\r'* ]] || fail 'report path is absolute or malformed'
    IFS=/ read -r -a report_parts <<< "$report_path"
    for part in "${report_parts[@]}"; do [[ -n "$part" && "$part" != . && "$part" != .. ]] || fail 'report path traversal'; done
    report="$dir/$report_path"
    [[ -f "$report" && ! -L "$report" ]] || fail 'report is not a regular file'
    report_size="$($STAT_PATH -f '%z' "$report")" || fail 'cannot stat report'
    [[ "$report_size" =~ ^[0-9]+$ && "$report_size" -le 5242880 ]] || fail 'report is too large'
    report_dir="$(cd -P -- "$(dirname -- "$report")" 2>/dev/null && pwd -P)" || fail 'cannot resolve report path'
    [[ "$report_dir" == "$dir" || "$report_dir" == "$dir"/* ]] || fail 'report resolves outside run directory'
    "$CAT_PATH" -- "$report"
    ;;
  clean)
    [[ "$#" -eq 2 ]] || fail 'clean takes one run directory'
    dir="$(run_dir "$2")"
    "$RM_PATH" -rf -- "$dir"
    ;;
  run)
    [[ "$#" -eq 5 ]] || fail 'run takes run directory, CLI, model and thinking selections'
    dir="$(run_dir "$2")"
    cli="$3"; model="$4"; thinking="$5"
    [[ "$cli" =~ ^(codex|claude|pi|grok|opencode)$ ]] || fail 'unsupported CLI'
    [[ "$model" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@+*-]{0,199}$ || -z "$model" ]] || fail 'invalid model identifier'
    [[ "$thinking" =~ ^(default|off|minimal|low|medium|high|xhigh|max)$ ]] || fail 'unsupported thinking level'
    case "$cli:$thinking" in
      claude:off|claude:minimal|grok:off|grok:minimal|grok:xhigh|grok:max|codex:off|codex:max) fail 'unsupported CLI thinking level' ;;
    esac
    cli_path="$AGENT_HOME/.local/bin/$cli"
    [[ -x "$cli_path" ]] || fail "$cli CLI unavailable; install it in the dedicated user's ~/.local/bin after normal sign-in"
    cli_exec_path="$(resolve_cli "$cli_path")"
    args=()
    case "$cli" in
      codex)
        args=(exec --json --sandbox workspace-write --ask-for-approval never)
        [[ -z "$model" ]] || args+=(--model "$model")
        [[ "$thinking" == default ]] || args+=(-c "model_reasoning_effort=$thinking")
        args+=(-)
        ;;
      claude)
        args=(-p --output-format stream-json --verbose --tools 'Bash,Edit,Read,Write,Glob,Grep' --strict-mcp-config)
        [[ -z "$model" ]] || args+=(--model "$model")
        [[ "$thinking" == default ]] || args+=(--effort "$thinking")
        ;;
      pi)
        args=(--mode json --print --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files --no-session)
        [[ -z "$model" ]] || args+=(--model "$model")
        [[ "$thinking" == default ]] || args+=(--thinking "$thinking")
        ;;
      grok)
        args=(--output-format streaming-messages-json --prompt-file /dev/stdin --disable-web-search --no-subagents)
        [[ -z "$model" ]] || args+=(--model "$model")
        [[ "$thinking" == default ]] || args+=(--reasoning-effort "$thinking")
        ;;
      opencode)
        args=(run --pure --format json)
        [[ -z "$model" ]] || args+=(--model "$model")
        [[ "$thinking" == default ]] || args+=(--variant "$thinking")
        ;;
    esac
    cd -- "$dir"
    exec "$ENV_PATH" -i HOME="$AGENT_HOME" PATH="$AGENT_HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin" LANG=C TERM=dumb NO_COLOR=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSCOPE=1 "$cli_exec_path" "${args[@]}"
    ;;
  *)
    fail "unsupported action: $1"
    ;;
esac
