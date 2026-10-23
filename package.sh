#!/bin/zsh
set -eu
task_root="${0:A:h}"
cd "$task_root"
task_app="$task_root/Codex Input Unlock.app"
task_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$task_app/Contents/Info.plist")
task_arch=$(/usr/bin/lipo -archs "$task_app/Contents/Helpers/CodexUnlockAgent")
/usr/bin/codesign --verify --deep --strict "$task_app"
git diff --quiet HEAD --
if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  print -u2 '请先提交所有源码和说明，再打包。'
  exit 1
fi
task_binary="Codex-Input-Unlock-$task_version-macos-$task_arch.zip"
task_source="codex-input-unlock-$task_version-source.zip"
/usr/bin/ditto -c -k --norsrc --keepParent "$task_app" "$task_root/$task_binary"
git archive --format=zip --prefix=codex-input-unlock/ --output="$task_source" HEAD
python3 - "$task_binary" "$task_source" <<'PY'
import hashlib, sys
from pathlib import Path
Path('SHA256SUMS.txt').write_text(''.join(hashlib.sha256(Path(name).read_bytes()).hexdigest()+'  '+name+'\n' for name in sys.argv[1:]))
PY
print "已生成：$task_binary、$task_source、SHA256SUMS.txt"
