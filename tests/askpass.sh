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

# with_timeout SECONDS COMMAND...: GNU timeout, which macOS lacks. Exits 124 when the
# command had to be killed.
with_timeout() {
  seconds=$1
  shift
  "$@" &
  command_pid=$!
  (sleep "$seconds" && kill "$command_pid" 2> /dev/null) &
  watchdog_pid=$!
  wait "$command_pid"
  status=$?
  # Reaped with stderr closed: bash (macOS sh) reports a killed job as "Terminated".
  kill "$watchdog_pid" 2> /dev/null || return 124
  wait "$watchdog_pid" 2> /dev/null
  return "$status"
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
  [ "$(head -n 1 "$out")" = "ready${tab}$XDG_RUNTIME_DIR/cc-askpass/s1-$$" ] || fail "ready line: $(head -n 1 "$out")"
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
    with_timeout 5 env -u XDG_RUNTIME_DIR "$askpass" --serve s1 > /dev/null 2> "$tmp/err"
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
  [ "$(head -n 1 "$out")" = "ready${tab}$XDG_RUNTIME_DIR/cc-askpass/s1-$$" ] || fail "ready line: $(head -n 1 "$out")"
  [ -p "$dir/req" ] || fail 'req is not a FIFO'
  teardown
}

test_serve_refuses_unsafe_session_ids() {
  setup 'serve refuses unsafe session ids'
  start_serve keep
  for id in '' '.' '..' 'a/b'; do
    "$askpass" --serve "$id" > /dev/null 2>&1
    status=$?
    [ "$status" -eq 1 ] || fail "id '$id': exit $status"
  done
  "$askpass" --serve > /dev/null 2>&1
  status=$?
  [ "$status" -eq 1 ] || fail "no id: exit $status"
  [ -p "$XDG_RUNTIME_DIR/cc-askpass/keep-$$/req" ] || fail 'another session dir was removed'
  teardown
}

test_serve_trims_trailing_slash() {
  setup 'serve trims a trailing slash in XDG_RUNTIME_DIR'
  XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR/"
  start_serve s1
  [ "$dir" = "${XDG_RUNTIME_DIR%/}/cc-askpass/s1-$$" ] || fail "dir: $dir"
  teardown
}

test_killed_helper_closes_its_stdout() {
  setup 'a killed helper closes its stdout at once'
  start_serve s1
  # ssh and git read askpass output until EOF: nothing may keep the pipe open.
  (CC_ASKPASS_DIR=$dir "$askpass" 'Password: ' | { cat > /dev/null; : > "$tmp/eof"; }) &
  if wait_lines "$out" 2; then
    kill -9 "$(sed -n 2p "$out" | cut -f 1)"
    i=0
    while [ ! -e "$tmp/eof" ] && [ "$i" -lt 30 ]; do
      i=$((i + 1))
      sleep 0.1
    done
    [ -e "$tmp/eof" ] || fail 'stdout stayed open after the helper died'
  else
    fail 'helper wrote no request'
  fi
  teardown
}

test_stale_reply_fifo_is_replaced() {
  setup 'a reply FIFO left by a killed helper with the same pid is replaced'
  start_serve s1
  # exec keeps the pid, so the helper starts with a reply.<its pid> already there.
  CC_ASKPASS_DIR=$dir sh -c 'mkfifo "$CC_ASKPASS_DIR/reply.$$"; exec "$0" "Password: "' "$askpass" > "$tmp/helper.out" &
  helper_pid=$!
  if wait_lines "$out" 2; then
    printf 'pw\n' > "$dir/reply.$helper_pid"
    wait "$helper_pid"
    status=$?
    [ "$status" -eq 0 ] || fail "helper exit $status"
  else
    fail 'helper wrote no request'
    kill "$helper_pid" 2> /dev/null
  fi
  teardown
}

test_dead_listener_fails_fast() {
  setup 'a helper fails at once when the listener is gone'
  start_serve s1
  stop_serve
  with_timeout 5 env CC_ASKPASS_DIR="$dir" "$askpass" 'Password: ' > /dev/null 2> "$tmp/err"
  status=$?
  [ "$status" -eq 1 ] || fail "exit $status"
  [ -s "$tmp/err" ] || fail 'no message on stderr'
  teardown
}

