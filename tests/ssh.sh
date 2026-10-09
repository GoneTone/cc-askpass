#!/bin/sh
# Shell tests for bin/shim/ssh. Run on Linux/WSL: sh tests/ssh.sh
set -u

root=$(cd "$(dirname "$0")/.." && pwd)
wrapper="$root/bin/shim/ssh"
shimdir="$root/bin/shim"
failures=0
# The mod sets this while remote prompts are on; a test that wants it off unsets it.
CC_ASKPASS_WRAP=1
export CC_ASKPASS_WRAP

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

# parse ARGS...: print host|command|tty_opts|session opts|master opts|pass_flag as parse_args
# sets them (the option lists restored and joined by spaces).
parse() {
  (
    CC_ASKPASS_SHIM_LIB=1
    . "$wrapper"
    parse_args "$@"
    session=$(eval "set -- $session_opts" && echo "$*")
    master=$(eval "set -- $master_opts" && echo "$*")
    printf '%s|%s|%s|%s|%s|%s\n' "$host" "$command" "$tty_opts" "$session" "$master" "$pass_flag"
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
    lib=$root/bin
    SSH_ASKPASS=${t_askpass-$root/bin/askpass}
    CC_ASKPASS_EXCLUDE=${t_exclude-}
    CC_ASKPASS_WRAP=${t_wrap-1}
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
  t_mode= t_exclude= t_askpass=$root/bin/askpass t_wrap=1
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

# The wrapper's own tools come from the system: one on the caller's PATH would run as the
# wrapper's child, where the mod looks for the relay.
setup 'tools are not taken from the caller PATH'
printf '#!/bin/sh\ntouch "%s/readlink-ran"\n' "$tmp" > "$tmp/fake/readlink"
chmod +x "$tmp/fake/readlink"
env PATH="$shimdir:$tmp/fake:$PATH" CC_ASKPASS_DIR="$tmp/dir" SSH_ASKPASS="$root/bin/askpass" \
  FAKE_SSH_ARGS="$tmp/args" sh "$wrapper" h sudo true > "$tmp/out" 2> "$tmp/err"
[ ! -e "$tmp/readlink-ran" ] || fail 'ran the fake readlink'
# Any real ssh is used: the command is wrapped, so the fake sees our master and session options.
grep -qx -- -S "$tmp/args" || fail "not wrapped; fake got: $(cat "$tmp/args" 2> /dev/null)"
teardown

# relay_mode ARGS...: the wrapper in relay mode with one request line on stdin, ARGS as env.
relay_mode() {
  printf '12\tPassword: \t\tsudo true\n' |
    env CC_ASKPASS_DIR="$tmp/dir" CCAP_HOST=h CCAP_TOKEN=0123456789abcdef FAKE_SSH_ARGS="$tmp/args" \
      "$@" sh "$wrapper" --relay h > "$tmp/out" 2> "$tmp/err"
}


setup 'relay refuses a socket it was not given by wrap'
relay_mode CCAP_CTL=/tmp/elsewhere
[ "$?" = 1 ] || fail 'not refused'
grep -q 'relay refused: CCAP_CTL' "$tmp/err" || fail "stderr: $(cat "$tmp/err")"
teardown

# ctl_case WANT CTL [TOKEN]: relay_env_ok for the session directory $tmp/dir.
ctl_case() {
  got=$(
    CC_ASKPASS_SHIM_LIB=1
    . "$wrapper"
    CC_ASKPASS_DIR=$tmp/dir CCAP_CTL=$2 CCAP_TOKEN=${3:-0123456789abcdef}
    if relay_env_ok; then echo ok; else echo refused; fi
  )
  [ "$got" = "$1" ] || fail "$2 ${3:-}: got $got"
}

setup 'relay socket checks'
ccap=$(mktemp -d /tmp/ccap.XXXXXX)
open_ccap=$(mktemp -d /tmp/ccap.XXXXXX)
chmod 755 "$open_ccap"
: > "$tmp/dir/s.2"
if command -v python3 > /dev/null; then
  for sock in "$tmp/dir/s.1" "$ccap/c" "$open_ccap/c"; do
    python3 -c 'import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "$sock"
  done
  ctl_case ok "$tmp/dir/s.1"
  ctl_case ok "$ccap/c"
  ctl_case refused "$tmp/dir/s.1" 'x;y'
  ctl_case refused "$open_ccap/c"
else
  echo 'SKIP: relay socket checks with a socket: no python3'
fi
ctl_case refused "$tmp/dir/s.2"
ctl_case refused "$tmp/dir/../dir/s.1"
ctl_case refused "$tmp/other/s.1"
ctl_case refused "$tmp/dir/s.x/s.1"
ctl_case refused /tmp/ccap.x/y/c
rm -rf "$ccap" "$open_ccap"
teardown

t_mode= t_exclude= t_askpass=$root/bin/askpass
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
# The relay asks the askpass beside the wrapper: another one in SSH_ASKPASS means not ours.
t_askpass=/x expect_decision no h sudo true
# remoteHosts off: the mod unsets the switch, and the wrapper steps aside at once.
t_wrap= expect_decision no h sudo true
expect_decision no -N h sudo true
expect_decision no h -N -L 1:a:2
# ps joins the arguments with spaces: the mod would misread a blank up to the host.
expect_decision no -o 'User alice' h sudo true
expect_decision no '-oUser alice' h sudo true
expect_decision no -o "$(printf 'User\talice')" h sudo true
expect_decision no 'alice smith@h' sudo true
expect_decision wrap -o User=alice h sudo true
expect_decision wrap h -o 'User alice' sudo true

expect_parse 'h|cmd|-t|-t -p 22|-p 22|' -tp22 h cmd
expect_parse 'h|a b||-p 2|-p 2|' -o ControlPath=/c -p 2 h a b
expect_parse 'h|a||||' -oControlPath=/c h a
expect_parse 'h|a||||' -o 'ControlPath /c' h a
expect_parse 'h|a||||' -o controlpath=/c h a
expect_parse 'h|x||||' -o ControlPath=/a -S /b h x
expect_parse 'h|x||||' -S /a -S /b h x
expect_parse 'h|x||||' -M -o ControlMaster=yes -o 'controlmaster auto' h x
expect_parse 'h|x||-o ControlPersist=5|-o ControlPersist=5|' -o ControlPersist=5 h x
expect_parse 'h|sudo ls||||' h -o ControlPath=/x sudo ls
expect_parse 'h|cmd|-t|-p 2 -t|-p 2|' h -p 2 -t cmd
expect_parse 'h|cmd||-T||' -T h cmd
expect_parse 'h|||-N -L 1:a:2|-N -L 1:a:2|1' h -N -L 1:a:2
expect_parse 'h|-t x||||' -- h -t x
expect_parse 'h|cmd||||' -- h cmd
expect_parse 'ssh://u@h:2|cmd||||' ssh://u@h:2 cmd
expect_parse 'h|cmd|-t -t -t|-t -t -t||' -t -tt h cmd
expect_parse 'h|||-N|-N|1' -N h
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

# A PATH the model chose must not decide where our sessions (and the answers) go.
passes_through h sudo true


# OpenSSH binds "<ctl>.<16 chars>" first; macOS allows 104 bytes with the NUL.
setup 'ctl length boundary'
got=$(
  CC_ASKPASS_SHIM_LIB=1
  . "$wrapper"
  pid=$$
  for len in 86 87; do
    CC_ASKPASS_DIR=/$(printf "%0$((len - 4 - ${#pid}))d" 0)
    choose_ctl
    printf '%s:%s ' "${#ctl}" "${ctl_dir:+tmp}"
    [ -z "$ctl_dir" ] || rmdir "$ctl_dir"
  done
)
[ "$got" = '86: 18:tmp ' ] || fail "got '$got'"
teardown

# The remote relay shows every well-formed request: the helper's parent is a plain shell here.
setup 'relay passes every request line'
tok=0123456789abcdef
mkdir -p "$tmp/base/cc-askpass-$tok"
mkfifo "$tmp/base/cc-askpass-$tok/req"
sh -c "printf '%s\tPassword: \tsudo\treported\n' \$\$ > '$tmp/base/cc-askpass-$tok/req'; printf 'x\ty\n' > '$tmp/base/cc-askpass-$tok/req'; echo stop > '$tmp/base/cc-askpass-$tok/req'" &
CCAP_TEST_BASES="$tmp/base" sh "$root/bin/remote.sh" relay "$tok" > "$tmp/out" 2> "$tmp/err"
wait
[ "$(wc -l < "$tmp/out")" -eq 1 ] || fail "out: $(cat "$tmp/out")"
case $(cat "$tmp/out") in *"$(printf '\tPassword: \tsudo\treported')") ;; *) fail "out: $(cat "$tmp/out")" ;; esac
teardown


