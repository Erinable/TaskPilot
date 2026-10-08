#!/usr/bin/env bash
# Prepare a dedicated macOS OS user for TaskPilot coding CLIs.
#
# This is a reviewed bootstrap, not an installer. It does not create a
# repository checkout, install a CLI, or log in. Run --apply only after reading
# docs/coding-agent-security.md and accepting the separate-user boundary.
set -euo pipefail

# Fixed system paths. Do not replace these with command -v: the invoking PATH is
# not trusted when their paths are embedded in a root-owned wrapper.
UNAME_PATH=/usr/bin/uname
ID_PATH=/usr/bin/id
SUDO_PATH=/usr/bin/sudo
SYSADMINCTL_PATH=/usr/sbin/sysadminctl
STAT_PATH=/usr/bin/stat
MKDIR_PATH=/bin/mkdir
TEE_PATH=/usr/bin/tee
CHOWN_PATH=/usr/sbin/chown
CHMOD_PATH=/bin/chmod
TAR_PATH=/usr/bin/tar
GIT_PATH=/usr/bin/git
NPM_PATH=/usr/local/bin/npm
CAT_PATH=/bin/cat
MKTEMP_PATH=/usr/bin/mktemp
MV_PATH=/bin/mv
BASH_PATH=/bin/bash
ENV_PATH=/usr/bin/env
VISUDO_PATH=/usr/sbin/visudo

AGENT_USER=taskpilot-coder
if [[ -n "${TASKPILOT_CODING_USER-}" && "${TASKPILOT_CODING_USER}" != "$AGENT_USER" ]]; then
  echo 'Custom TASKPILOT_CODING_USER is unsupported; the coding runtime requires taskpilot-coder.' >&2
  exit 1
