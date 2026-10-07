#!/bin/sh
# Shell tests for bin/shim/ssh. Run on Linux/WSL: sh tests/ssh.sh
set -u

root=$(cd "$(dirname "$0")/.." && pwd)
wrapper="$root/bin/shim/ssh"
shimdir="$root/bin/shim"
failures=0

fail() {
  echo "FAIL: $current: $*"
  failures=$((failures + 1))
}

setup() {
  current=$1
  tmp=$(mktemp -d)
  mkdir "$tmp/fake" "$tmp/dir"
  # A recording ssh: one argument per line, a marker on stdout, a chosen exit status.
  cat > "$tmp/fake/ssh" << 'FAKE'
#!/bin/sh
printf '%s\n' "$@" > "$FAKE_SSH_ARGS"
echo fake-out
exit "${FAKE_SSH_STATUS:-0}"
FAKE
  chmod +x "$tmp/fake/ssh"
  printf '%s\n' "$$" > "$tmp/dir/serve.pid"
}

teardown() {
  rm -rf "$tmp"
}

# run_wrapper ARGS...: the wrapper with a live listener, the fake ssh found after the shim dir is removed.
run_wrapper() {
  env PATH="$shimdir:$tmp/fake:$PATH" CC_ASKPASS_DIR="$tmp/dir" SSH_ASKPASS=/x \
    FAKE_SSH_ARGS="$tmp/args" sh "$wrapper" "$@" > "$tmp/out" 2> "$tmp/err"
}

# passes_through ARGS...: the fake ssh got exactly ARGS.
passes_through() {
  setup "pass-through: $*"
  run_wrapper "$@"
  printf '%s\n' "$@" > "$tmp/expected"
  cmp -s "$tmp/args" "$tmp/expected" || fail "fake got: $(cat "$tmp/args" 2> /dev/null)"
  teardown
}

test_exclude() {
  setup 'exclude glob'
  CC_ASKPASS_EXCLUDE='*.internal' run_wrapper db.internal sudo true
  printf '%s\n' db.internal sudo true | cmp -s - "$tmp/args" || fail 'args changed'
  teardown
}

test_no_listener() {
  setup 'no listener'
  echo 99999999 > "$tmp/dir/serve.pid"
  run_wrapper h sudo true
  printf '%s\n' h sudo true | cmp -s - "$tmp/args" || fail 'args changed'
  teardown
}

test_status_and_stdout() {
  setup 'status and stdout'
  FAKE_SSH_STATUS=7 run_wrapper h
  status=$?
  [ "$status" = 7 ] || fail "status $status"
  [ "$(cat "$tmp/out")" = fake-out ] || fail "stdout: $(cat "$tmp/out")"
  teardown
}

test_only_itself() {
  setup 'only itself on PATH'
  env PATH="$shimdir" "$(command -v sh)" "$wrapper" h > "$tmp/out" 2> "$tmp/err"
  status=$?
  [ "$status" = 255 ] || fail "status $status"
  grep -q 'cc-askpass: the ssh wrapper found only itself on PATH' "$tmp/err" || fail "stderr: $(cat "$tmp/err")"
  [ ! -s "$tmp/out" ] || fail 'wrote to stdout'
  teardown
}

# parse ARGS...: print host|command|tty_opts|caller_ctl|pass_flag as parse_args sets them.
parse() {
  (
    CC_ASKPASS_SHIM_LIB=1
    . "$wrapper"
    parse_args "$@"
    printf '%s|%s|%s|%s|%s\n' "$host" "$command" "$tty_opts" "$caller_ctl" "$pass_flag"
  )
}

expect_parse() {
  want=$1
  shift
  setup "parse: $*"
  got=$(parse "$@")
  [ "$got" = "$want" ] || fail "got '$got', want '$want'"
  teardown
}

test_opts_roundtrip() {
  setup 'opts keep words with spaces'
  got=$(
    CC_ASKPASS_SHIM_LIB=1
    . "$wrapper"
    parse_args -o "ProxyCommand ssh -W %h:%p jump" -p 22 h cmd
    eval "set -- $opts"
    printf '%s|%s|%s|%s|%s' "$#" "$1" "$2" "$3" "$4"
  )
  [ "$got" = '4|-o|ProxyCommand ssh -W %h:%p jump|-p|22' ] || fail "got '$got'"
  teardown
}

