#!/bin/bash
# 案G 試験T5 確認（読むだけ）。表示用 k と差し替え先 j の口座フォルダについて、Keychain の属性・
# 開いているプロセス・Claude Code の全プロセスの一覧（記録だけ）・フォルダの最終更新・各口座フォルダの
# .claude.json のメール欄・自動で起こす仕組み・本番の無事・ポート・試作プロキシの記録の件数を出す。
# 終了コード: 0＝取得がすべて成功、3＝未確認、4＝NG（j の口座が j 以外のフォルダでもログインしている）、2＝引数が正しくない。
# 値は出さない。何も書かない。crontab の行そのものは出さない（件数とフォルダの有無だけ）。
# 使い方: caseG-T5-check.sh <k のフォルダ> <j のフォルダ> [試作プロキシの記録 requests.jsonl] [acct]
set -u
. "$(cd "$(dirname "$0")" && pwd)/caseG-check-lib.sh"
[ $# -ge 2 ] && [ $# -le 4 ] || caseg_die "使い方: $0 <k のフォルダ> <j のフォルダ> [記録] [acct]"
K="$1"; J="$2"; L="${3:-}"; A="${4:-cirkit}"
caseg_abs_dir "$K"; caseg_abs_dir "$J"
[ -d "$K" ] || caseg_die "フォルダが無い: $K"
[ -d "$J" ] || caseg_die "フォルダが無い: $J"
[ "$K" != "$J" ] || caseg_die "k と j が同じフォルダ"
SK=$(caseg_service_for "$K"); SJ=$(caseg_service_for "$J")
echo "### T5 確認 $(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M:%S JST')"
echo "k=$K 項目名=$SK"
echo "j=$J 項目名=$SJ"
caseg_keychain_item "$SK" "$A"
caseg_keychain_item "$SJ" "$A"
JMDAT="$CASEG_KC_MDAT"
caseg_search_list
caseg_folder_openers "$K" "表示用 k のフォルダ（試験タブだけのはず）"
caseg_folder_openers "$J" "差し替え先 j のフォルダ（0件のはず）"
caseg_claude_inventory
caseg_folder_newest "$K" "表示用 k のフォルダ"
caseg_folder_newest "$J" "差し替え先 j のフォルダ（区間中に変わらないはず）"
JNEW="$CASEG_NEWEST"
caseg_account_emails "$J" "$K"
echo "## 自動で起こす仕組み（名前だけ）"
echo "- launchctl list の claude を含む名前:"
if lc=$(launchctl list 2>/dev/null); then
  printf '%s\n' "$lc" | awk 'tolower($3) ~ /claude/ {print "  " $3}'
else
  caseg_fail "launchctl list の取得に失敗"
fi
# crontab -l は「crontab が無い」ときも非ゼロを返す。その文言のときだけ0行と読み、ほかの失敗は未確認にする。
cterr=$(mktemp "${TMPDIR:-/tmp}/caseg-crontab.XXXXXX") || caseg_die "一時ファイルを作れない"
ct=$(crontab -l 2>"$cterr"); ctrc=$?
cte=$(cat "$cterr"); rm -f "$cterr"
if [ "$ctrc" -ne 0 ] && printf '%s' "$cte" | grep -q 'no crontab for'; then ct=""; ctrc=0; fi
if [ "$ctrc" -eq 0 ]; then
  echo "- crontab: claude を含む行=$(printf '%s\n' "$ct" | grep -ci claude)、k のフォルダを含む行=$(printf '%s\n' "$ct" | grep -cF -- "$K")、j のフォルダを含む行=$(printf '%s\n' "$ct" | grep -cF -- "$J")"
else
  caseg_fail "crontab -l の取得に失敗"
fi
caseg_protected
caseg_ports
caseg_config_sha
caseg_proxy_log "$L"
echo "## j の判定材料（0-9 と 7-2 で同じなら可。増えた PID は記録だけで判定には使わない）"
echo "- j の Keychain 項目 $SJ の mdat=${JMDAT:-（取れない）}"
echo "- j のフォルダの最終更新=${JNEW:-（取れない）}"
echo "- メール一覧の指紋=${CASEG_EMAIL_FP:-（取れない）}"
caseg_finish
