#!/bin/sh
# cc-askpass remote side. The ssh wrapper sends this file base64-encoded inside its remote
# command and evals it there with /bin/sh:
#
#   (no argument)          Bootstrap, with CCAP_TOKEN, CCAP_RS_B64 (this file), CCAP_ASKPASS_B64,
#                          CCAP_SSH_B64 and CCAP_CMD_B64 in the environment: set up the token
#                          directory and run the command with the remote askpass.
#   relay <token>          Copy the token directory's request FIFO to stdout.
#   reply <token> <pid>    Copy stdin (the answer) into the helper's reply FIFO.
#   stop <token>           Hang up the bootstrap: the wrapper was interrupted.
#
# It never writes to stdout except the relayed request lines; diagnostics go to stderr.

me=cc-askpass
umask 077

decode() {
  printf %s "$1" | base64 -d 2> /dev/null || printf %s "$1" | base64 -D
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
# bootstrap killed), and the relay that still waits on one. The owner is "<pid>@<host>": a home
# shared over NFS holds other hosts' too.
sweep() {
  for old in "$1/$me"-*; do
    [ -d "$old" ] && [ ! -L "$old" ] && [ -O "$old" ] && [ -f "$old/owner.pid" ] || continue
    IFS= read -r owner < "$old/owner.pid"
    [ "${owner#*@}" = "$host" ] || continue
    kill -0 "${owner%%@*}" 2> /dev/null && continue
    kill_relay "$old"
    rm -rf "$old"
  done
}

# kill_relay DIR: end the relay of token directory DIR. The pid file may be stale: only a
# process whose args end in "relay <token>" is it.
kill_relay() {
  IFS= read -r relay 2> /dev/null < "$1/relay.pid" || return
  case $(ps -o args= -p "$relay" 2> /dev/null) in
    *" relay ${1##*-}") kill "$relay" 2> /dev/null ;;
  esac
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
  unset CCAP_TOKEN CCAP_RS_B64 CCAP_ASKPASS_B64 CCAP_SSH_B64 CCAP_CMD_B64
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

  trap 'kill_relay "$dir"; rm -rf "$dir"' EXIT
  # The wrapper's stop, or a hangup: end the command and whatever it started, as a hangup
  # of a terminal would.
  trap 'trap "" HUP INT TERM; kill -HUP 0 2> /dev/null; exit 129' HUP INT TERM
  if ! { decode "$CCAP_ASKPASS_B64" > "$dir/askpass" &&
    decode "$CCAP_SSH_B64" > "$dir/ssh" &&
    decode "$CCAP_RS_B64" > "$dir/remote.sh" &&
    sudo_wrapper > "$dir/sudo" &&
    chmod 700 "$dir/askpass" "$dir/ssh" "$dir/sudo" &&
    mkfifo "$dir/req"; }; then
    echo "$me: cannot set up $dir; running without the pane" >&2
    rm -rf "$dir"
    trap - EXIT HUP INT TERM
    plain
  fi
  unset CCAP_TOKEN CCAP_RS_B64 CCAP_ASKPASS_B64 CCAP_SSH_B64 CCAP_CMD_B64
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
    i=$((i + 1))
    sleep 0.1
  done

  # In the background so the traps run at once; stdin passed on explicitly, as a background
  # command would get /dev/null.
  { "${SHELL:-/bin/sh}" -c "$cmd" <&3 3<&- & } 3<&0
  # The shell reports a command killed by a signal on stderr, which may be a closed channel
  # by then: SIGPIPE would end us before the EXIT trap.
  wait "$!" 2> /dev/null
  exit "$?"
}

relay() {
  i=0
  until find_dir "$1" && [ -p "$dir/req" ]; do
    i=$((i + 1))
    [ "$i" -gt 100 ] && exit 1
    # An empty line, which the wrapper skips: once the connection is gone (no token directory
    # will come) the write ends this relay.
    echo || exit 1
    sleep 0.1
  done
  printf '%s\n' "$$" > "$dir/relay.pid"
  # Read-write so it never sees EOF; builtins only, so the bootstrap's kill leaves no child.
  exec 3<> "$dir/req"
  while IFS= read -r line <&3; do
    printf '%s\n' "$line"
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

stop() {
  find_dir "$1" || exit 0
  IFS= read -r owner < "$dir/owner.pid" && kill -HUP "${owner%%@*}" 2> /dev/null
}

case ${1:-} in
  relay) relay "${2:-}" ;;
  reply) reply "${2:-}" "${3:-}" ;;
  stop) stop "${2:-}" ;;
  *) bootstrap ;;
esac