# decide ARGS...: print wrap or no, as should_wrap answers with the t_* settings.
decide() {
  (
    CC_ASKPASS_SHIM_LIB=1
    . "$wrapper"
    CC_ASKPASS_DIR="$tmp/dir"
    SSH_ASKPASS=${t_askpass-/x}
    CC_ASKPASS_EXCLUDE=${t_exclude-}
    parse_args "$@"
    if should_wrap; then echo wrap; else echo no; fi
  )
}

# expect_decision WANT ARGS...: t_mode (relay, dead), t_askpass and t_exclude set the scene.
expect_decision() {
  want=$1
  shift
  setup "decision ${t_mode:-live}/${t_exclude:-}: $*"
  case ${t_mode-} in
    relay) mv "$tmp/dir/serve.pid" "$tmp/dir/relay.pid" ;;
    dead) echo 99999999 > "$tmp/dir/serve.pid" ;;
  esac
  got=$(decide "$@")
  [ "$got" = "$want" ] || fail "got '$got', want '$want'"
  teardown
  t_mode= t_exclude= t_askpass=/x
}

test_two_wrappers() {
  setup 'two wrapper copies on PATH'
  mkdir "$tmp/a" "$tmp/b"
  cp "$wrapper" "$tmp/a/ssh"
  cp "$wrapper" "$tmp/b/ssh"
  env PATH="$tmp/a:$tmp/b:$tmp/fake:$PATH" FAKE_SSH_ARGS="$tmp/args" sh "$tmp/a/ssh" h > "$tmp/out" 2> "$tmp/err"
  [ "$(cat "$tmp/out")" = fake-out ] || fail "fake not reached: $(cat "$tmp/err")"
  teardown
}

passes_through host
passes_through -N -L 1:a:2 host
passes_through -O check host
passes_through -s host sftp
passes_through -f host cmd
passes_through git@github.com git-upload-pack 'a/b.git'
passes_through h scp -t /x
passes_through h rsync --server -e.L . /x
test_exclude
test_no_listener
test_status_and_stdout
test_only_itself
test_two_wrappers

t_mode= t_exclude= t_askpass=/x
expect_decision wrap h sudo true
expect_decision no h /usr/bin/git-upload-pack x
expect_decision no h scp -t /x
expect_decision no h rsync --server -e.L . /x
expect_decision no h borg serve --restrict-to-path /r
expect_decision wrap h sudo rsync --server -e.L . /x
t_exclude='*.internal' expect_decision no alice@db.internal sudo true
t_exclude='*.internal' expect_decision no ssh://alice@db.internal:2222 sudo true
t_exclude='*.internal' expect_decision wrap alice@db.example sudo true
t_exclude='fe80::1' expect_decision no fe80::1 sudo true
t_mode=relay expect_decision wrap h sudo true
t_mode=dead expect_decision no h sudo true
t_askpass= expect_decision no h sudo true
expect_decision no -N h sudo true
expect_decision no h -N -L 1:a:2

expect_parse 'h|cmd|-t||' -tp22 h cmd
expect_parse 'h|a b||/c|' -o ControlPath=/c -p 2 h a b
expect_parse 'h|a||/c|' -oControlPath=/c h a
expect_parse 'h|a||/c|' -o 'ControlPath /c' h a
expect_parse 'h|a||/c|' -o controlpath=/c h a
expect_parse 'h|x||/b|' -o ControlPath=/a -S /b h x
expect_parse 'h|x||/b|' -S /a -S /b h x
expect_parse 'h|x||/a|' -o ControlPath=/a -o ControlPath=/b h x
expect_parse 'h|sudo ls||/x|' h -o ControlPath=/x sudo ls
expect_parse 'h|cmd|-t||' h -p 2 -t cmd
expect_parse 'h||||1' h -N -L 1:a:2
expect_parse 'h|-t x|||' -- h -t x
expect_parse 'h|cmd|||' -- h cmd
expect_parse 'ssh://u@h:2|cmd|||' ssh://u@h:2 cmd
expect_parse 'h|x||/c|' -S /c h x
expect_parse 'h|cmd|-t -t -t||' -t -tt h cmd
expect_parse 'h||||1' -N h
test_opts_roundtrip

