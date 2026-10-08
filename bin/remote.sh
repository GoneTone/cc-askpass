#!/bin/sh
# cc-askpass remote side. The ssh wrapper sends this file base64-encoded inside its remote
# command and evals it there with /bin/sh:
#
#   (no argument)          Bootstrap, with CCAP_TOKEN, CCAP_RS_B64 (this file), CCAP_ASKPASS_B64,
#                          CCAP_SSH_B64 and CCAP_CMD_B64 in the environment: set
#                          up the token directory and run the command with the remote askpass.
#   relay <token>          Copy every well-formed request from the token directory's
#                          request FIFO to stdout; the local side judges nothing, it shows.
#   reply <token> <pid>    Copy stdin (the answer) into the helper's reply FIFO.
#   stop <token>           Hang up the bootstrap's process group: the wrapper was interrupted.
#
# Without connection multiplexing (Windows) two plain connections replace the bootstrap:
#
#   serve-stdin <token>    With CCAP_RS_B64 (this file) in the environment. Stdin line 1 is
#                          "<askpass b64> <ssh wrapper b64>". Set up the token directory,
#                          print "cc-askpass-ready <dir>" (or "cc-askpass-failed"), relay the
#                          requests to stdout and write the stdin lines "<pid><TAB><password>"
#                          into the helpers' reply FIFOs. Stdin EOF: clean up.
#   run                    With CCAP_DIR (that directory) and CCAP_CMD_B64: run the command
#                          with the remote askpass.
#
# It never writes to stdout except the relayed request lines; diagnostics go to stderr.

me=cc-askpass
umask 077
tab=$(printf '\t')

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
  { IFS= read -r line1 && IFS= read -r line2; } 2> /dev/null < "$entry/sudo"
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
    # Long options whose value is the next word.
    --user | --group | --host | --prompt | --chdir | --role | --type | --other-user | --close-from | --command-timeout) skip=1 ;;
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
  unset CCAP_TOKEN CCAP_RS_B64 CCAP_ASKPASS_B64 CCAP_SSH_B64 CCAP_CMD_B64 CCAP_DIR
  exec "${SHELL:-/bin/sh}" -c "$cmd"
}

# choose_dir: set dir to a fresh token directory (owner.pid written) in the first base that is
# writable and lets us run what we put there, or to nothing. Needs token and host.
choose_dir() {
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
}

# install_files ASKPASS_B64 SSH_B64 RS_B64: fill dir.
install_files() {
  decode "$1" > "$dir/askpass" &&
    decode "$2" > "$dir/ssh" &&
    decode "$3" > "$dir/remote.sh" &&
    sudo_wrapper > "$dir/sudo" &&
    chmod 700 "$dir/askpass" "$dir/ssh" "$dir/sudo" &&
    mkfifo "$dir/req"
}

# run_command: run cmd the way ssh would, with the remote askpass in its environment.
run_command() {
  unset CCAP_TOKEN CCAP_RS_B64 CCAP_ASKPASS_B64 CCAP_SSH_B64 CCAP_CMD_B64 CCAP_DIR
  SUDO_ASKPASS=$dir/askpass
  SSH_ASKPASS=$dir/askpass
  SSH_ASKPASS_REQUIRE=force
  CC_ASKPASS_DIR=$dir
  CC_ASKPASS_REMOTE=1
  CC_ASKPASS_WRAP=1
  PATH=$dir:$PATH
  export SUDO_ASKPASS SSH_ASKPASS SSH_ASKPASS_REQUIRE CC_ASKPASS_DIR CC_ASKPASS_REMOTE CC_ASKPASS_WRAP PATH

  # In the foreground, as ssh runs it: a background command would start with SIGINT and
  # SIGQUIT ignored. The wrapper's stop hangs up the whole process group. The shell reports a
  # command killed by a signal ("Hangup") on the stderr the command was given, and on a closed
  # channel that write would end us (SIGPIPE) before the EXIT trap: so the command gets the
  # channel inside a subshell, and the report goes to our /dev/null.
  exec 4>&2 2> /dev/null
  (exec "${SHELL:-/bin/sh}" -c "$cmd" 2>&4 4>&-)
  exit "$?"
}