# The local relay: malformed remote lines are skipped, never asked or answered.
setup 'relay skips malformed lines'
cat > "$tmp/askpass" << 'EOF'
#!/bin/sh
printf '%s|%s|%s|%s\n' "$1" "$CC_ASKPASS_VIA" "$CC_ASKPASS_REPORTED" "${CC_ASKPASS_REMOTE-unset}" >> "$ASKED"
echo pw
EOF
# The reply's remote command ends with "reply <token> <pid>"; the answer comes on stdin.
cat > "$tmp/mux" << 'EOF'
#!/bin/sh
for word; do last=$word; done
printf '%s|%s\n' "${last##* }" "$(cat)" >> "$SENT"
EOF
chmod +x "$tmp/askpass" "$tmp/mux"
# The relay's lib directory: the reply line is built from remote.sh.
cp "$root/bin/remote.sh" "$tmp/"
{
  printf '12\tPassword: \t\tsudo true\n'
  printf 'no tab\n'
  printf 'x1\tP\n'
  printf '\tP\n'
  printf '13\t--serve s\n'
  printf '14\t%s\n' "$(head -c 5000 /dev/zero | tr '\0' a)"
  printf '\n'
  printf '15\tQ\tdb01\tls\n'
} > "$tmp/lines"
(
  CC_ASKPASS_SHIM_LIB=1
  . "$wrapper"
  # The askpass beside the wrapper is asked, never SSH_ASKPASS.
  real_ssh=$tmp/mux lib=$tmp
  SSH_ASKPASS=/nonexistent ASKED=$tmp/asked SENT=$tmp/sent CC_ASKPASS_REMOTE=1
  CCAP_CTL=/c CCAP_HOST=u@h CCAP_TOKEN=0123456789abcdef
  export ASKED SENT CC_ASKPASS_REMOTE
  relay_requests h < "$tmp/lines"
)
printf '%s\n' 'Password: |h|sudo true|' 'Q|db01 via h|ls|' | cmp -s - "$tmp/asked" || fail "asked: $(cat "$tmp/asked")"
printf '%s\n' '12|pw' '15|pw' | cmp -s - "$tmp/sent" || fail "sent: $(cat "$tmp/sent")"
teardown

