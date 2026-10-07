#!/bin/sh
# cc-askpass remote side. The ssh wrapper sends this file base64-encoded inside its remote
# command and evals it there with /bin/sh:
#
#   (no argument)          Bootstrap, with CCAP_TOKEN, CCAP_RS_B64 (this file), CCAP_ASKPASS_B64,
#                          CCAP_SSH_B64, CCAP_EXE_B64 and CCAP_CMD_B64 in the environment: set
#                          up the token directory and run the command with the remote askpass.
#   relay <token>          Copy the requests that pass verification from the token directory's
#                          request FIFO to stdout; answer the others with an empty reply.
#   reply <token> <pid>    Copy stdin (the answer) into the helper's reply FIFO.
#   stop <token>           Hang up the bootstrap's process group: the wrapper was interrupted.
#
# It never writes to stdout except the relayed request lines; diagnostics go to stderr.

me=cc-askpass
umask 077
tab=$(printf '\t')
nl='
'

decode() {
  printf %s "$1" | base64 -d 2> /dev/null || printf %s "$1" | base64 -D
}

# nap: sleep a tenth of a second, or a whole one where sleep takes no fractions (POSIX does
# not promise them); step is how many tenths that was.
nap() {
  if [ "${step:-1}" = 1 ] && sleep 0.1 2> /dev/null; then
    step=1
  else
    sleep 1
    step=10
  fi
}

# bases: the candidate base directories, one per line. CCAP_TEST_BASES (space-separated)
# replaces them in tests.
bases() {
  if [ -n "${CCAP_TEST_BASES:-}" ]; then
    printf '%s\n' $CCAP_TEST_BASES
    return
  fi
  [ -z "${XDG_RUNTIME_DIR:-}" ] || printf '%s\n' "${XDG_RUNTIME_DIR%/}"
  [ -z "${HOME:-}" ] || printf '%s\n' "${HOME%/}/.cache"
  echo /tmp
}

# find_dir TOKEN: set dir to the token directory of TOKEN.
find_dir() {
  case $1 in '' | *[!0-9a-f]*) return 1 ;; esac
  while IFS= read -r base; do
    dir=$base/$me-$1
    [ -d "$dir" ] && [ ! -L "$dir" ] && [ -O "$dir" ] && return 0
  done << EOF
$(bases)
EOF
  return 1
}

# sweep BASE: remove token directories whose bootstrap on this host is gone (connection lost,
# bootstrap killed). The owner is "<pid>@<host>": a home shared over NFS holds other hosts' too.
sweep() {
  for old in "$1/$me"-*; do
    [ -d "$old" ] && [ ! -L "$old" ] && [ -O "$old" ] && [ -f "$old/owner.pid" ] || continue
    IFS= read -r owner < "$old/owner.pid"
    [ "${owner#*@}" = "$host" ] || continue
    kill -0 "${owner%%@*}" 2> /dev/null && continue
    # A relay may still wait on its FIFO.
    [ -p "$old/req" ] && printf 'stop\n' 1<> "$old/req"
    rm -rf "$old"
  done
}

# proc PID: set p_ppid, p_euid, p_comm and p_argv (the args, one per line) of PID: from /proc
# where there is one (BusyBox ps has no -p), else from ps. Tests replace it.
proc() {
  p_pid=$1 p_ppid= p_euid= p_comm= p_argv=
  if [ -r "/proc/$p_pid/status" ]; then
    while IFS="$tab" read -r key v1 v2 _; do
      case $key in
        Name:) p_comm=$v1 ;;
        PPid:) p_ppid=$v1 ;;
        Uid:) p_euid=$v2 ;;
      esac
    done < "/proc/$p_pid/status"
    p_argv=$(tr '\0' '\n' < "/proc/$p_pid/cmdline")
  else
    # macOS prints comm as a path, maybe with blanks: it is the rest of the line.
    set -f
    # shellcheck disable=SC2046
    set -- $(ps -o ppid=,uid=,comm= -p "$p_pid" 2> /dev/null)
    set +f
    [ $# -ge 3 ] || return 1
    p_ppid=$1 p_euid=$2
    shift 2
    p_comm=$*
    p_comm=${p_comm##*/}
    p_argv=$(ps -ww -o args= -p "$p_pid" 2> /dev/null | tr ' ' '\n')
  fi
  case $p_ppid in '' | *[!0-9]*) return 1 ;; esac
}

