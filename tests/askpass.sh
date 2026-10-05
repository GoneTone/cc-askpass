#!/bin/sh
# Shell tests for bin/askpass. Run on Linux/WSL: sh tests/askpass.sh
set -u

root=$(cd "$(dirname "$0")/.." && pwd)
askpass="$root/bin/askpass"
failures=0
tab=$(printf '\t')

fail() {
  echo "FAIL: $current: $*"
  failures=$((failures + 1))
}

# wait_lines FILE N: wait up to 5 s until FILE has at least N lines.
wait_lines() {
  i=0
  while [ "$( (wc -l < "$1") 2> /dev/null || echo 0)" -lt "$2" ]; do
    i=$((i + 1))
    [ "$i" -gt 50 ] && return 1
    sleep 0.1
  done
}

setup() {
  current=$1
  tmp=$(mktemp -d)
  XDG_RUNTIME_DIR="$tmp/run"
  export XDG_RUNTIME_DIR
  mkdir -m 700 "$XDG_RUNTIME_DIR"
  out="$tmp/serve.out"
  serve_pid=
}

start_serve() {
  "$askpass" --serve "$1" > "$out" 2> "$tmp/serve.err" &
  serve_pid=$!
  wait_lines "$out" 1 || fail "serve printed no ready line: $(cat "$tmp/serve.err")"
  dir=$(head -n 1 "$out" | cut -f 2)
}

stop_serve() {
  [ -n "$serve_pid" ] && kill "$serve_pid" 2> /dev/null && wait "$serve_pid" 2> /dev/null
  serve_pid=
}

teardown() {
  stop_serve
  rm -rf "$tmp"
}

# start_helper PROMPT: run the askpass mode in the background, wait for its request line.
start_helper() {
  CC_ASKPASS_DIR=$dir "$askpass" "$1" > "$tmp/helper.out" 2> "$tmp/helper.err" &
  helper_pid=$!
  wait_lines "$out" "$((requests + 2))" || fail "helper wrote no request"
  requests=$((requests + 1))
  request=$(sed -n "$((requests + 1))p" "$out")
}

test_serve_prints_ready() {
  setup 'serve prints ready'
  start_serve s1
  [ "$(head -n 1 "$out")" = "ready${tab}$XDG_RUNTIME_DIR/cc-askpass/s1" ] || fail "ready line: $(head -n 1 "$out")"
  [ "$(ls -ld "$dir" | cut -c 1-10)" = 'drwx------' ] || fail "dir mode: $(ls -ld "$dir")"
  [ -p "$dir/req" ] || fail 'req is not a FIFO'
  teardown
}

test_round_trip_keeps_special_characters() {
  setup 'round trip keeps special characters'
  start_serve s1
  requests=0
  start_helper 'Password: '
  [ "$request" = "$helper_pid${tab}Password: " ] || fail "request line: $request"
  pw='  p@ss \w$rd "é" '
  printf '%s\n' "$pw" > "$dir/reply.$helper_pid"
  wait "$helper_pid"
  status=$?
  [ "$status" -eq 0 ] || fail "helper exit $status"
  printf '%s\n' "$pw" | cmp -s - "$tmp/helper.out" || fail "helper printed: $(cat "$tmp/helper.out")"
  teardown
}

test_empty_reply_exits_1() {
  setup 'empty reply exits 1'
  start_serve s1
  requests=0
  start_helper 'Password: '
  printf '\n' > "$dir/reply.$helper_pid"
  wait "$helper_pid"
  status=$?
  [ "$status" -eq 1 ] || fail "helper exit $status"
  [ ! -e "$dir/reply.$helper_pid" ] || fail 'reply FIFO left behind'
  teardown
}

test_prompt_with_tab_and_backslash() {
  setup 'prompt with tab and backslash'
  start_serve s1
  requests=0
  # $(...) strips a trailing newline, so the newline is embedded mid-prompt.
  start_helper "$(printf 'a\tb\\c\nd')"
  [ "$request" = "$helper_pid${tab}a b\\c d" ] || fail "request line: $request"
  printf '\n' > "$dir/reply.$helper_pid"
  wait "$helper_pid"
  teardown
}

test_missing_dir_exits_1() {
  setup 'missing CC_ASKPASS_DIR exits 1'
  env -u CC_ASKPASS_DIR "$askpass" 'Password: ' > /dev/null 2> "$tmp/err"
  status=$?
  [ "$status" -eq 1 ] || fail "exit $status"
  [ -s "$tmp/err" ] || fail 'no message on stderr'
  teardown
}

test_reply_guard_does_not_create_a_file() {
  setup 'reply guard does not create a file'
  start_serve s1
  printf 'pw\n' | sh -c '[ -p "$1" ] || exit 1; exec 3<>"$1"; cat >&3' _ "$dir/reply.999"
  status=$?
  [ "$status" -eq 1 ] || fail "exit $status"
  [ ! -e "$dir/reply.999" ] || fail 'a file was created'
  teardown
}

test_unsafe_tmp_base_is_refused() {
  setup 'unsafe tmp base is refused'
  base="/tmp/cc-askpass-$(id -u)"
  if [ -e "$base" ] || [ -L "$base" ]; then
    echo "SKIP: $current: $base already exists"
  else
    mkdir "$tmp/target"
    ln -s "$tmp/target" "$base"
    env -u XDG_RUNTIME_DIR timeout 5 "$askpass" --serve s1 > /dev/null 2> "$tmp/err"
    status=$?
    rm -f "$base"
    [ "$status" -ne 0 ] && [ "$status" -ne 124 ] || fail "serve exit $status"
    [ -s "$tmp/err" ] || fail 'no message on stderr'
  fi
  teardown
}

test_serve_twice_with_the_same_session_id() {
  setup 'serve twice with the same session id'
  start_serve s1
  stop_serve
  : > "$out"
  start_serve s1
  [ "$(head -n 1 "$out")" = "ready${tab}$XDG_RUNTIME_DIR/cc-askpass/s1" ] || fail "ready line: $(head -n 1 "$out")"
  [ -p "$dir/req" ] || fail 'req is not a FIFO'
  teardown
}

test_serve_prints_ready
test_round_trip_keeps_special_characters
test_empty_reply_exits_1
test_prompt_with_tab_and_backslash
test_missing_dir_exits_1
test_reply_guard_does_not_create_a_file
test_unsafe_tmp_base_is_refused
test_serve_twice_with_the_same_session_id

if [ "$failures" -eq 0 ]; then
  echo 'PASS: all askpass tests'
else
  echo "$failures failure(s)"
  exit 1
fi