# The remote sudo wrapper adds -A unless the caller chose how sudo gets the password; the
# value of an option is not the command.
setup 'sudo wrapper options'
mkdir "$tmp/real"
(
  CCAP_RS_LIB=1
  . "$root/bin/remote.sh"
  sudo_wrapper
) > "$tmp/dir/sudo"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/sudo.args"\n' "$tmp" > "$tmp/real/sudo"
chmod +x "$tmp/dir/sudo" "$tmp/real/sudo"
for args in 'true' '-S true' '-u root -S true' '--user root -S true' '--user=root -n true' \
  '--user root true' '--prompt x --chdir / -A true' '-uroot true'; do
  # shellcheck disable=SC2086
  env PATH="$tmp/dir:$tmp/real:$PATH" "$tmp/dir/sudo" $args
done
printf '%s\n' '-A true' '-S true' '-u root -S true' '--user root -S true' '--user=root -n true' \
  '-A --user root true' '--prompt x --chdir / -A true' '-A -uroot true' | cmp -s - "$tmp/sudo.args" ||
  fail "sudo got: $(cat "$tmp/sudo.args")"
teardown

# macOS ships sudo and ssh executable but not readable by users: the wrappers' check of the
# second line must not print "Permission denied".
setup 'execute-only binaries print nothing'
mkdir "$tmp/xo"
# A binary: `command -v true` names the shell builtin.
for bin in /bin/true /usr/bin/true; do [ -x "$bin" ] && break; done
cp "$bin" "$tmp/xo/sudo"
cp "$bin" "$tmp/xo/ssh"
chmod 111 "$tmp/xo/sudo" "$tmp/xo/ssh"
(
  CCAP_RS_LIB=1
  . "$root/bin/remote.sh"
  sudo_wrapper
) > "$tmp/dir/sudo"
chmod +x "$tmp/dir/sudo"
env PATH="$tmp/dir:$tmp/xo:$PATH" "$tmp/dir/sudo" true 2> "$tmp/err" || fail 'sudo wrapper did not run the real sudo'
env PATH="$shimdir:$tmp/xo:$PATH" sh "$wrapper" h 2>> "$tmp/err" || fail 'ssh wrapper did not run the real ssh'
[ ! -s "$tmp/err" ] || fail "stderr: $(cat "$tmp/err")"
teardown

