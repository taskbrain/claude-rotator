#!/bin/bash
# 案G 試験T1-1 確認用（読むだけ）。Keychain は属性(acct・mdat)だけを見る。値は読まない。
# -g / -w / dump-keychain は使わない。claude は起動しない。タブに入力しない。
# 本番の項目「Claude Code-credentials」(番号なし)、試験3の cfg14/cfg15 の項目は引かない。
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
R=$HOME/caseG-T1-run1
LANE_ITEM="Claude Code-credentials-<redacted>"   # = sha256("$HOME/caseG-T1-run1/lane") 先頭8桁
echo "### T1-1 確認 $(date '+%Y-%m-%d %H:%M:%S JST')"

echo "## レーンの Keychain 項目（acct と mdat だけ。-a なし・値は読まない）"
out=$(security find-generic-password -s "$LANE_ITEM" 2>&1)
if echo "$out" | grep -q 'could not be found'; then
  echo "88a534ad: 項目なし（ログイン前の期待値。ログイン後は acct=<user> が1件のはず）"
else
  kc=$(echo "$out" | sed -n 's/^keychain: "\(.*\)"/\1/p')
  acct=$(echo "$out" | sed -n 's/.*"acct"<blob>="\(.*\)"/\1/p')
  cdat=$(echo "$out" | sed -n 's/.*"cdat"<timedate>=.*"\([0-9]*Z\).*/\1/p')
  mdat=$(echo "$out" | sed -n 's/.*"mdat"<timedate>=.*"\([0-9]*Z\).*/\1/p')
  j(){ e=$(date -j -u -f "%Y%m%d%H%M%SZ" "$1" +%s 2>/dev/null) && TZ=Asia/Tokyo date -r "$e" "+%m/%d %H:%M:%S" || echo "$1"; }
  echo "88a534ad: acct=$acct cdat=$(j $cdat) mdat=$(j $mdat) JST keychain=$kc"
  echo "  （acct は <user> のはず。口座の見分けは /status の画面で行う。切替ごとに mdat が進むか確認）"
fi

echo "## 試験フォルダ（名前とサイズだけ。中身は読まない）"
ls -la "$R" "$R/lane" 2>&1 | grep -vE '^total'
if [ -f "$R/lane/.claude.json" ]; then
  echo "lane/.claude.json あり $(stat -f %z "$R/lane/.claude.json") bytes（中身は読まない）"
else
  echo "lane/.claude.json なし（ログイン前の期待値）"
fi

echo "## 触れてはいけないプロセス（期待：どれも残っている）"
ps -o pid=,etime=,stat=,comm= -p 73215 2>/dev/null | sed 's/^/本番Rotator /' || true
ps -o pid=,etime=,stat=,comm= -p 33261 2>/dev/null | sed 's/^/試験2タブ /' || true
ps -o pid=,etime=,stat=,comm= -p 13945 2>/dev/null | sed 's/^/試験3-15番タブ /' || true
for p in 73215 33261 13945; do ps -p $p >/dev/null || echo "!! PID $p が無い（中止の条件）"; done

echo "## 本番ポート（期待：37891 が本番Rotatorのまま LISTEN）"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E '3789|3799' || echo "(3789x/3799x に LISTEN なし)"

echo "## バイナリ（期待：versions/2.1.317。コピーや書き換えがないこと）"
readlink $HOME/.local/bin/claude
