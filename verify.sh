#!/bin/zsh
set -eu
task_root="${0:A:h}"
task_tests="${1:?请指定工作区内较短的测试目录，例如 /path/to/work/rt}"
task_tests="${task_tests:A}"
CODEX_UNLOCK_HELPER="$task_root/Codex Input Unlock.app/Contents/Helpers/CodexUnlockAgentRust" \
CODEX_UNLOCK_BOOTSTRAP="$task_root/Codex Input Unlock.app/Contents/Helpers/CodexUnlockAgent" \
CODEX_UNLOCK_TEST_ROOT="$task_tests" \
node --test --test-concurrency=1 "$task_root/tests/native.test.mjs" "$task_root/tests/extra.test.mjs" "$task_root/tests/release.test.mjs"