# ---- remote.sh without multiplexing: serve-stdin and run ----

await() {
  n=0
  until eval "$1"; do
    n=$((n + 1))
    [ "$n" -lt 30 ] || return 1
    sleep 0.1 2> /dev/null || sleep 1
  done
}

# serve_up: remote.sh serve-stdin with its stdin held open on fd 5; $sdir is its directory.
serve_up() {
  tok=0123456789abcdef
  mkdir "$tmp/base"
  mkfifo "$tmp/in"
  CCAP_TEST_BASES="$tmp/base" CCAP_RS_B64=$(base64 < "$root/bin/remote.sh" | tr -d '\n') \
    sh "$root/bin/remote.sh" serve-stdin "$tok" < "$tmp/in" > "$tmp/out" 2> "$tmp/err" &
  serve_pid=$!
  exec 5> "$tmp/in"
  sdir=$tmp/base/cc-askpass-$tok
  printf '%s %s\n' "$(printf '#!/bin/sh\n' | base64 | tr -d '\n')" "$(printf '#!/bin/sh\n' | base64 | tr -d '\n')" >&5
  await '[ -s "$tmp/out" ]'
}

# serve_down: close its stdin and wait for it to end.
serve_down() {
  exec 5>&-
  wait "$serve_pid"
}

# helper PID: a fake helper asks as PID and keeps what it is answered in $tmp/got.
helper() {
  mkfifo "$sdir/reply.$1"
  cat "$sdir/reply.$1" > "$tmp/got" &
  printf '%s\tP\t\t\n' "$1" > "$sdir/req"
}

setup 'serve-stdin sets up and announces the directory'
serve_up
[ "$(head -n 1 "$tmp/out")" = "cc-askpass-ready $sdir" ] || fail "out: $(cat "$tmp/out") err: $(cat "$tmp/err")"
[ "$(find "$sdir" -prune -perm 700)" = "$sdir" ] || fail 'not mode 700'
[ "$(ls "$sdir" | tr '\n' ' ')" = 'askpass owner.pid relay.pid remote.sh req ssh sudo ' ] || fail "files: $(ls "$sdir")"
cmp -s "$root/bin/remote.sh" "$sdir/remote.sh" || fail 'remote.sh differs'
serve_down
teardown

setup 'serve-stdin relays and answers'
serve_up
helper 123
await '[ "$(wc -l < "$tmp/out")" -eq 2 ]' || fail "out: $(cat "$tmp/out")"
[ "$(sed -n 2p "$tmp/out")" = "$(printf '123\tP\t\t')" ] || fail "out: $(cat "$tmp/out")"
printf '123\tpw\n' >&5
await '[ "$(cat "$tmp/got" 2> /dev/null)" = pw ]' || fail "got: $(cat "$tmp/got")"
serve_down
teardown

setup 'reply keeps tabs and edge spaces'
serve_up
helper 123
await '[ "$(wc -l < "$tmp/out")" -eq 2 ]'
printf '123\t  a\tb  \n' >&5
await '[ -s "$tmp/got" ]'
printf '  a\tb  \n' | cmp -s - "$tmp/got" || fail "got: $(cat "$tmp/got")"
serve_down
teardown

setup 'stdin EOF cleans up'
serve_up
[ -d "$sdir" ] || fail 'no directory'
exec 5>&-
await '[ ! -d "$sdir" ]' || fail 'directory still there'
wait "$serve_pid" || fail "status $?"
teardown

setup 'serve-stdin without a usable base fails'
echo x | CCAP_TEST_BASES="$tmp/nonexistent" sh "$root/bin/remote.sh" serve-stdin 0123456789abcdef > "$tmp/out" 2> /dev/null
status=$?
[ "$status" = 1 ] && [ "$(cat "$tmp/out")" = cc-askpass-failed ] || fail "status $status out: $(cat "$tmp/out")"
teardown