# exe_of PID: "<owner uid> <path>" of PID's executable (bin/exe-of). Tests replace it.
exe_of() {
  sh "$dir/exe-of" "$1"
}

# after PATH ARGV: when ARGV (one arg per line) runs PATH, as the program or as its
# interpreter's first argument, print the args that follow, one per line.
after() {
  path=$1
  saved_ifs=$IFS
  IFS=$nl
  set -f
  # shellcheck disable=SC2086
  set -- $2
  set +f
  IFS=$saved_ifs
  if [ "${1:-}" = "$path" ]; then
    shift
  elif [ "${2:-}" = "$path" ]; then
    shift 2
  else
    return 1
  fi
  [ $# -eq 0 ] || printf '%s\n' "$@"
}

# target_name ARGS: the host name our ssh wrapper takes from its ARGS (one per line) in normal
# mode, parsed by the wrapper's own code.
target_name() (
  CC_ASKPASS_SHIM_LIB=1
  . "$dir/ssh"
  saved_ifs=$IFS
  IFS=$nl
  set -f
  # shellcheck disable=SC2086
  set -- $1
  set +f
  IFS=$saved_ifs
  [ "${1:-}" != --relay ] || exit 1
  parse_args "$@"
  host_name
  printf '%s\n' "$name"
)

# verify PID: whether the request of helper PID may go on to the pane, by the rules the mod
# applies locally. The helper runs this directory's askpass, and its parent is sudo running as
# root, a root-owned ssh/git client binary named like the process, or the relay of our ssh
# wrapper (a further hop) started by that wrapper for the same host. Anything else, a shell
# calling $SUDO_ASKPASS among them, would hand the answer to a command whose output Claude
# reads.
verify() {
  proc "$1" && after "$dir/askpass" "$p_argv" > /dev/null && proc "$p_ppid" || return 1
  [ "$p_euid" = 0 ] && [ "$p_comm" = sudo ] && return 0

  # Linux cuts comm at 15 characters (git-remote-https reads as git-remote-http); macOS does
  # not, so it is cut the same way. A script's comm is its name: our ssh wrapper's relay
  # reads as ssh, fails the executable check and is judged as a relay below.
  case $(printf '%.15s' "$p_comm") in
    ssh | ssh-add | scp | sftp | git-remote-http)
      if exe=$(exe_of "$p_pid") && [ "${exe%% *}" = 0 ]; then
        case ${exe##*/} in "$p_comm"*) return 0 ;; esac
      fi
      ;;
  esac

  rest=$(after "$dir/ssh" "$p_argv") || return 1
  relay_host=${rest#--relay"$nl"}
  [ "$relay_host" != "$rest" ] || return 1
  case $relay_host in '' | *[!A-Za-z0-9._@:%-]*) return 1 ;; esac
  proc "$p_ppid" || return 1
  args=$(after "$dir/ssh" "$p_argv") || return 1
  [ "$(target_name "$args")" = "$relay_host" ]
}

# The sudo found first on PATH: run the real one with -A, so it asks through SUDO_ASKPASS,
# unless the caller chose how sudo gets the password.
sudo_wrapper() {
  cat << 'EOF'
#!/bin/sh
# cc-askpass sudo wrapper
real=
oldifs=$IFS
IFS=:
set -f
for entry in $PATH; do
  [ -n "$entry" ] && [ -f "$entry/sudo" ] && [ -x "$entry/sudo" ] || continue
  line1= line2=
  { IFS= read -r line1 && IFS= read -r line2; } < "$entry/sudo" 2> /dev/null
  [ "$line2" = '# cc-askpass sudo wrapper' ] && continue
  real=$entry/sudo
  break
done
set +f
IFS=$oldifs
if [ -z "$real" ]; then
  echo "cc-askpass: sudo: command not found" >&2
  exit 127
fi
# Options end at the first word that is not one (the command) or at --; the letters after
# one that takes a value are that value.
skip=
for word in "$@"; do
  if [ -n "$skip" ]; then
    skip=
    continue
  fi
  case $word in
    --askpass | --stdin | --non-interactive) exec "$real" "$@" ;;
    --) break ;;
    --*) ;;
    -?*)
      letters=${word#-}
      while [ -n "$letters" ]; do
        rest=${letters#?}
        case ${letters%"$rest"} in
          A | S | n) exec "$real" "$@" ;;
          C | D | g | h | p | R | r | T | t | U | u)
            [ -n "$rest" ] || skip=1
            break
            ;;
        esac
        letters=$rest
      done
      ;;
    *) break ;;
  esac