test_long_prompt_is_truncated() {
  setup 'a long prompt is cut to fit one atomic FIFO write'
  start_serve s1
  requests=0
  start_helper "$(printf '%05000d' 0)"
  [ "${#request}" -le 1100 ] || fail "request is ${#request} bytes"
  printf '\n' > "$dir/reply.$helper_pid"
  wait "$helper_pid"
  teardown
}

test_two_processes_resuming_one_session() {
  setup 'two processes resuming one session keep separate dirs'
  # `; :` stops sh from exec'ing serve, so each serve has its own parent.
  sh -c '"$0" --serve s1; :' "$askpass" > "$tmp/a.out" 2> /dev/null &
  a=$!
  sh -c '"$0" --serve s1; :' "$askpass" > "$tmp/b.out" 2> /dev/null &
  b=$!
  if wait_lines "$tmp/a.out" 1 && wait_lines "$tmp/b.out" 1; then
    dir_a=$(head -n 1 "$tmp/a.out" | cut -f 2)
    dir_b=$(head -n 1 "$tmp/b.out" | cut -f 2)
    [ "$dir_a" != "$dir_b" ] || fail "both use $dir_a"
    [ -p "$dir_a/req" ] && [ -p "$dir_b/req" ] || fail 'a req FIFO was removed'
  else
    fail 'no ready lines'
  fi
  pkill -P "$a"
  pkill -P "$b"
  teardown
}

test_restarted_serve_resends_pending_requests() {
  setup 'a restarted listener resends requests still waiting'
  start_serve s1
  requests=0
  start_helper 'Password: '
  stop_serve
  : > "$out"
  start_serve s1
  if wait_lines "$out" 2 && [ -p "$dir/reply.$helper_pid" ]; then
    [ "$(sed -n 2p "$out")" = "$helper_pid${tab}Password: " ] || fail "resent: $(sed -n 2p "$out")"
    printf 'pw\n' > "$dir/reply.$helper_pid"
    wait "$helper_pid"
    status=$?
    [ "$status" -eq 0 ] || fail "helper exit $status"
    printf 'pw\n' | cmp -s - "$tmp/helper.out" || fail "helper printed: $(cat "$tmp/helper.out")"
    [ ! -e "$dir/request.$helper_pid" ] || fail 'request file left behind'
  else
    fail 'pending request was not resent'
    kill "$helper_pid" 2> /dev/null
  fi
  teardown
}

test_restarted_serve_drops_dead_requests() {
  setup 'a restarted listener drops requests whose helper died'
  start_serve s1
  requests=0
  start_helper 'Password: '
  kill -9 "$helper_pid"
  stop_serve
  : > "$out"
  start_serve s1
  sleep 0.3
  [ "$(wc -l < "$out")" -eq 1 ] || fail "resent a dead request: $(sed -n 2p "$out")"
  [ ! -e "$dir/request.$helper_pid" ] || fail 'dead request file left behind'
  teardown
}

test_exe_of_names_a_live_process() {
  setup 'exe-of prints the owner and path of a live process'
  sleep 30 &
  sleeper=$!
  line=$("$root/bin/exe-of" "$sleeper") || fail 'exe-of failed for a live pid'
  case "$line" in
    "0 "*/sleep) ;;
    *) fail "exe-of printed: $line" ;;
  esac
  kill "$sleeper"
  wait "$sleeper" 2> /dev/null
  "$root/bin/exe-of" "$sleeper" > /dev/null 2>&1 && fail 'exe-of succeeded for a dead pid'
  teardown
}

test_request_carries_via_and_reported() {
  setup 'request carries via and reported'
  start_serve s1
  requests=0
  CC_ASKPASS_VIA=db01 CC_ASKPASS_REPORTED="sudo  apt${tab}update" CC_ASKPASS_DIR=$dir "$askpass" 'Password: ' > "$tmp/helper.out" 2> /dev/null &
  helper_pid=$!
  wait_lines "$out" 2 || fail 'helper wrote no request'
  request=$(sed -n 2p "$out")
  [ "$request" = "$helper_pid${tab}Password: ${tab}db01${tab}sudo  apt update" ] || fail "request line: $request"
  printf '\n' > "$dir/reply.$helper_pid"
  wait "$helper_pid"
  teardown
}