bootstrap() {
  if ! cmd=$(decode "$CCAP_CMD_B64"); then
    echo "$me: cannot decode the command" >&2
    exit 255
  fi
  token=${CCAP_TOKEN:-}
  case $token in '' | *[!0-9a-f]*) plain ;; esac
  host=$(uname -n)
  choose_dir
  [ -n "$dir" ] || plain

  # The relay ends on a "stop" line: no pid to kill, nothing ps must find.
  trap '[ -p "$dir/req" ] && printf "stop\n" 1<> "$dir/req"; rm -rf "$dir"' EXIT
  # The wrapper's stop, or a hangup: end the command and whatever it started, as a hangup
  # of a terminal would.
  trap 'trap "" HUP INT TERM; kill -HUP 0 2> /dev/null; exit 129' HUP INT TERM
  if ! install_files "$CCAP_ASKPASS_B64" "$CCAP_SSH_B64" "$CCAP_RS_B64"; then
    echo "$me: cannot set up $dir; running without the pane" >&2
    rm -rf "$dir"
    trap - EXIT HUP INT TERM
    plain
  fi

  # The relay starts alongside; a prompt before it listens would fail. Without it (sshd
  # refused the session) the askpass fails with its own message.
  i=0
  while [ "$i" -lt 50 ]; do
    IFS= read -r relay 2> /dev/null < "$dir/relay.pid" && kill -0 "$relay" 2> /dev/null && break
    nap
    i=$((i + step))
  done
  run_command
}

# run: the command connection of a relay over a plain connection; serve-stdin made CCAP_DIR.
run() {
  if ! cmd=$(decode "$CCAP_CMD_B64"); then
    echo "$me: cannot decode the command" >&2
    exit 255
  fi
  dir=${CCAP_DIR:-}
  case ${dir##*/} in $me-*) ;; *) plain ;; esac
  [ -d "$dir" ] && [ ! -L "$dir" ] && [ -O "$dir" ] && [ -p "$dir/req" ] || plain
  [ -n "$(find "$dir" -prune -perm 700 2> /dev/null)" ] || plain
  run_command
}

# relay_loop: print the well-formed request lines from fd 3 until the "stop" line.
relay_loop() {
  while IFS= read -r line <&3; do
    [ "$line" = stop ] && return 0
    pid=${line%%"$tab"*}
    case $pid in '' | *[!0-9]*) continue ;; esac
    printf '%s\n' "$line"
  done
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
  relay_loop
}

# open_reply FIFO: the same checks as REPLY_SCRIPT in hooks/register.tsx, on this host; fd 3
# is then the helper's reply FIFO.
open_reply() {
  [ -p "$1" ] || return 1
  exec 3<> "$1"
  [ -p /dev/fd/3 ] || {
    rm -f "$1"
    return 1
  }
}

reply() {
  case $2 in '' | *[!0-9]*) exit 1 ;; esac
  find_dir "$1" || exit 1
  open_reply "$dir/reply.$2" || exit 1
  cat >&3
}

# answers: the stdin lines "<pid><TAB><password>" become the passwords in the helpers' reply
# FIFOs; the password is split off at the first tab and may hold more. At EOF the relay ends.
answers() {
  while IFS= read -r line; do
    pid=${line%%"$tab"*}
    case $pid in '' | *[!0-9]*) continue ;; esac
    case $line in *"$tab"*) ;; *) continue ;; esac
    (open_reply "$dir/reply.$pid" && printf '%s\n' "${line#*"$tab"}" >&3)
  done
  [ -p "$dir/req" ] && printf 'stop\n' 1<> "$dir/req"
}

# serve_stdin TOKEN: the relay connection of a plain connection (see the header).
serve_stdin() {
  token=$1
  host=$(uname -n)
  dir=
  trap 'kill "$reader" 2> /dev/null; [ -z "$dir" ] || rm -rf "$dir"' EXIT
  trap 'exit 0' HUP TERM
  case $token in '' | *[!0-9a-f]*) ;; *) choose_dir ;; esac
  if [ -z "$dir" ] || ! { IFS=' ' read -r askpass_b64 ssh_b64 &&
    install_files "$askpass_b64" "$ssh_b64" "$CCAP_RS_B64"; }; then
    echo "$me: cannot set up the token directory" >&2
    echo cc-askpass-failed
    exit 1
  fi
  unset CCAP_RS_B64
  exec 3<> "$dir/req"
  printf '%s\n' "$$" > "$dir/relay.pid"
  printf 'cc-askpass-ready %s\n' "$dir"
  # A background command's stdin is /dev/null unless it is redirected.
  exec 4<&0
  answers <&4 &
  reader=$!
  relay_loop
  exit 0
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
  serve-stdin) serve_stdin "${2:-}" ;;
  run) run ;;
  *) bootstrap ;;
esac