setup 'serve-stdin cleans up when its stdout is gone'
tok=0123456789abcdef
mkdir "$tmp/base"
mkfifo "$tmp/in" "$tmp/outp"
CCAP_TEST_BASES="$tmp/base" CCAP_RS_B64=$(base64 < "$root/bin/remote.sh" | tr -d '\n') \
  sh "$root/bin/remote.sh" serve-stdin "$tok" < "$tmp/in" > "$tmp/outp" 2> "$tmp/err" &
serve_pid=$!
exec 5> "$tmp/in"
sdir=$tmp/base/cc-askpass-$tok
printf 'YQ== YQ==\n' >&5
read -r line < "$tmp/outp"
# The reader has hung up: the next request line cannot be written.
printf '1\tP\t\t\n' > "$sdir/req"
exec 5>&-
await '[ ! -d "$sdir" ]' || fail 'directory still there'
wait "$serve_pid" || fail "status $?"
teardown

setup 'run uses the prepared directory'
serve_up
got=$(CCAP_DIR=$sdir CCAP_CMD_B64=$(printf 'echo "$SUDO_ASKPASS"' | base64) sh "$root/bin/remote.sh" run)
[ "$got" = "$sdir/askpass" ] || fail "got: $got"
serve_down
teardown

setup 'run without a valid directory runs plainly'
got=$(CCAP_DIR=/nonexistent CCAP_CMD_B64=$(printf 'echo "[$SUDO_ASKPASS]"' | base64) sh "$root/bin/remote.sh" run)
[ "$got" = '[]' ] || fail "got: $got"
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
# record the line with the args of the helper's parent and grandparent.
answer_requests() {
  IFS= read -r ready || return
  printf '%s\n' "${ready#*"$tab"}" > "$e2e/ldir.new"
  mv "$e2e/ldir.new" "$e2e/ldir"
  while IFS= read -r line; do
    pid=${line%%"$tab"*}
    ppid=$(ps -o ppid= -p "$pid" 2> /dev/null | tr -d ' ')
    gppid=$(ps -o ppid= -p "$ppid" 2> /dev/null | tr -d ' ')
    printf '%s\t%s\t%s\n' "$line" "$(ps -ww -o args= -p "$ppid" 2> /dev/null)" \
      "$(ps -ww -o args= -p "$gppid" 2> /dev/null)" >> "$e2e/seen"
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
# wdir, when set, is the session directory the wrapper gets.
wssh() {
  bounded 30 env PATH="$shimdir:$PATH" CC_ASKPASS_DIR="${wdir:-$ldir}" SSH_ASKPASS="$askpass" ssh "$@"
}

e2e_test() {
  current=$1
  start_listener
}

# masters: our masters and sessions still running, in the session directory or under /tmp.
masters() {
  pgrep -fa -- "-S ($ldir/s\.|/tmp/ccap\.)"
}

# gone COMMAND...: wait up to 5 s until COMMAND fails.
gone() {
  i=0
  while "$@" > /dev/null; do
    i=$((i + 1))
    [ "$i" -gt 50 ] && return 1
    sleep 0.1
  done
}

e2e_done() {
  stop_listener
  if ! gone pgrep -f "$wrapper --relay"; then
    fail "relay left running: $(pgrep -fa "$wrapper --relay")"
    pkill -f "$wrapper --relay"
  fi
  if ! gone masters; then
    fail "master left running: $(masters)"
    pkill -f -- "-S ($ldir/s\.|/tmp/ccap\.)"
  fi
}

# seen_field N: field N of the first request line the listener saw (5 is the parent's args,
# 6 the grandparent's).
seen_field() {
  head -n 1 "$e2e/seen" | cut -f "$1"
}

# remote_dirs: the token directories under the remote bases (the same machine here).
remote_dirs() {
  ls -d "$HOME/.cache"/cc-askpass-* /tmp/cc-askpass-* 2> /dev/null
}

# sample_argv FILE: until killed, add the args of any process that holds the answer to FILE.
sample_argv() {
  while :; do
    ps -eww -o args= 2> /dev/null | grep 'test-p[w]' >> "$1"
  done
}

run_e2e() {
  cfg=$e2e/a/cfg
  # ssh-add asks through the remote askpass like any program (who asks is shown, not judged);
  # the key's passphrase is the listener's answer.
  add="eval \"\$(ssh-agent -s)\" > /dev/null; trap \"ssh-agent -k > /dev/null\" EXIT; ssh-add $e2e/pw_key 2> /dev/null && ssh-add -l > /dev/null && echo added"

  e2e_test 'asks through the relay'
  sample_argv "$e2e/argv" &
  sampler=$!
  out=$(wssh -F "$cfg" localhost "$add")
  kill "$sampler"
  wait "$sampler" 2> /dev/null
  [ "$out" = added ] || fail "out: $out"
  [ "$(wc -l < "$e2e/seen")" -eq 1 ] || fail "seen: $(cat "$e2e/seen")"
  [ "$(seen_field 2)" = "Enter passphrase for $e2e/pw_key: " ] || fail "prompt: $(seen_field 2)"
  [ "$(seen_field 3)" = localhost ] || fail "via: $(seen_field 3)"
  [ "$(seen_field 4)" = "ssh-add $e2e/pw_key" ] || fail "reported: $(seen_field 4)"
  case $(seen_field 5) in
    "$wrapper --relay localhost" | *" $wrapper --relay localhost") ;;
    *) fail "parent: $(seen_field 5)" ;;
  esac
  case $(seen_field 6) in
    *" $wrapper -F $cfg localhost eval "*) ;;
    *) fail "grandparent: $(seen_field 6)" ;;
  esac
  [ ! -s "$e2e/argv" ] || fail "answer in argv: $(cat "$e2e/argv")"
  e2e_done

  e2e_test 'askpass called by the command itself is shown, not refused'
    out=$(wssh -F "$cfg" localhost '"$SUDO_ASKPASS" P; echo "status $?"')
