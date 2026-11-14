#!/bin/bash
# 案G 試験T3 確認用（読むだけ）。Keychain は属性(acct・cdat・mdat)だけを見る。値は読まない。
# -g / -w / dump-keychain は使わない。claude もプロキシも起動しない。タブに入力しない。37891 に接続しない。
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
T=$HOME/caseG-test3-run1
L=$HOME/caseG-T3-run1/log/requests.jsonl
echo "### T3 確認 $(date '+%Y-%m-%d %H:%M:%S JST')"
j(){ e=$(date -j -u -f "%Y%m%d%H%M%SZ" "$1" +%s 2>/dev/null) && TZ=Asia/Tokyo date -r "$e" "+%m/%d %H:%M:%S" || echo "$1"; }

echo "## Keychain 項目（-s だけ。値は読まない）"
for s in "Claude Code-credentials-<redacted>" "Claude Code-credentials-<redacted>"; do
  out=$(security find-generic-password -s "$s" 2>&1)
  if echo "$out" | grep -q 'could not be found'; then echo "$s: 項目なし"; continue; fi
  acct=$(echo "$out" | sed -n 's/.*"acct"<blob>="\(.*\)"/\1/p')
  mdat=$(echo "$out" | sed -n 's/.*"mdat"<timedate>=.*"\([0-9]*Z\).*/\1/p')
  kc=$(echo "$out" | sed -n 's/^keychain: "\(.*\)"/\1/p')
  echo "$s: acct=$acct mdat=$(j $mdat) JST keychain=$kc"
done
echo "## 検索対象の Keychain（パスだけ）"
security list-keychains

echo "## cfg14 を開いているプロセス（期待：試験タブ以外なし）"
lsof -nP +d "$T/cfg14" 2>/dev/null | awk 'NR>1{print $1, $2}' | sort -u || true

echo "## 触れてはいけないプロセス（期待：どれも残っている）"
for p in 73215 33261 13945; do
  ps -o pid=,etime=,stat= -p $p 2>/dev/null || echo "!! PID $p が無い（中止の条件）"
done

echo "## ポート（期待：37891 は本番Rotatorのまま。37991 は試験中だけ LISTEN）"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E ':3789|:3799' || echo "(3789x/3799x に LISTEN なし)"

echo "## プロキシの記録（値を含まない設計。最後の20行）"
[ -f "$L" ] && { stat -f '%Sp %z bytes' "$L"; tail -n 20 "$L"; } || echo "記録なし"

echo "## 試作（期待：fcb2883、変更なし）"
W=$HOME/develop/project/claude-rotator-wt/caseG-T3-proto
git -C "$W" log -1 --oneline; git -C "$W" status -s | head -5