done
exec "$real" -A "$@"
EOF
}


# plain: run the command as ssh would have, without the mod.
plain() {
  unset CCAP_TOKEN CCAP_RS_B64 CCAP_ASKPASS_B64 CCAP_SSH_B64 CCAP_EXE_B64 CCAP_CMD_B64
  exec "${SHELL:-/bin/sh}" -c "$cmd"
}

bootstrap() {
  if ! cmd=$(decode "$CCAP_CMD_B64"); then
    echo "$me: cannot decode the command" >&2
    exit 255
  fi
  token=${CCAP_TOKEN:-}
  case $token in '' | *[!0-9a-f]*) plain ;; esac
  host=$(uname -n)

  # The first base that is writable and lets us run what we put there.
  dir=
  while IFS= read -r base; do
    [ -n "$base" ] && [ -d "$base" ] && [ -w "$base" ] || continue
    sweep "$base"
    try=$base/$me-$token
    mkdir -m 700 "$try" 2> /dev/null || continue
    if printf '%s@%s\n' "$$" "$host" > "$try/owner.pid" &&
      printf '#!/bin/sh\nexit 0\n' > "$try/x" && chmod 700 "$try/x" && "$try/x" 2> /dev/null; then
      rm -f "$try/x"
      dir=$try
      break
    fi
    rm -rf "$try"
  done << EOF
$(bases)
EOF
  [ -n "$dir" ] || plain

  # The relay ends on a "stop" line: no pid to kill, nothing ps must find.
  trap '[ -p "$dir/req" ] && printf "stop\n" 1<> "$dir/req"; rm -rf "$dir"' EXIT
  # The wrapper's stop, or a hangup: end the command and whatever it started, as a hangup
  # of a terminal would.
  trap 'trap "" HUP INT TERM; kill -HUP 0 2> /dev/null; exit 129' HUP INT TERM
  if ! { decode "$CCAP_ASKPASS_B64" > "$dir/askpass" &&
    decode "$CCAP_SSH_B64" > "$dir/ssh" &&
    decode "$CCAP_EXE_B64" > "$dir/exe-of" &&
    decode "$CCAP_RS_B64" > "$dir/remote.sh" &&
    sudo_wrapper > "$dir/sudo" &&
    chmod 700 "$dir/askpass" "$dir/ssh" "$dir/exe-of" "$dir/sudo" &&
    mkfifo "$dir/req"; }; then
    echo "$me: cannot set up $dir; running without the pane" >&2
    rm -rf "$dir"
    trap - EXIT HUP INT TERM
    plain
  fi
  unset CCAP_TOKEN CCAP_RS_B64 CCAP_ASKPASS_B64 CCAP_SSH_B64 CCAP_EXE_B64 CCAP_CMD_B64
  SUDO_ASKPASS=$dir/askpass
  SSH_ASKPASS=$dir/askpass
  SSH_ASKPASS_REQUIRE=force
  CC_ASKPASS_DIR=$dir
  CC_ASKPASS_REMOTE=1
  PATH=$dir:$PATH
  export SUDO_ASKPASS SSH_ASKPASS SSH_ASKPASS_REQUIRE CC_ASKPASS_DIR CC_ASKPASS_REMOTE PATH

  # The relay starts alongside; a prompt before it listens would fail. Without it (sshd
  # refused the session) the askpass fails with its own message.
  i=0
  while [ "$i" -lt 50 ]; do
    IFS= read -r relay 2> /dev/null < "$dir/relay.pid" && kill -0 "$relay" 2> /dev/null && break
    nap
    i=$((i + step))
  done

  # In the foreground, as ssh runs it: a background command would start with SIGINT and
  # SIGQUIT ignored. The wrapper's stop hangs up the whole process group. The shell reports a
  # command killed by a signal ("Hangup") on the stderr the command was given, and on a closed
  # channel that write would end us (SIGPIPE) before the EXIT trap: so the command gets the
  # channel inside a subshell, and the report goes to our /dev/null.
  exec 4>&2 2> /dev/null
  (exec "${SHELL:-/bin/sh}" -c "$cmd" 2>&4 4>&-)
  exit "$?"
}