setup 'opts after the host'
got=$(
  CC_ASKPASS_SHIM_LIB=1
  . "$wrapper"
  parse_args h -p 2 -t cmd
  eval "set -- $opts"
  printf '%s|%s|%s|%s' "$1" "$2" "$3" "$#"
)
[ "$got" = '-p|2|-t|3' ] || fail "got '$got'"
teardown

# ---- End to end: the wrapper against sshds of our own on 127.0.0.1, as this user ----

askpass="$root/bin/askpass"
tab=$(printf '\t')

# bounded SECONDS COMMAND...: run COMMAND with this stdin, killed after SECONDS (macOS has no
# timeout). Exits 124 when it had to be killed.
bounded() {
  seconds=$1
  shift
  { "$@" <&3 3<&- & } 3<&0
  bounded_pid=$!
  (sleep "$seconds" && kill "$bounded_pid") > /dev/null 2>&1 &
  watchdog_pid=$!
  wait "$bounded_pid"
  bounded_status=$?
  kill "$watchdog_pid" 2> /dev/null || return 124
  wait "$watchdog_pid" 2> /dev/null
  return "$bounded_status"
}

# start_sshd DIR [CONFIG LINE]: an sshd for this user with fresh keys, and DIR/cfg for clients.
start_sshd() {
  d=$1
  mkdir "$d" || return 1
  ssh-keygen -q -t ed25519 -N '' -f "$d/host_key" || return 1
  ssh-keygen -q -t ed25519 -N '' -f "$d/client_key" || return 1
  cp "$d/client_key.pub" "$d/authorized_keys"
  tries=0
  while [ "$tries" -lt 5 ]; do
    tries=$((tries + 1))
    port=$((20000 + $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 30000))
    cat > "$d/sshd_config" << EOF
Port $port
ListenAddress 127.0.0.1
HostKey $d/host_key
AuthorizedKeysFile $d/authorized_keys
PidFile $d/sshd.pid
StrictModes no
UsePAM no
SetEnv PATH=$e2e/fakebin:/usr/local/bin:/usr/bin:/bin
${2:-}
EOF
    "$sshd" -f "$d/sshd_config" -E "$d/sshd.log" || continue
    cat > "$d/cfg" << EOF
Host *
  HostName 127.0.0.1
  Port $port
  IdentityFile $d/client_key
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
EOF
    # The pid file appears once sshd listens.
    i=0
    while [ ! -s "$d/sshd.pid" ] && [ "$i" -lt 50 ]; do
      i=$((i + 1))
      sleep 0.1
    done
    [ -s "$d/sshd.pid" ] && return 0
  done
  return 1
}

stop_sshd() {
  [ -s "$1/sshd.pid" ] && kill "$(cat "$1/sshd.pid")" 2> /dev/null
}

# answer_requests: what the mod does, minus the pane — answer every request with test-pw and
# record the line with the args of the helper's parent.
answer_requests() {
  IFS= read -r ready || return
  printf '%s\n' "${ready#*"$tab"}" > "$e2e/ldir.new"
  mv "$e2e/ldir.new" "$e2e/ldir"
  while IFS= read -r line; do
    pid=${line%%"$tab"*}
    ppid=$(ps -o ppid= -p "$pid" 2> /dev/null | tr -d ' ')
    printf '%s\t%s\n' "$line" "$(ps -o args= -p "$ppid" 2> /dev/null)" >> "$e2e/seen"
    printf 'test-pw\n' > "${ready#*"$tab"}/reply.$pid"
  done
}

start_listener() {
  rm -f "$e2e/ldir"
  : > "$e2e/seen"
  : > "$e2e/sudo.args"
  XDG_RUNTIME_DIR="$e2e/run" "$askpass" --serve e2e 2> /dev/null | answer_requests &
  listener=$!
  i=0
  while [ ! -s "$e2e/ldir" ] && [ "$i" -lt 50 ]; do
    i=$((i + 1))
    sleep 0.1
  done
  ldir=$(cat "$e2e/ldir")
}

stop_listener() {
  kill "$(cat "$ldir/serve.pid")" 2> /dev/null
  wait "$listener" 2> /dev/null
}