test_remote_mode_reports_parent() {
  setup 'remote mode reports the parent command'
  start_serve s1
  # `; :` stops sh from exec'ing askpass, so the parent stays and is its PPID.
  CC_ASKPASS_REMOTE=1 CC_ASKPASS_DIR=$dir sh -c '"$0" "Password: "; :' "$askpass" > /dev/null 2>&1 &
  parent_pid=$!
  if wait_lines "$out" 2; then
    request=$(sed -n 2p "$out")
    expected=$(ps -o args= -p "$parent_pid")
    [ "$(printf '%s\n' "$request" | cut -f 4)" = "$expected" ] || fail "request line: $request (parent: $expected)"
    printf '\n' > "$dir/reply.$(printf '%s\n' "$request" | cut -f 1)"
  else
    fail 'helper wrote no request'
  fi
  kill "$parent_pid" 2> /dev/null
  wait "$parent_pid" 2> /dev/null
  teardown
}

test_remote_mode_keeps_given_reported() {
  setup 'remote mode keeps a given reported value'
  start_serve s1
  CC_ASKPASS_REMOTE=1 CC_ASKPASS_REPORTED='sudo ls' CC_ASKPASS_DIR=$dir "$askpass" 'Password: ' > /dev/null 2>&1 &
  helper_pid=$!
  wait_lines "$out" 2 || fail 'helper wrote no request'
  request=$(sed -n 2p "$out")
  [ "$request" = "$helper_pid${tab}Password: ${tab}${tab}sudo ls" ] || fail "request line: $request"
  printf '\n' > "$dir/reply.$helper_pid"
  wait "$helper_pid"
  teardown
}

test_long_fields_fit_one_atomic_write() {
  setup 'long prompt, via and reported fit one atomic FIFO write'
  start_serve s1
  long=$(printf '%05000d' 0)
  CC_ASKPASS_VIA=$long CC_ASKPASS_REPORTED=$long CC_ASKPASS_DIR=$dir "$askpass" "$long" > /dev/null 2>&1 &
  helper_pid=$!
  wait_lines "$out" 2 || fail 'helper wrote no request'
  bytes=$(sed -n 2p "$out" | wc -c)
  [ "$bytes" -lt 4096 ] || fail "request is $bytes bytes"
  printf '\n' > "$dir/reply.$helper_pid"
  wait "$helper_pid"
  teardown
}

test_relay_pid_counts_as_listener() {
  setup 'a live relay.pid counts as the listener'
  start_serve s1
  stop_serve
  rm -f "$dir/serve.pid"
  sleep 30 &
  relay=$!
  printf '%s\n' "$relay" > "$dir/relay.pid"
  CC_ASKPASS_DIR=$dir "$askpass" 'Password: ' > /dev/null 2>&1 &
  helper_pid=$!
  i=0
  while [ ! -e "$dir/request.$helper_pid" ] && [ "$i" -lt 50 ]; do
    i=$((i + 1))
    sleep 0.1
  done
  [ -e "$dir/request.$helper_pid" ] || fail 'no request went out for a live relay'
  kill "$helper_pid" 2> /dev/null
  wait "$helper_pid" 2> /dev/null
  kill "$relay"
  wait "$relay" 2> /dev/null
  with_timeout 5 env CC_ASKPASS_DIR="$dir" "$askpass" 'Password: ' > /dev/null 2> "$tmp/err"
  status=$?
  [ "$status" -eq 1 ] || fail "dead relay: exit $status"
  grep -q 'listener is not running' "$tmp/err" || fail "dead relay message: $(cat "$tmp/err")"
  teardown
}

test_serve_prints_ready
test_serve_refuses_unsafe_session_ids
test_serve_trims_trailing_slash
test_round_trip_keeps_special_characters
test_empty_reply_exits_1
test_prompt_with_tab_and_backslash
test_missing_dir_exits_1
test_reply_guard_does_not_create_a_file
test_unsafe_tmp_base_is_refused
test_serve_twice_with_the_same_session_id
test_killed_helper_closes_its_stdout
test_stale_reply_fifo_is_replaced
test_dead_listener_fails_fast
test_long_prompt_is_truncated
test_two_processes_resuming_one_session
test_restarted_serve_resends_pending_requests
test_restarted_serve_drops_dead_requests
test_exe_of_names_a_live_process
test_request_carries_via_and_reported
test_remote_mode_reports_parent
test_remote_mode_keeps_given_reported
test_long_fields_fit_one_atomic_write
test_relay_pid_counts_as_listener

if [ "$failures" -eq 0 ]; then
  echo 'PASS: all askpass tests'
else
  echo "$failures failure(s)"
  exit 1
fi
