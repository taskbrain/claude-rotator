#!/bin/bash
# 案G 試験3 確認用（読むだけ）。Keychain は属性だけを見る。-g / -w / dump-keychain は使わない。
# 本番の項目「Claude Code-credentials」（後ろに番号なし）は引かない。claude は起動しない。
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
R=$HOME/caseG-test3-run1
echo "### 確認 $(date '+%Y-%m-%d %H:%M:%S JST')"
echo "## Keychain 属性（-a なしで引く。期待：7b5bcb04=#14、e694e038=#15 は acct=<user> が1件。92ec3e37=試験2、60d31dfa・f18120e7=試験1 は前回と同じ）"
for n in 7b5bcb04 e694e038 92ec3e37 60d31dfa f18120e7; do
  out=$(security find-generic-password -s "Claude Code-credentials-$n" 2>&1)
  if echo "$out" | grep -q 'could not be found'; then echo "$n: 項目なし"; continue; fi
  kc=$(echo "$out" | sed -n 's/^keychain: "\(.*\)"/\1/p')
  acct=$(echo "$out" | sed -n 's/.*"acct"<blob>="\(.*\)"/\1/p')
  cdat=$(echo "$out" | sed -n 's/.*"cdat"<timedate>=.*"\([0-9]*Z\).*/\1/p')
  mdat=$(echo "$out" | sed -n 's/.*"mdat"<timedate>=.*"\([0-9]*Z\).*/\1/p')
  j(){ e=$(date -j -u -f "%Y%m%d%H%M%SZ" "$1" +%s 2>/dev/null) && TZ=Asia/Tokyo date -r "$e" "+%m/%d %H:%M:%S" || echo "$1"; }
  echo "$n: acct=$acct cdat=$(j $cdat) mdat=$(j $mdat) JST keychain=$kc"
done
echo "## 試験フォルダ（名前とサイズだけ。中身は読まない）"
ls -la "$R" "$R/cfg14" "$R/cfg15" 2>&1 | grep -vE '^total'
for c in cfg14 cfg15; do [ -f "$R/$c/.claude.json" ] && echo "$c/.claude.json あり $(stat -f %z "$R/$c/.claude.json") bytes" || echo "$c/.claude.json なし"; done
echo "## 本番と試験2のプロセス（期待：どれも残っている）"
ps -o pid=,etime=,stat=,comm= -p 73215 2>/dev/null | sed 's/^/本番Rotator /' || true
ps -o pid=,etime=,stat=,comm= -p 33261 2>/dev/null | sed 's/^/試験2タブ /' || true
for p in 73215 33261; do ps -p $p >/dev/null || echo "!! PID $p が無い（中止の条件）"; done
echo "## 試験3のプロセス（試験フォルダを使っているもの）"
for p in $(pgrep -f 'versions/2.1.316'); do lsof -p $p 2>/dev/null | grep -q caseG-test3-run1 && ps -o pid=,etime=,stat=,command= -p $p | cut -c1-120; done
echo "## バイナリ（期待：2.1.316 のまま）"
readlink $HOME/.local/bin/claude; ls -la $HOME/.local/share/claude/versions/2.1.316 | awk '{print $5, $6, $7, $8}'
echo "## 参考：~/.claude.json（本番がふだんから書き換えるので判定には使わない）"
stat -f "%Sm %z bytes" -t "%m/%d %H:%M:%S" $HOME/.claude.json