# wssh ARGS...: ssh as Claude's Bash runs it, the wrapper first on PATH, with a 30 s limit.
wssh() {
  bounded 30 env PATH="$shimdir:$PATH" CC_ASKPASS_DIR="$ldir" SSH_ASKPASS="$askpass" ssh "$@"
}

e2e_test() {
  current=$1
  start_listener
}

e2e_done() {
  stop_listener
  if pgrep -f "$wrapper --relay" > /dev/null; then
    fail "relay left running: $(pgrep -fa "$wrapper --relay")"
    pkill -f "$wrapper --relay"
  fi
}

# seen_field N: field N of the first request line the listener saw (5 is the parent's args).
seen_field() {
  head -n 1 "$e2e/seen" | cut -f "$1"
}

# remote_dirs: the token directories under the remote bases (the same machine here).
remote_dirs() {
  ls -d "$HOME/.cache"/cc-askpass-* /tmp/cc-askpass-* 2> /dev/null
}

run_e2e() {
  cfg=$e2e/a/cfg

  e2e_test 'asks through the relay'
  out=$(wssh -F "$cfg" localhost 'printf %s "$($SUDO_ASKPASS "Password: ")"')
  [ "$out" = test-pw ] || fail "out: $out"
  [ "$(wc -l < "$e2e/seen")" -eq 1 ] || fail "seen: $(cat "$e2e/seen")"
  [ "$(seen_field 2)" = 'Password: ' ] || fail "prompt: $(seen_field 2)"
  [ "$(seen_field 3)" = localhost ] || fail "via: $(seen_field 3)"
  [ -n "$(seen_field 4)" ] || fail 'reported is empty'
  case $(seen_field 5) in
    "$wrapper --relay localhost" | *" $wrapper --relay localhost") ;;
    *) fail "parent: $(seen_field 5)" ;;
  esac
  e2e_done

  e2e_test 'sudo wrapper adds -A'
  wssh -F "$cfg" localhost 'sudo true; sudo -S true; sudo -n true' > /dev/null
  printf '%s\n' '-A true' '-S true' '-n true' | cmp -s - "$e2e/sudo.args" || fail "sudo got: $(cat "$e2e/sudo.args")"
  e2e_done

  e2e_test 'wrapped command keeps quoting'
  out=$(wssh -F "$cfg" localhost 'echo "a  b" | grep -c "a  b"')
  [ "$out" = 1 ] || fail "grep: $out"
  # shellcheck disable=SC2016
  out=$(wssh -F "$cfg" localhost echo '$HOME')
  [ "$out" = "$HOME" ] || fail "home: $out"
  e2e_done

  e2e_test 'reuses a caller master'
  ssh -F "$cfg" -M -S "$e2e/caller.ctl" -o ControlPersist=yes -N -f localhost
  out=$(wssh -F "$cfg" -S "$e2e/caller.ctl" localhost 'printf %s "$($SUDO_ASKPASS P)"')
  [ "$out" = test-pw ] || fail "out: $out"
  ssh -S "$e2e/caller.ctl" -O check localhost 2> /dev/null || fail 'caller master closed'
  ssh -S "$e2e/caller.ctl" -O exit localhost 2> /dev/null
  e2e_done

  e2e_test 'stdout is untouched'
  head -c 256 /dev/urandom > "$e2e/bytes"
  wssh -F "$cfg" localhost cat < "$e2e/bytes" > "$e2e/bytes.out"
  cmp -s "$e2e/bytes" "$e2e/bytes.out" || fail 'bytes differ'
  e2e_done

  e2e_test 'exit status and stdin pass through'
  out=$(printf x | wssh -F "$cfg" localhost 'cat; exit 7')
  status=$?
  [ "$out" = x ] || fail "out: $out"
  [ "$status" = 7 ] || fail "status $status"
  e2e_done

  e2e_test 'second hop'
  out=$(wssh -F "$cfg" localhost "ssh -F $cfg localhost 'printf %s \"\$(\$SUDO_ASKPASS P)\"'")
  [ "$out" = test-pw ] || fail "out: $out"
  # Every wrapper names the host it relays from (spec 4.6); the mod drops the verified last one.
  [ "$(seen_field 3)" = 'localhost via localhost' ] || fail "via: $(seen_field 3)"
  e2e_done

  e2e_test 'probe failure runs unwrapped'
  out=$(wssh -F "$e2e/forced/cfg" localhost sudo true)
  [ "$out" = forced ] || fail "out: $out"
  [ ! -s "$e2e/seen" ] || fail "listener saw: $(cat "$e2e/seen")"
  [ ! -s "$e2e/sudo.args" ] || fail "sudo ran: $(cat "$e2e/sudo.args")"
  e2e_done

  e2e_test 'ssh -tt still asks'
  wssh -tt -F "$cfg" localhost 'sudo true' > /dev/null 2>&1
  printf '%s\n' '-A true' | cmp -s - "$e2e/sudo.args" || fail "sudo got: $(cat "$e2e/sudo.args")"
  e2e_done

  e2e_test 'killed wrapper cleans up'
  before=$(remote_dirs)
  env PATH="$shimdir:$PATH" CC_ASKPASS_DIR="$ldir" SSH_ASKPASS="$askpass" ssh -F "$cfg" localhost 'sleep 31' &
  killed=$!
  sleep 2
  [ "$(remote_dirs)" != "$before" ] || fail 'no token directory while running'
  kill -TERM "$killed"
  i=0
  while [ "$i" -lt 50 ]; do
    i=$((i + 1))
    pgrep -f "$wrapper --relay" > /dev/null || pgrep -f -- "-S $ldir/s\." > /dev/null ||
      pgrep -f "^sleep 31$" > /dev/null || [ "$(remote_dirs)" != "$before" ] || break
    sleep 0.1
  done
  pgrep -f "$wrapper --relay" > /dev/null && fail 'relay still running'
  pgrep -f -- "-S $ldir/s\." > /dev/null && fail "master still running: $(pgrep -fa -- "-S $ldir/s\.")"
  [ "$(remote_dirs)" = "$before" ] || fail "token directory left: $(remote_dirs)"
  pgrep -f "^sleep 31$" > /dev/null && fail "remote command still running"
  wait "$killed" 2> /dev/null
  e2e_done

  e2e_test 'no usable base directory'
  out=$(CCAP_TEST_BASES=/nonexistent wssh -F "$cfg" localhost 'echo ran; echo "${SUDO_ASKPASS:-unset}"')
  [ "$out" = "$(printf 'ran\nunset')" ] || fail "out: $out"
  e2e_done
}