fi
case "$0" in
  */*) SCRIPT_DIR="${0%/*}" ;;
  *) SCRIPT_DIR=. ;;
esac
SCRIPT_DIR="$(cd -P -- "$SCRIPT_DIR" && pwd -P)"
WRAPPER_SOURCE="$SCRIPT_DIR/taskpilot-coding-wrapper.sh"
for forbidden in TASKPILOT_CODING_HOME TASKPILOT_CODING_RUN_ROOT TASKPILOT_CODING_CLI_PATH TASKPILOT_CODEX_PATH; do
  if [[ -n "${!forbidden-}" ]]; then
    echo "$forbidden is not accepted; privileged paths are derived from the validated user" >&2
    exit 1
  fi
done

AGENT_HOME="/Users/$AGENT_USER"
RUN_ROOT="$AGENT_HOME/TaskPilotRuns"
CONFIG_DIR=/etc/taskpilot
CONFIG_DIR=/etc/taskpilot
CONFIG_PATH="$CONFIG_DIR/coding-agent.conf"
SUDOERS_DIR=/etc/sudoers.d
SUDOERS_PATH="$SUDOERS_DIR/taskpilot-coding-agent"
WRAPPER_DIR=/usr/local/libexec
WRAPPER_PATH="$WRAPPER_DIR/taskpilot-coding-wrapper"
OWNER_USER="$($ID_PATH -un)"

usage() {
  "$CAT_PATH" <<'USAGE'
Usage:
  scripts/setup-coding-agent-user.sh [--apply] [--reuse-existing]

Environment overrides:
  None. The coding user is fixed to taskpilot-coder so the runtime and wrapper policy cannot diverge.

The home, run root, wrapper path and sudoers path are fixed to that dedicated
user. CLI executables are derived as ~/.local/bin/{codex,claude,pi,grok,opencode}.
Other path overrides are rejected because they would be embedded in a privileged policy.

Default mode prints the plan only. --apply creates/reuses the user, creates its
private run root, installs one root-owned argument-validating wrapper, installs
an exact-path sudoers rule, and validates it. It does not install a CLI or log
in to any provider.
USAGE
}

apply=false
reuse=false
for arg in "$@"; do
  case "$arg" in
    --apply) apply=true ;;
    --reuse-existing) reuse=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$($UNAME_PATH -s)" != Darwin ]]; then
  echo "This bootstrap currently supports macOS only; use the design doc for Linux/container setup." >&2
  exit 1
fi

stat_record() {
  local raw owner mode kind
  raw="$($STAT_PATH -f '%Su %OLp %HT' "$1" 2>/dev/null)" || return 1
  owner="${raw%% *}"
  raw="${raw#* }"
  mode="${raw%% *}"
  kind="${raw#* }"
  case "$kind" in
    Directory|directory) kind=directory ;;
    "Regular File"|"regular file") kind='regular file' ;;
    "Symbolic Link"|"symbolic link") kind='symbolic link' ;;
  esac
  printf '%s %s %s\n' "$owner" "$mode" "$kind"
}

assert_system_path() {
  local target="$1" record owner mode kind current remaining component
  [[ "$target" == /* ]] || { echo "System path is not absolute: $target" >&2; exit 1; }
  current=/
  remaining="${target#/}"
  while [[ -n "$remaining" ]]; do
    if [[ "$remaining" == */* ]]; then
      component="${remaining%%/*}"
      remaining="${remaining#*/}"
    else
      component="$remaining"
      remaining=
    fi
    [[ -n "$component" ]] || continue
    current="$current$component"
    record="$(stat_record "$current")" || { echo "Missing system path component: $current" >&2; exit 1; }
    read -r owner mode kind <<<"$record"
    [[ "$owner" == root ]] || { echo "System path component is not root-owned: $current ($record)" >&2; exit 1; }
    [[ "$kind" == directory || "$kind" == regular\ file || "$kind" == symbolic\ link ]] || {
      echo "Unexpected system path component: $current ($record)" >&2
      exit 1
    }
    if [[ "$kind" != symbolic\ link ]]; then
      (( (8#$mode & 022) == 0 )) || { echo "Writable system path component: $current ($record)" >&2; exit 1; }
    fi
    current="$current/"
  done
  record="$(stat_record "$target")" || { echo "Missing system executable: $target" >&2; exit 1; }
  read -r owner mode kind <<<"$record"
  [[ "$owner" == root && ( "$kind" == regular\ file || "$kind" == symbolic\ link ) ]] || {
    echo "Unsafe system executable: $target ($record)" >&2
    exit 1
  }
  [[ "$kind" == symbolic\ link || "$mode" == *[1357] || "$mode" == *[1357][1357] || "$mode" == *[1357][1357][1357] ]] || {
    echo "System executable is not executable: $target ($record)" >&2
    exit 1
  }
}

if [[ ! -f "$WRAPPER_SOURCE" || -L "$WRAPPER_SOURCE" ]]; then
  echo "Missing or symlinked reviewed wrapper source: $WRAPPER_SOURCE" >&2
  exit 1
fi
for system_path in "$UNAME_PATH" "$ID_PATH" "$SUDO_PATH" "$SYSADMINCTL_PATH" "$STAT_PATH" "$MKDIR_PATH" "$TEE_PATH" "$CHOWN_PATH" "$CHMOD_PATH" "$TAR_PATH" "$GIT_PATH" "$NPM_PATH" "$RM_PATH" "$CAT_PATH" "$MKTEMP_PATH" "$MV_PATH" "$BASH_PATH" "$ENV_PATH" "$VISUDO_PATH"; do
  assert_system_path "$system_path"
done

if [[ ! "$AGENT_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]]; then
  echo "Invalid dedicated user name: $AGENT_USER" >&2
  exit 1
fi
if [[ ! "$OWNER_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]]; then
  echo "The current OS user cannot be represented safely in sudoers: $OWNER_USER" >&2
  exit 1
fi
if [[ "$OWNER_USER" == "$AGENT_USER" ]]; then
  echo "The coding user must differ from the TaskPilot user." >&2
  exit 1
fi
if [[ "$AGENT_HOME" != "/Users/$AGENT_USER" || "$RUN_ROOT" != "$AGENT_HOME/TaskPilotRuns" ]]; then
  echo "Privileged paths do not match the derived policy." >&2
  exit 1
fi
for value in "$AGENT_USER" "$OWNER_USER" "$AGENT_HOME" "$RUN_ROOT" "$CONFIG_DIR" "$CONFIG_PATH" "$SUDOERS_DIR" "$SUDOERS_PATH" "$WRAPPER_DIR" "$WRAPPER_PATH"; do
  if [[ ! "$value" =~ ^[A-Za-z0-9_./-]+$ ]]; then
    echo "Unsafe value for bootstrap: $value" >&2
    exit 1
  fi
done

DSCL_USER_EXISTS=false
if "$ID_PATH" -u "$AGENT_USER" >/dev/null 2>&1; then
  DSCL_USER_EXISTS=true
fi
if [[ "$DSCL_USER_EXISTS" == true && "$reuse" != true ]]; then
  echo "User $AGENT_USER already exists; pass --reuse-existing only after auditing it." >&2
  exit 1
fi

assert_system_directory_path() {
  local target="$1" record owner mode kind current remaining component
  [[ "$target" == /* ]] || { echo "Directory path is not absolute: $target" >&2; exit 1; }
  current=/
  remaining="${target#/}"
  while [[ -n "$remaining" ]]; do
    if [[ "$remaining" == */* ]]; then
      component="${remaining%%/*}"
      remaining="${remaining#*/}"
    else
      component="$remaining"
      remaining=
    fi
    [[ -n "$component" ]] || continue
    current="$current$component"
    record="$(stat_record "$current")" || { echo "Missing directory component: $current" >&2; exit 1; }
    read -r owner mode kind <<<"$record"
    [[ "$owner" == root ]] || { echo "Directory component is not root-owned: $current ($record)" >&2; exit 1; }
    [[ "$kind" == directory || "$kind" == symbolic\ link ]] || { echo "Unexpected directory component: $current ($record)" >&2; exit 1; }
    if [[ "$kind" != symbolic\ link ]]; then
      (( (8#$mode & 022) == 0 )) || { echo "Writable directory component: $current ($record)" >&2; exit 1; }
    fi
    current="$current/"
  done
}

assert_root_directory() {
  local target="$1" record owner mode kind canonical
  record="$(stat_record "$target")" || { echo "Missing root directory: $target" >&2; exit 1; }
  read -r owner mode kind <<<"$record"
  if [[ "$kind" == symbolic\ link ]]; then
    [[ "$owner" == root ]] || { echo "Unsafe root-owned directory link: $target ($record)" >&2; exit 1; }
    assert_system_directory_path "$target"
    canonical="$(cd -P -- "$target" 2>/dev/null && pwd -P)" || { echo "Cannot resolve root directory: $target" >&2; exit 1; }
    assert_system_directory_path "$canonical"
    assert_root_directory "$canonical"
    return
  fi
  [[ "$owner" == root && "$kind" == directory ]] || { echo "Unsafe root directory: $target ($record)" >&2; exit 1; }
  (( (8#$mode & 022) == 0 )) || { echo "Writable by group/other: $target ($record)" >&2; exit 1; }
}

assert_real_root_directory() {
  local target="$1" record owner mode kind
  record="$(stat_record "$target")" || { echo "Missing root directory: $target" >&2; exit 1; }
  read -r owner mode kind <<<"$record"
  [[ "$owner" == root && "$kind" == directory ]] || { echo "Policy directory must be a real root-owned directory: $target ($record)" >&2; exit 1; }
  (( (8#$mode & 022) == 0 )) || { echo "Writable by group/other: $target ($record)" >&2; exit 1; }
}

assert_agent_directory() {
  local target="$1" record owner mode kind
  record="$(stat_record "$target")" || { echo "Missing agent directory: $target" >&2; exit 1; }
  read -r owner mode kind <<<"$record"
  [[ "$owner" == "$AGENT_USER" && "$kind" == directory && "$mode" == 700 ]] || {
    echo "Unsafe agent directory: $target ($record), expected $AGENT_USER 700 directory" >&2
    exit 1
  }
}

assert_root_file() {
  local target="$1" expected_mode="$2" record owner mode kind
  record="$(stat_record "$target")" || { echo "Missing installed file: $target" >&2; exit 1; }
  read -r owner mode kind <<<"$record"
  [[ "$owner" == root && "$kind" == regular && "$mode" == "$expected_mode" ]] || {
    echo "Unsafe installed file: $target ($record), expected root $expected_mode regular file" >&2
    exit 1
  }
}

refuse_symlink_or_unsafe_existing() {
  local target="$1" record owner mode kind
  if ! record="$(stat_record "$target")"; then
    return 0
  fi
  read -r owner mode kind <<<"$record"
  [[ "$kind" != symbolic\ link ]] || { echo "Refusing symlink at privileged destination: $target" >&2; exit 1; }
  [[ "$owner" == root && "$kind" == regular ]] || { echo "Refusing unsafe existing destination: $target ($record)" >&2; exit 1; }
  (( (8#$mode & 022) == 0 )) || { echo "Refusing writable existing destination: $target ($mode)" >&2; exit 1; }
}

assert_root_directory /Users
assert_root_directory /usr/local
assert_root_directory /etc

if record="$(stat_record "$AGENT_HOME")"; then
  read -r _ _ kind <<<"$record"
  [[ "$kind" == directory ]] || { echo "Refusing non-directory or symlink home: $AGENT_HOME" >&2; exit 1; }
elif [[ "$DSCL_USER_EXISTS" == true ]]; then
  echo "Existing user has no real home directory: $AGENT_HOME" >&2
  exit 1
fi
if record="$(stat_record "$RUN_ROOT")"; then
  read -r _ _ kind <<<"$record"
  [[ "$kind" == directory ]] || { echo "Refusing non-directory or symlink run root: $RUN_ROOT" >&2; exit 1; }
fi

cat <<PLAN
TaskPilot dedicated coding user plan

  owner:       $OWNER_USER
  agent user:  $AGENT_USER
  agent home:  $AGENT_HOME (0700, owned by $AGENT_USER)
  run root:    $RUN_ROOT (0700, owned by $AGENT_USER)
  CLI paths:   $AGENT_HOME/.local/bin/{codex,claude,pi,grok,opencode}
  wrapper:     $WRAPPER_PATH (root-owned)
  sudoers:     $SUDOERS_PATH (root-owned)

The owner may invoke only the exact root-owned wrapper as $AGENT_USER. The
wrapper validates direct run-directory names, archive entry types, paths and
fixed CLI-specific argv. No dynamic wildcard appears in sudoers.

Not performed by this script:
  - no copying/symlinking any owner's provider credentials
  - no CLI installation
  - no CLI login
  - no repository checkout or worktree access
  - no push credential setup
PLAN

if [[ "$apply" != true ]]; then
  echo "Dry run only. Re-run with --apply after reviewing the plan."
  exit 0
fi

read -r -p "Create/reuse $AGENT_USER and install the exact wrapper sudoers rule? Type APPLY: " confirmation
[[ "$confirmation" == APPLY ]] || { echo "Not applied."; exit 1; }

if [[ "$DSCL_USER_EXISTS" != true ]]; then
  echo "Creating $AGENT_USER. macOS will prompt for the dedicated user's password."
  "$SUDO_PATH" "$SYSADMINCTL_PATH" -addUser "$AGENT_USER" -fullName "TaskPilot Coding Agent" -home "$AGENT_HOME" -password -
fi

record="$(stat_record "$AGENT_HOME")" || { echo "The dedicated user's home was not created: $AGENT_HOME" >&2; exit 1; }
read -r _ _ kind <<<"$record"
[[ "$kind" == directory ]] || { echo "Refusing non-directory or symlink home: $AGENT_HOME" >&2; exit 1; }
if ! stat_record "$RUN_ROOT" >/dev/null; then
  "$SUDO_PATH" "$MKDIR_PATH" -m 700 -- "$RUN_ROOT"
fi
"$SUDO_PATH" "$CHOWN_PATH" "$AGENT_USER":staff "$AGENT_HOME" "$RUN_ROOT"
"$SUDO_PATH" "$CHMOD_PATH" 700 "$AGENT_HOME" "$RUN_ROOT"
assert_agent_directory "$AGENT_HOME"
assert_agent_directory "$RUN_ROOT"

if ! stat_record "$WRAPPER_DIR" >/dev/null; then
  "$SUDO_PATH" "$MKDIR_PATH" -- "$WRAPPER_DIR"
  "$SUDO_PATH" "$CHOWN_PATH" root:wheel "$WRAPPER_DIR"
  "$SUDO_PATH" "$CHMOD_PATH" 755 "$WRAPPER_DIR"
fi
assert_real_root_directory "$WRAPPER_DIR"
if ! stat_record "$CONFIG_DIR" >/dev/null; then
  "$SUDO_PATH" "$MKDIR_PATH" -- "$CONFIG_DIR"
  "$SUDO_PATH" "$CHOWN_PATH" root:wheel "$CONFIG_DIR"
  "$SUDO_PATH" "$CHMOD_PATH" 755 "$CONFIG_DIR"
fi
assert_real_root_directory "$CONFIG_DIR"

if [[ -e "$WRAPPER_PATH" || -L "$WRAPPER_PATH" || -e "$CONFIG_PATH" || -L "$CONFIG_PATH" || -e "$SUDOERS_PATH" || -L "$SUDOERS_PATH" ]]; then
  echo "A TaskPilot coding installation already exists. Refusing to replace privileged files; remove them only after an administrator review." >&2
  exit 1
fi

wrapper_tmp="$($SUDO_PATH $MKTEMP_PATH "$WRAPPER_DIR/.taskpilot-coding-wrapper.XXXXXX")"
config_tmp=""
sudoers_tmp=""
cleanup_temps() {
  [[ -z "$wrapper_tmp" ]] || "$SUDO_PATH" "$RM_PATH" -f -- "$wrapper_tmp" || true
  [[ -z "$config_tmp" ]] || "$SUDO_PATH" "$RM_PATH" -f -- "$config_tmp" || true
  [[ -z "$sudoers_tmp" ]] || "$SUDO_PATH" "$RM_PATH" -f -- "$sudoers_tmp" || true
}
trap cleanup_temps EXIT

# Install the reviewed static artifact, not an inline duplicate. The temp file
# is in a root-owned directory and is moved only after syntax/ownership checks.
"$SUDO_PATH" "$TEE_PATH" "$wrapper_tmp" < "$WRAPPER_SOURCE" >/dev/null
"$SUDO_PATH" "$CHMOD_PATH" 755 "$wrapper_tmp"
"$SUDO_PATH" "$BASH_PATH" -n "$wrapper_tmp"
"$SUDO_PATH" "$CHOWN_PATH" root:wheel "$wrapper_tmp"
assert_root_file "$wrapper_tmp" 755
"$SUDO_PATH" "$MV_PATH" -n "$wrapper_tmp" "$WRAPPER_PATH"
wrapper_tmp=""
assert_root_file "$WRAPPER_PATH" 755

# The config contains only derived paths and fixed system tools, no secrets.
# It is root-owned and non-writable by the coding user so the wrapper can read
# it without allowing the agent to change its policy.
config_tmp="$($SUDO_PATH $MKTEMP_PATH "$CONFIG_DIR/.coding-agent.conf.XXXXXX")"
"$SUDO_PATH" "$TEE_PATH" "$config_tmp" >/dev/null <<CONFIG
RUNTIME_POLICY='taskpilot-coding-cli-v1'
RUN_ROOT='$RUN_ROOT'
AGENT_HOME='$AGENT_HOME'
MKDIR_PATH='$MKDIR_PATH'
TAR_PATH='$TAR_PATH'
GIT_PATH='$GIT_PATH'
NPM_PATH='$NPM_PATH'
RM_PATH='$RM_PATH'
CAT_PATH='$CAT_PATH'
ENV_PATH='$ENV_PATH'
CONFIG
"$SUDO_PATH" "$CHMOD_PATH" 644 "$config_tmp"
"$SUDO_PATH" "$CHOWN_PATH" root:wheel "$config_tmp"
assert_root_file "$config_tmp" 644
"$SUDO_PATH" "$MV_PATH" -n "$config_tmp" "$CONFIG_PATH"
config_tmp=""
assert_root_file "$CONFIG_PATH" 644

assert_real_root_directory "$SUDOERS_DIR"
sudoers_tmp="$($SUDO_PATH $MKTEMP_PATH "$SUDOERS_DIR/.taskpilot-coding-sudoers.XXXXXX")"
"$SUDO_PATH" "$TEE_PATH" "$sudoers_tmp" >/dev/null <<SUDOERS
# Managed by TaskPilot's reviewed coding-agent bootstrap.
# Exact executable path only; the root-owned wrapper validates every argument.
User_Alias TASKPILOT_OWNER = $OWNER_USER
Cmnd_Alias TASKPILOT_CODING = $WRAPPER_PATH
TASKPILOT_OWNER ALL = ($AGENT_USER) NOPASSWD: TASKPILOT_CODING
SUDOERS
"$SUDO_PATH" "$CHMOD_PATH" 440 "$sudoers_tmp"
"$SUDO_PATH" "$VISUDO_PATH" -cf "$sudoers_tmp"
"$SUDO_PATH" "$CHOWN_PATH" root:wheel "$sudoers_tmp"
assert_root_file "$sudoers_tmp" 440
"$SUDO_PATH" "$MV_PATH" -n "$sudoers_tmp" "$SUDOERS_PATH"
sudoers_tmp=""
assert_root_file "$SUDOERS_PATH" 440


trap - EXIT
echo
cat <<NEXT
Bootstrap complete.

Next, sign in to the macOS account $AGENT_USER through the normal login window
(or an administrator-approved session). In that account's own HOME, install
any selected CLI at its fixed path and authenticate that user through the CLI's
normal sign-in flow. TaskPilot neither installs tools nor reads credentials.

The TaskPilot user's sudoers rule intentionally permits only the exact wrapper;
it does not grant a shell, installer, or login command as the agent user. Never
copy or symlink credentials from another OS user.

TaskPilot will stream a baseline archive into an agent-owned run directory and
read only `git diff --binary` back over stdout. It will never expose the user's
checkout .git directory to the coding user.
NEXT