relay() {
  i=0
  until find_dir "$1" && [ -p "$dir/req" ]; do
    [ "$i" -lt 100 ] || exit 1
    # An empty line, which the wrapper skips: once the connection is gone (no token directory
    # will come) the write ends this relay.
    echo || exit 1
    nap
    i=$((i + step))
  done
  # Read-write so it never sees EOF; open before the bootstrap can see relay.pid and leave.
  exec 3<> "$dir/req"
  printf '%s\n' "$$" > "$dir/relay.pid"
  while IFS= read -r line <&3; do
    [ "$line" = stop ] && exit 0
    pid=${line%%"$tab"*}
    case $pid in '' | *[!0-9]*) continue ;; esac
    if verify "$pid"; then
      printf '%s\n' "$line"
    elif [ -p "$dir/reply.$pid" ]; then
      # Ours, but not for the pane: an empty answer makes it fail at once.
      printf '\n' 1<> "$dir/reply.$pid"
    fi
  done
}

# The same checks as REPLY_SCRIPT in hooks/register.tsx, on this host.
reply() {
  case $2 in '' | *[!0-9]*) exit 1 ;; esac
  find_dir "$1" || exit 1
  fifo=$dir/reply.$2
  [ -p "$fifo" ] || exit 1
  exec 3<> "$fifo"
  [ -p /dev/fd/3 ] || {
    rm -f "$fifo"
    exit 1
  }
  cat >&3
}

# pgid_of PID: the process group of PID.
pgid_of() {
  if [ -r "/proc/$1/stat" ]; then
    IFS= read -r stat < "/proc/$1/stat"
    # After "(comm) ": state, ppid, pgrp.
    # shellcheck disable=SC2086
    set -- ${stat##*") "}
    printf '%s\n' "$3"
  else
    ps -o pgid= -p "$1" 2> /dev/null | tr -d ' '
  fi
}

# stop TOKEN: hang up the bootstrap's process group (sshd makes one per session), which ends
# the command it waits on; the bootstrap's own trap then cleans up.
stop() {
  find_dir "$1" || exit 0
  IFS= read -r owner < "$dir/owner.pid" || exit 0
  owner=${owner%%@*}
  pgid=$(pgid_of "$owner")
  case $pgid in
    '' | 0 | 1 | *[!0-9]*) kill -HUP "$owner" 2> /dev/null ;;
    *) kill -HUP -"$pgid" 2> /dev/null ;;
  esac
}

# Tests source the file for its functions.
[ "${CCAP_RS_LIB:-}" = 1 ] && return

case ${1:-} in
  relay) relay "${2:-}" ;;
  reply) reply "${2:-}" "${3:-}" ;;
  stop) stop "${2:-}" ;;
  *) bootstrap ;;
esac