# The bootstrap line goes through the remote login shell: every common one must read it alike.
test_login_shells() {
  line=$(
    CC_ASKPASS_SHIM_LIB=1
    . "$wrapper"
    self=$wrapper lib=$root/bin token=0123456789abcdef CCAP_TEST_BASES=/nonexistent
    bootstrap_line 'echo ok'
  )
  for shell in sh bash zsh fish; do
    current="login shell $shell"
    if ! command -v "$shell" > /dev/null; then
      echo "SKIP: $current: not installed"
      continue
    fi
    out=$(bounded 10 "$shell" -c "$line" 2> "$e2e/shell.err")
    [ "$out" = ok ] || fail "out: $out $(cat "$e2e/shell.err")"
  done
}

sshd=$(command -v sshd || echo /usr/sbin/sshd)
e2e=$(mktemp -d)
mkdir "$e2e/fakebin" "$e2e/run"
chmod 700 "$e2e/run"
# A fake sudo that records its arguments, found right after the token directory on PATH.
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> %s/sudo.args\n' "$e2e" > "$e2e/fakebin/sudo"
chmod +x "$e2e/fakebin/sudo"
test_login_shells
if [ ! -x "$sshd" ]; then
  echo 'SKIP: no usable sshd'
elif start_sshd "$e2e/a" && start_sshd "$e2e/forced" 'ForceCommand /bin/echo forced'; then
  run_e2e
elif [ "$(uname)" = Linux ]; then
  current='start sshd'
  fail "$(cat "$e2e"/*/sshd.log 2> /dev/null)"
else
  echo 'SKIP: no usable sshd'
fi
stop_sshd "$e2e/a"
stop_sshd "$e2e/forced"
rm -rf "$e2e"

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo 'PASS: all ssh wrapper tests'
