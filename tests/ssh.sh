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

expect_parse 'h|cmd|-t||' -tp22 h cmd
expect_parse 'h|a b||/c|' -o ControlPath=/c -p 2 h a b
expect_parse 'h|a||/c|' -oControlPath=/c h a
expect_parse 'h|a||/c|' -o 'ControlPath /c' h a
expect_parse 'h|a||/c|' -o controlpath=/c h a
expect_parse 'h|a||/first|' -S /first -o ControlPath=/second h a
expect_parse 'h|cmd|||' -- h cmd
expect_parse 'ssh://u@h:2|cmd|||' ssh://u@h:2 cmd
expect_parse 'h|x||/c|' -S /c h x
expect_parse 'h|cmd|-t -t -t||' -t -tt h cmd
expect_parse 'h||||1' -N h
test_opts_roundtrip

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo 'PASS: all ssh wrapper tests'
