#!/bin/bash
# 案G 試験T4 確認（読むだけ）。対象の口座フォルダ1つについて、Keychain の属性・開いているプロセス・
# 本番の無事・ポート・試作プロキシの記録の件数を出す。値は出さない。何も書かない。
# 使い方: caseG-T4-check.sh <対象の口座フォルダの絶対パス> [試作プロキシの記録 requests.jsonl] [acct]
set -u
. "$(cd "$(dirname "$0")" && pwd)/caseG-check-lib.sh"
[ $# -ge 1 ] && [ $# -le 3 ] || caseg_die "使い方: $0 <対象フォルダ> [記録] [acct]"
T="$1"; L="${2:-}"; A="${3:-cirkit}"
caseg_abs_dir "$T"
[ -d "$T" ] || caseg_die "フォルダが無い: $T"
S=$(caseg_service_for "$T")
echo "### T4 確認 $(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M:%S JST')"
echo "対象フォルダ=$T 項目名=$S"
caseg_keychain_item "$S" "$A"
caseg_search_list
caseg_folder_openers "$T" "対象フォルダ"
caseg_protected
caseg_ports
caseg_config_sha
caseg_proxy_log "$L"
caseg_finish