case $out in test-pw*) ;; *) fail "out: $out" ;; esac
  [ -s "$e2e/seen" ] || fail 'listener saw nothing'
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

  e2e_test 'ignores a caller -S'
  ssh -F "$cfg" -M -S "$e2e/caller.ctl" -o ControlPersist=yes -N -f localhost
  # Our socket is in $ldir, or in /tmp/ccap.* where $ldir is long (macOS's TMPDIR).
  out=$(wssh -F "$cfg" -S "$e2e/caller.ctl" localhost "pgrep -f -- 'ControlMaster=yes -S ($ldir/s\\.|/tmp/ccap\\.)' > /dev/null && echo private")
  [ "$out" = private ] || fail "out: $out"
  ssh -S "$e2e/caller.ctl" -O check localhost 2> /dev/null || fail 'caller master closed'
  ssh -S "$e2e/caller.ctl" -O exit localhost 2> /dev/null
  e2e_done

  e2e_test 'caller -M becomes no master'
  out=$(wssh -F "$cfg" -M -S "$e2e/m.ctl" localhost 'echo m-ok')
  [ "$out" = m-ok ] || fail "out: $out"
  [ ! -s "$e2e/seen" ] || fail "listener saw: $(cat "$e2e/seen")"
  [ ! -e "$e2e/m.ctl" ] || fail 'master at the caller path'
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

  e2e_test 'interrupt reaches the command'
  out=$(wssh -F "$cfg" localhost 'trap "echo int" INT; kill -INT $$')
  [ "$out" = int ] || fail "out: $out"
  e2e_done

  e2e_test 'second hop'
  out=$(wssh -F "$cfg" localhost "ssh -F $cfg localhost '$add'")
  [ "$out" = added ] || fail "out: $out"
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

  e2e_test 'long session directory'
  # The socket goes under /tmp once it plus OpenSSH's temporary suffix passes 104 bytes.
  wdir=$e2e/$(printf 'd%.0s' $(seq 1 $((96 - ${#e2e} - 9))))
  ln -s "$ldir" "$wdir"
  out=$(wssh -F "$cfg" localhost 'echo long-ok')
  [ "$out" = long-ok ] || fail "out: $out (dir ${#wdir} bytes)"
  wdir=
  e2e_done

  e2e_test 'long command runs unwrapped'
  big=$(head -c 100000 /dev/zero | tr '\0' a)
  out=$(wssh -F "$cfg" localhost ": $big; echo big-ok; echo \"\${SUDO_ASKPASS:-unset}\"")
  [ "$out" = "$(printf 'big-ok\nunset')" ] || fail "out: $out"
  e2e_done

  e2e_test 'killed wrapper cleans up'
  before=$(remote_dirs)
  env PATH="$shimdir:$PATH" CC_ASKPASS_DIR="$ldir" SSH_ASKPASS="$askpass" ssh -F "$cfg" localhost 'sleep 31' &
  killed=$!
  i=0
  until pgrep -f "^sleep 31$" > /dev/null || [ "$i" -gt 100 ]; do
    i=$((i + 1))
    sleep 0.1
  done
  [ "$(remote_dirs)" != "$before" ] || fail 'no token directory while running'
  kill -TERM "$killed"
  i=0
  while [ "$i" -lt 50 ]; do
    i=$((i + 1))
    pgrep -f "$wrapper --relay" > /dev/null || masters > /dev/null ||
      pgrep -f "^sleep 31$" > /dev/null || [ "$(remote_dirs)" != "$before" ] || break
    sleep 0.1
  done
  pgrep -f "$wrapper --relay" > /dev/null && fail 'relay still running'
  masters > /dev/null && fail "master still running: $(masters)"
  [ "$(remote_dirs)" = "$before" ] || fail "token directory left: $(remote_dirs)"
  pgrep -f "^sleep 31$" > /dev/null && fail "remote command still running"
  wait "$killed" 2> /dev/null
  e2e_done

  e2e_test 'command ending after the connection is gone cleans up'
  before=$(remote_dirs)
  env PATH="$shimdir:$PATH" CC_ASKPASS_DIR="$ldir" SSH_ASKPASS="$askpass" ssh -F "$cfg" localhost 'sleep 32' &
  killed=$!
  i=0
  until pgrep -f "^sleep 32$" > /dev/null || [ "$i" -gt 100 ]; do
    i=$((i + 1))
    sleep 0.1
  done
  # No stop reaches the remote side: the wrapper and its master die at once.
  kill -KILL "$killed"
  pkill -KILL -f -- "-S ($ldir/s\.|/tmp/ccap\.)"
  wait "$killed" 2> /dev/null
  sleep 0.5
  pkill -f "^sleep 32$"
  gone eval '[ "$(remote_dirs)" != "$before" ]' || fail "token directory left: $(remote_dirs)"
  gone pgrep -f '_ relay [0-9a-f]+$' || fail "remote relay left: $(pgrep -fa '_ relay [0-9a-f]+$')"
  pkill -f "$wrapper --relay"
  e2e_done

  e2e_test 'master ends after the wrapper is killed outright'
  before=$(remote_dirs)
  # In a process group of its own, killed whole as Claude Code's KILL after a timeout does.
  perl -e 'setpgrp(0, 0); exec @ARGV or exit 127' env PATH="$shimdir:$PATH" CC_ASKPASS_DIR="$ldir" \
    SSH_ASKPASS="$askpass" ssh -F "$cfg" localhost 'sleep 33' &
  killed=$!
  i=0
  until pgrep -f "^sleep 33$" > /dev/null || [ "$i" -gt 100 ]; do
    i=$((i + 1))
    sleep 0.1
  done
  kill -KILL -"$killed"
  wait "$killed" 2> /dev/null
  # The remote command ends on its own later; its master must not outlive it by more than 10 s.
  pkill -f "^sleep 33$"
  i=0
  while masters > /dev/null && [ "$i" -lt 150 ]; do
    i=$((i + 1))
    sleep 0.1
  done
  masters > /dev/null && fail "master still running after 15 s: $(masters)"
  gone eval '[ "$(remote_dirs)" != "$before" ]' || fail "token directory left: $(remote_dirs)"
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
ssh-keygen -q -t ed25519 -N test-pw -f "$e2e/pw_key"
test_login_shells
if [ ! -x "$sshd" ]; then
  echo 'SKIP: no usable sshd'
  echo "::warning::ssh end-to-end tests skipped: no usable sshd"
elif start_sshd "$e2e/a" && start_sshd "$e2e/forced" 'ForceCommand /bin/echo forced'; then
  run_e2e
elif [ "$(uname)" = Linux ]; then
  current='start sshd'
  fail "$(cat "$e2e"/*/sshd.log 2> /dev/null)"
else
  echo 'SKIP: no usable sshd'
  cat "$e2e"/*/sshd.log 2> /dev/null
  echo "::warning::ssh end-to-end tests skipped: no usable sshd"
fi
stop_sshd "$e2e/a"
stop_sshd "$e2e/forced"
rm -rf "$e2e"

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo 'PASS: all ssh wrapper tests'
