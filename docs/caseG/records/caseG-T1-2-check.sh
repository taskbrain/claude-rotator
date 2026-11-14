#!/bin/bash
# 案G 試験T1-2 確認用（読むだけ）。Keychain は属性(acct・cdat・mdat)だけを見る。値は読まない。
# -g / -w / dump-keychain は使わない。claude もヘルパーも起動しない。タブに入力しない。
# 本番の項目「Claude Code-credentials」(番号なし)、試験3の cfg14/cfg15 の項目は引かない。
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
R=$HOME/caseG-T1-run1
echo "### T1-2 確認 $(date '+%Y-%m-%d %H:%M:%S JST')"
j(){ e=$(date -j -u -f "%Y%m%d%H%M%SZ" "$1" +%s 2>/dev/null) && TZ=Asia/Tokyo date -r "$e" "+%m/%d %H:%M:%S" || echo "$1"; }

echo "## Keychain 項目（-s だけ。値は読まない）"
for s in "Claude Code-credentials-<redacted>" "Claude Code-credentials-<redacted>" "caseG-T1-vault-alpha" "caseG-T1-vault-beta"; do
  out=$(security find-generic-password -s "$s" 2>&1)
  if echo "$out" | grep -q 'could not be found'; then echo "$s: 項目なし"; continue; fi
  acct=$(echo "$out" | sed -n 's/.*"acct"<blob>="\(.*\)"/\1/p')
  cdat=$(echo "$out" | sed -n 's/.*"cdat"<timedate>=.*"\([0-9]*Z\).*/\1/p')
  mdat=$(echo "$out" | sed -n 's/.*"mdat"<timedate>=.*"\([0-9]*Z\).*/\1/p')
  echo "$s: acct=$acct cdat=$(j $cdat) mdat=$(j $mdat) JST"
done
echo "（隔離項目 caseG-T1-vault-quarantine-* はヘルパーの出力と status で確かめる。一覧の取得はしない）"

echo "## 試験フォルダ（名前とサイズだけ。中身は読まない）"
for d in "$R" "$R/lane" "$R/src15" "$R/trial"; do
  [ -e "$d" ] && ls -la "$d" 2>&1 | grep -vE '^total' | sed "s|^|$(basename $d): |" || echo "$d: なし"
done

echo "## 触れてはいけないプロセス（期待：どれも残っている）"
for p in 73215 33261 13945; do
  ps -o pid=,etime=,stat= -p $p 2>/dev/null || echo "!! PID $p が無い（中止の条件）"
done

echo "## ポート（期待：37891 は本番Rotatorのまま。37991 は空き）"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E ':3789|:3799' || echo "(3789x/3799x に LISTEN なし)"

echo "## 試作（期待：8d7a4d5、変更なし）"
W=$HOME/develop/project/claude-rotator-wt/caseG-T1-helper
git -C "$W" log -1 --oneline; git -C "$W" status -s | head -5

echo "## バイナリ（期待：versions/2.1.317）"
readlink $HOME/.local/bin/claude
