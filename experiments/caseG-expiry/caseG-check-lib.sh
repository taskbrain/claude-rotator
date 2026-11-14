#!/bin/bash
# caseG T4/T5 確認スクリプトの共通部分（読むだけ）。
# Keychain は属性（svce・acct・mdat・keychain）だけを見る。-g / -w / dump-keychain は使わない。
# claude もプロキシも起動しない。タブに入力しない。37891 に接続しない。プロセスを止めない。
# ファイルを書かない（標準出力に出すだけ。lsof・crontab・find の標準エラーを受ける一時ファイルは、読んだらすぐ消す）。
# 値（トークン・認証 JSON）は出さない。取得に失敗したものは「0件」と読まず、未確認として終了コード 3 で終わる。
#
# 試験用の差し込み口（実行のときは設定しない）:
#   CASEG_CHECK_BIN       PATH の先頭に足すフォルダ（テストの偽の security・lsof などを置く）
#   CASEG_ROTATOR_CONFIG  sha256 を取る本番の config.json（既定 $HOME/.config/claude-rotator/config.json。中身は出さない）
#   CASEG_PROTECT_PIDS    残っていることを確かめる PID（既定 "73215"）
#   CASEG_EMAIL_ROOTS     .claude.json を探す起点（空白区切り。既定 "$HOME /private/tmp $TMPDIR"）
export PATH="${CASEG_CHECK_BIN:+$CASEG_CHECK_BIN:}/usr/bin:/bin:/usr/sbin:/sbin"
export LC_ALL=C

caseg_die() { echo "!! $*（何も確かめずに終わる）" >&2; exit 2; }

# 取得に失敗した・形が合わない・期待と違うときに呼ぶ。続けて残りを出し、最後の caseg_finish で非ゼロにする。
CASEG_FAILED=0
caseg_fail() { echo "!! 未確認: $*"; CASEG_FAILED=1; }
# 判定として不合格（試験の前提が崩れている）。未確認より優先し、終了コード 4 で終わる。
CASEG_NG=0
caseg_ng() { echo "!! NG: $*"; CASEG_NG=1; }
caseg_finish() {
  if [ "$CASEG_NG" -ne 0 ]; then echo "## 結果: NG（上の「!! NG」を見る。終了コード 4）"; exit 4; fi
  if [ "$CASEG_FAILED" -ne 0 ]; then echo "## 結果: 未確認（上の「!! 未確認」を見る。終了コード 3）"; exit 3; fi
  echo "## 結果: 取得はすべて成功"
  exit 0
}

# lsof は「該当なし」でも終了コード 1 を返し、権限などで見られない経路があると標準エラーに警告を出す。
# 警告は消さない（-w は使わない）。標準エラーに何か出たら、探索が不完全として扱う。
# 標準出力は CASEG_LSOF_OUT に入れる（不完全でも、見つかった分は出せるように）。
# 戻り値: 0=完全（該当あり、または終了コード 1 で標準エラーが空＝該当なし）、1=失敗、2=不完全（見つかった分はある）。
caseg_lsof() {
  local err rc errf
  CASEG_LSOF_OUT=""
  errf=$(mktemp "${TMPDIR:-/tmp}/caseg-lsof.XXXXXX") || return 1
  CASEG_LSOF_OUT=$(lsof "$@" 2>"$errf"); rc=$?
  err=$(cat "$errf"); rm -f "$errf"
  if [ -n "$err" ]; then
    [ "$rc" -eq 0 ] && return 2
    return 1
  fi
  [ "$rc" -eq 0 ] || [ "$rc" -eq 1 ] && return 0
  return 1
}

# pgrep は 0=該当あり、1=該当なし、それ以外=失敗。
caseg_pgrep() {
  local out rc
  out=$(pgrep "$@" 2>/dev/null); rc=$?
  if [ "$rc" -le 1 ]; then printf '%s' "$out"; return 0; fi
  return 1
}

# Claude Code に当たるプロセスの PID を CASEG_CLAUDE_PIDS に入れる（空白区切り。0件もありうる）。
# 名前が claude のもの（~/.local/bin/claude などで起動）に加え、~/.local/share/claude/versions/<版> を
# フルパスで起動したものも拾う（その場合プロセス名は版番号になり、pgrep -x claude には出ない）。
# ps -axo の comm は macOS では起動したパス。環境変数は読まない。戻り値: 0=取得できた、1=失敗。
caseg_claude_pids() {
  local out
  CASEG_CLAUDE_PIDS=""
  out=$(ps -axo pid=,comm= 2>/dev/null) || return 1
  [ -n "$out" ] || return 1
  CASEG_CLAUDE_PIDS=$(printf '%s\n' "$out" | awk '{
      pid = $1; c = $0; sub(/^ *[0-9]+ +/, "", c); n = c; sub(/.*\//, "", n)
      if (pid ~ /^[0-9]+$/ && (n == "claude" || c ~ /\/claude\/versions\/[^\/]+$/)) print pid
    }' | sort -n | tr '\n' ' ')
  return 0
}

caseg_lstart_jst() {
  local s e
  s=$(ps -o lstart= -p "$1" 2>/dev/null) || return 1
  [ -n "$s" ] || return 1
  e=$(date -j -f "%a %b %d %T %Y" "$s" +%s 2>/dev/null) && TZ=Asia/Tokyo date -r "$e" "+%m/%d %H:%M:%S JST" \
    || printf '%s' "$s"
}

# Claude Code の全プロセスの一覧（PID・開始時刻・作業フォルダ・起動したパス）。試験の前後で比べるためのもの。
# 口座フォルダを環境変数（CLAUDE_CONFIG_DIR）で渡したセッションは、この一覧でもどの口座かは分からない。
# 増えた PID は記録するだけで、判定には使わない（判定は j の Keychain 項目の mdat と j のフォルダの最終更新。
# 2026-11-14 坂根さんの決定 t117s996）。
caseg_claude_inventory() {
  local pid start cwd comm rc n=0 mark
  [ -n "$CASEG_ANCESTORS" ] || CASEG_ANCESTORS=$(caseg_ancestors)
  echo "## Claude Code の全プロセス（PID・開始時刻・作業フォルダ・起動したパス。環境変数は読まない。記録だけで判定には使わない）"
  if ! caseg_claude_pids; then caseg_fail "Claude Code のプロセス一覧（ps -axo）の取得に失敗"; return; fi
  for pid in $CASEG_CLAUDE_PIDS; do
    mark=""
    case " $CASEG_ANCESTORS " in *" $pid "*) mark=" （この確認を起こした祖先）" ;; esac
    if ! start=$(caseg_lstart_jst "$pid"); then echo "  $pid 照会の間に終了（ps -p で見えない）"; continue; fi
    comm=$(ps -o comm= -p "$pid" 2>/dev/null)
    caseg_lsof -a -p "$pid" -d cwd -Fn; rc=$?
    cwd=$(printf '%s\n' "$CASEG_LSOF_OUT" | sed -n 's/^n//p' | head -n 1)
    if [ "$rc" -ne 0 ] || [ -z "$cwd" ]; then
      if ps -p "$pid" >/dev/null 2>&1; then
        caseg_fail "PID $pid の作業フォルダの取得に失敗または不完全"; cwd="（取得できない）"
      else
        echo "  $pid 照会の間に終了"; continue
      fi
    fi
    echo "  $pid 開始=$start cwd=$cwd 起動=$comm$mark"
    n=$((n + 1))
  done
  echo "件数=$n"
}

# 口座フォルダの下（フォルダ自身を含む）で最後に更新されたもの。時刻と相対パスとファイル数だけ。中身は読まない。
# find・stat が失敗した、または標準エラーに何か出た（見られない経路がある）ときは未確認。
CASEG_NEWEST=""
caseg_folder_newest() {
  local dir="$1" label="$2" out err errf rc files newest rel
  CASEG_NEWEST=""
  echo "## $label の下で最後に更新されたもの（時刻と相対パスだけ。中身は読まない）"
  errf=$(mktemp "${TMPDIR:-/tmp}/caseg-find.XXXXXX") || { caseg_fail "一時ファイルを作れない"; return; }
  out=$(find "$dir" -exec stat -f '%m %N' {} + 2>"$errf"); rc=$?
  err=$(cat "$errf"); rm -f "$errf"
  if [ "$rc" -ne 0 ] || [ -n "$err" ]; then caseg_fail "find $dir の取得に失敗または不完全"; return; fi
  files=$(printf '%s\n' "$out" | grep -c .)
  newest=$(printf '%s\n' "$out" | grep . | sort -n | tail -n 1)
  rel=${newest#* }; rel=${rel#"$dir"}; rel=${rel#/}; [ -n "$rel" ] || rel="（フォルダ自身）"
  CASEG_NEWEST="$(TZ=Asia/Tokyo date -r "${newest%% *}" '+%m/%d %H:%M:%S') JST $rel"
  echo "項目=$files（フォルダ自身を含む） 最終更新=$CASEG_NEWEST"
}

caseg_abs_dir() {
  case "$1" in
    /*) ;;
    *) caseg_die "絶対パスではない: $1" ;;
  esac
  case "$1" in
    "$HOME"|"$HOME/"|"$HOME/.claude"|"$HOME/.claude/"*|"$HOME/.config/claude-rotator"*) caseg_die "対象にできないフォルダ: $1" ;;
  esac
}

# 口座フォルダの Keychain 項目名（Claude Code と同じく、フォルダのパスの sha256 の先頭8桁）。
caseg_service_for() {
  printf '%s' "$1" | shasum -a 256 | cut -c1-8 | sed 's/^/Claude Code-credentials-/'
}

caseg_jst() {
  local e
  e=$(date -j -u -f "%Y%m%d%H%M%SZ" "$1" +%s 2>/dev/null) && TZ=Asia/Tokyo date -r "$e" "+%m/%d %H:%M:%S" || echo "$1"
}

# 検索対象の Keychain ごとに、-a と -s で限定した項目の有無と属性を出す。期待は1件だけ。
# 終了コード 44 だけを「なし」と数える。それ以外の失敗は「読めない」として件数を出さず、未確認にする。
CASEG_KC_MDAT=""
caseg_keychain_item() {
  local service="$1" acct="${2:-cirkit}" count=0 unreadable=0 kc out rc mdat a list last=""
  CASEG_KC_MDAT=""
  echo "## Keychain 項目 $service（acct=$acct。属性だけ）"
  if ! list=$(security list-keychains 2>/dev/null) || [ -z "$list" ]; then
    caseg_fail "検索対象の Keychain の一覧を取れない"
    return
  fi
  while IFS= read -r kc; do
    kc=$(printf '%s' "$kc" | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//')
    [ -n "$kc" ] || continue
    out=$(security find-generic-password -a "$acct" -s "$service" "$kc" 2>&1); rc=$?
    if [ "$rc" -eq 44 ]; then echo "$kc: なし"; continue; fi
    if [ "$rc" -ne 0 ]; then echo "$kc: 読めない（終了コード $rc）"; unreadable=$((unreadable + 1)); continue; fi
    a=$(printf '%s\n' "$out" | sed -n 's/.*"acct"<blob>="\(.*\)"/\1/p')
    mdat=$(printf '%s\n' "$out" | sed -n 's/.*"mdat"<timedate>=.*"\([0-9]*Z\).*/\1/p')
    if [ -z "$a" ] || [ -z "$mdat" ]; then echo "$kc: 属性の形が合わない"; unreadable=$((unreadable + 1)); continue; fi
    last="$(caseg_jst "$mdat") JST"
    echo "$kc: あり acct=$a mdat=$last"
    count=$((count + 1))
  done <<< "$list"
  if [ "$unreadable" -ne 0 ]; then
    caseg_fail "読めない Keychain が $unreadable 件ある。件数は数えない"
  elif [ "$count" -eq 1 ]; then
    CASEG_KC_MDAT="$last"
    echo "件数=1（期待どおり）"
  else
    caseg_fail "件数=$count（1件でない）"
  fi
}

caseg_search_list() {
  echo "## 検索対象の Keychain（パスだけ）"
  security list-keychains 2>/dev/null || caseg_fail "検索対象の Keychain の一覧を取れない"
}

# この確認スクリプトの祖先の PID（親シェル・端末など）。1回だけ数える。
caseg_ancestors() {
  local p="$PPID" i=0 out=""
  while [ -n "$p" ] && [ "$p" != 0 ] && [ "$p" != 1 ] && [ "$i" -lt 32 ]; do
    out="$out $p"
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    i=$((i + 1))
  done
  printf '%s ' "$out"
}
CASEG_ANCESTORS=""

# PID がこの確認スクリプト自身・その子孫・その祖先なら真（どれもフォルダを開いた側には数えない）。
caseg_is_self() {
  case " $CASEG_ANCESTORS " in *" $1 "*) return 0 ;; esac
  local p="$1" i=0
  while [ -n "$p" ] && [ "$p" != 0 ] && [ "$p" != 1 ] && [ "$i" -lt 16 ]; do
    [ "$p" = "$$" ] && return 0
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    i=$((i + 1))
  done
  return 1
}

# フォルダを開いているプロセス（PID とコマンド名だけ）。環境変数は読まない（ps -E は使わない）。
# 取得に失敗したものは「0件」と読まず、未確認にする。
caseg_folder_openers() {
  local dir="$1" label="$2" pid out pids cwd name rc line
  [ -n "$CASEG_ANCESTORS" ] || CASEG_ANCESTORS=$(caseg_ancestors)
  echo "## $label を開いているプロセス（$dir）"
  echo "（数えないもの: この確認スクリプト自身 PID $$ とその子孫、祖先 PID${CASEG_ANCESTORS% }）"
  echo "- lsof +D:"
  caseg_lsof -nP +D "$dir"; rc=$?
  if [ "$rc" -eq 1 ]; then
    caseg_fail "lsof +D $dir の取得に失敗"
  else
    printf '%s\n' "$CASEG_LSOF_OUT" | awk 'NR>1 && NF{print $2, $1}' | sort -u | while read -r pid name; do
      caseg_is_self "$pid" || echo "  $name $pid"
    done
    [ "$rc" -eq 2 ] && caseg_fail "lsof +D $dir の探索が不完全（見られない経路がある。上の一覧は見つかった分だけ）"
  fi
  echo "- 命令の引数にフォルダを含むプロセス（PID とコマンド名）:"
  if pids=$(caseg_pgrep -f -- "$dir"); then
    for pid in $pids; do
      # すでに終わったもの（この確認スクリプトの副シェルなど）は数えない。
      name=$(ps -o comm= -p "$pid" 2>/dev/null) || continue
      caseg_is_self "$pid" && continue
      echo "  $pid $name"
    done
  else
    caseg_fail "pgrep -f の取得に失敗"
  fi
  echo "- claude の各プロセスの作業フォルダ（このフォルダの下だけを出す。名前が claude のものと …/claude/versions/<版> で起動したもの）:"
  if caseg_claude_pids; then
    for pid in $CASEG_CLAUDE_PIDS; do
      caseg_lsof -a -p "$pid" -d cwd -Fn; rc=$?
      if [ "$rc" -eq 0 ]; then
        printf '%s\n' "$CASEG_LSOF_OUT" | sed -n 's/^n//p' | while read -r cwd; do
          case "$cwd" in "$dir"|"$dir"/*) echo "  $pid cwd=$cwd" ;; esac
        done
      else
        caseg_fail "PID $pid の作業フォルダの取得に失敗または不完全"
      fi
    done
  else
    caseg_fail "Claude Code のプロセス一覧（ps -axo）の取得に失敗"
  fi
  echo "（何も出なければ0件）"
}

# 各口座フォルダの .claude.json から、口座のメール欄（oauthAccount.emailAddress）だけを読む
# （2026-11-14 坂根さんの決定 t117s996）。ファイル全体は出さない。ほかのキー・値（トークンなど）は読まない・出さない。
# 調べるフォルダ: j・k のフォルダと、CASEG_EMAIL_ROOTS の各起点の下 4 階層までで見つかる .claude.json の置き場
# （既定の ~/.claude.json、試験フォルダ、本番 Rotator の更新用の一時フォルダ $TMPDIR/…/claude-config を含む。
# Library・.Trash・node_modules・キャッシュ・.git の下は見ない。自分以外の持ち主で開けないフォルダは名前だけ出す）。
# 本番の config.json には口座フォルダの欄が無い（本番の更新は $TMPDIR の一時フォルダで行う）。
# 出力: フォルダ・メール・.claude.json の更新時刻。j のメールが j 以外のフォルダにあれば NG（終了コード 4）。
# 「指紋」はフォルダとメールの組（時刻を除く）の sha256 の先頭 16 桁。0-9 と 7-2 で同じなら一覧は変わっていない。
caseg_account_emails() {
  local jdir="$1" kdir="$2" roots r errf err rc found d f jreal kreal email mt mark lines="" jemail="" n=0 jcount=0 accounts fp
  local me out bad line p owner skipped=""
  echo "## 各口座フォルダの .claude.json のメール欄（oauthAccount.emailAddress だけ。ほかのキー・値は読まない）"
  roots=${CASEG_EMAIL_ROOTS-"$HOME /private/tmp ${TMPDIR:-}"}
  jreal=$(cd "$jdir" 2>/dev/null && pwd -P) || jreal="$jdir"
  kreal=$(cd "$kdir" 2>/dev/null && pwd -P) || kreal="$kdir"
  # 探索の標準エラーは起点ごとに分けて見る。「Permission denied」で、そのフォルダが自分以外の持ち主のもの
  # （/private/tmp の他ユーザーのフォルダなど。自分のプロセスの口座フォルダにはなりにくい）なら、見ていないものとして
  # 名前だけ出す。それ以外の標準エラー、または標準エラーが無いのに find が失敗したときは、探索が不完全として未確認。
  me=$(id -un)
  found=""
  for r in $roots; do
    [ -d "$r" ] || continue
    errf=$(mktemp "${TMPDIR:-/tmp}/caseg-email.XXXXXX") || { caseg_fail "一時ファイルを作れない"; return; }
    out=$(find "$r" -maxdepth 4 \( -name Library -o -name .Trash -o -name node_modules -o -name .cache -o -name Caches \
      -o -name .npm -o -name .git \) -prune -o -name .claude.json -type f -print 2>"$errf"); rc=$?
    err=$(cat "$errf"); rm -f "$errf"
    found="$found$out
"
    bad=""
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      case "$line" in
        "find: "*": Permission denied")
          p=${line#find: }; p=${p%: Permission denied}
          if [ -d "$p" ] && owner=$(stat -f %Su "$p" 2>/dev/null) && [ "$owner" != "$me" ]; then
            skipped="$skipped $p（持ち主 $owner）"; continue
          fi ;;
      esac
      bad="$bad $line"
    done <<< "$err"
    if [ -n "$bad" ]; then
      caseg_fail ".claude.json の探索が不完全（$r。下の一覧は見つかった分だけ）:$(printf '%s' "$bad" | cut -c1-300)"
    elif [ "$rc" -ne 0 ] && [ -z "$err" ]; then
      caseg_fail ".claude.json の探索に失敗（$r、終了コード $rc）"
    fi
  done
  [ -z "$skipped" ] || echo "（見ていない: 自分以外の持ち主で開けないフォルダ:$skipped）"
  # 置き場を実パスでそろえて重複を除く。j・k は .claude.json が無くても行を出す。
  found=$( { printf '%s\n' "$jreal" "$kreal"
    printf '%s\n' "$found" | while IFS= read -r f; do
      [ -n "$f" ] || continue
      d=$(cd "$(dirname "$f")" 2>/dev/null && pwd -P) && printf '%s\n' "$d"
    done; } | sort -u)
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    mark=""; [ "$d" = "$jreal" ] && mark=" ← j"; [ "$d" = "$kreal" ] && mark=" ← k"
    f="$d/.claude.json"
    if [ ! -f "$f" ]; then
      echo "  $d .claude.json 無し$mark"
      [ "$d" = "$jreal" ] && caseg_fail "j のフォルダに .claude.json が無い"
      continue
    fi
    email=$(jq -r '(.oauthAccount.emailAddress // empty) | select(type == "string")' "$f" 2>/dev/null); rc=$?
    mt=$(stat -f %m "$f" 2>/dev/null) && mt="$(TZ=Asia/Tokyo date -r "$mt" '+%m/%d %H:%M:%S') JST" || mt="（取得できない）"
    if [ "$rc" -ne 0 ]; then
      echo "  $d メール=（読めない） 更新=$mt$mark"; caseg_fail "$f のメール欄を読めない"; continue
    fi
    if [ -z "$email" ]; then
      email="（メール欄なし）"
    elif ! printf '%s' "$email" | grep -Eq '^[^[:space:]@"]+@[^[:space:]@"]+$' || [ "$(printf '%s' "$email" | wc -l)" -ne 0 ]; then
      echo "  $d メール=（欄の形が合わない。値は出さない） 更新=$mt$mark"; caseg_fail "$f のメール欄の形が合わない"; continue
    fi
    echo "  $d メール=$email 更新=$mt$mark"
    lines="$lines$d	$email
"
    n=$((n + 1))
    [ "$d" = "$jreal" ] && jemail="$email"
  done <<< "$found"
  case "$jemail" in ""|"（メール欄なし）") caseg_fail "j のフォルダのメール欄が取れない"; jemail="" ;; esac
  accounts=$(printf '%s' "$lines" | cut -f2 | grep '@' | tr 'A-Z' 'a-z' | sort -u | grep -c .)
  fp=$(printf '%s' "$lines" | sort | shasum -a 256 | cut -c1-16)
  echo "フォルダ=$n（メール欄を読めたもの） 口座=$accounts 指紋（フォルダとメール、時刻を除く）=$fp"
  CASEG_EMAIL_FP="$fp"
  if [ -n "$jemail" ]; then
    jcount=$(printf '%s' "$lines" | awk -F '\t' -v e="$(printf '%s' "$jemail" | tr 'A-Z' 'a-z')" 'tolower($2) == e' | grep -c .)
    printf '%s' "$lines" | awk -F '\t' -v e="$(printf '%s' "$jemail" | tr 'A-Z' 'a-z')" -v j="$jreal" 'tolower($2) == e && $1 != j {print $1}' \
      | while IFS= read -r d; do echo "!! NG: j の口座が j 以外のフォルダでもログインしている: $d"; done
    if [ "$jcount" -eq 1 ]; then
      echo "j の口座でログインしているフォルダ=1（j だけ。期待どおり）"
    else
      CASEG_NG=1
      echo "j の口座でログインしているフォルダ=$jcount（j 以外にもある）"
    fi
  fi
}
CASEG_EMAIL_FP=""

caseg_protected() {
  local p
  echo "## 触れてはいけないプロセス（期待：どれも残っている）"
  for p in ${CASEG_PROTECT_PIDS:-73215}; do
    ps -o pid=,etime=,stat= -p "$p" 2>/dev/null || caseg_fail "PID $p が無い（中止の条件）"
  done
}

caseg_ports() {
  echo "## ポート（期待：37891 は本番のまま。37991 は試験中だけ LISTEN）"
  local rc
  caseg_lsof -nP -iTCP -sTCP:LISTEN; rc=$?
  if [ "$rc" -eq 1 ]; then
    caseg_fail "待ち受けの一覧の取得に失敗"
  else
    printf '%s\n' "$CASEG_LSOF_OUT" | awk '$9 ~ /:3789[0-9]$|:3799[0-9]$/ {print $1, $2, $9}' | sort -u
    [ "$rc" -eq 2 ] && caseg_fail "待ち受けの一覧が不完全（見られないものがある）"
  fi
  echo "（3789x/3799x に LISTEN が無ければ何も出ない）"
}

caseg_config_sha() {
  local f="${CASEG_ROTATOR_CONFIG:-$HOME/.config/claude-rotator/config.json}"
  echo "## 本番の config.json（sha256 だけ。中身は出さない）"
  local sum
  if [ ! -f "$f" ]; then caseg_fail "本番の config.json が見つからない: $f"; return; fi
  if sum=$(shasum -a 256 "$f" 2>/dev/null) && sum=${sum%% *} && printf '%s' "$sum" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "$sum"
  else
    caseg_fail "本番の config.json の sha256 を取れない"
  fi
}

# 試作プロキシの記録（値を含まない設計）。件数だけを出し、行そのものは出さない。
# 欄（method・pathname・status・swapped・upstreamAuthIsSwapAccount）が取れない行が1行でもあれば、
# 件数を出さずに未確認にする（0件を合格の値として出さない）。
caseg_proxy_log() {
  local log="$1" bad
  echo "## 試作プロキシの記録（件数だけ）"
  if [ -z "$log" ]; then echo "記録の指定なし"; return; fi
  if [ ! -f "$log" ] || [ ! -r "$log" ]; then caseg_fail "記録を読めない: $log"; return; fi
  stat -f '%Sp %z bytes' "$log" 2>/dev/null || stat -c '%A %s bytes' "$log"
  bad=$(awk 'NF && !(/"method":"[A-Z]+"/ && /"pathname":"[^"]*"/ && /"status":[0-9]+[,}]/ \
    && /"swapped":(true|false)[,}]/ && /"upstreamAuthIsSwapAccount":(true|false)[,}]/) {n++} END {print n+0}' "$log") \
    || { caseg_fail "記録を数えられない"; return; }
  if [ "$bad" -ne 0 ]; then caseg_fail "記録に欄の形が合わない行が $bad 行ある。件数は出さない"; return; fi
  echo "全行=$(grep -c . "$log")"
  echo "POST /v1/messages=$(grep '"method":"POST"' "$log" | grep -c '"pathname":"/v1/messages"')"
  echo "swapped=true=$(grep -c '"swapped":true' "$log")"
  echo "upstreamAuthIsSwapAccount=true=$(grep -c '"upstreamAuthIsSwapAccount":true' "$log")"
  echo "status 2xx=$(grep -c '"status":2[0-9][0-9][,}]' "$log")"
  echo "status 2xx 以外=$(grep . "$log" | grep -vc '"status":2[0-9][0-9][,}]')"
  echo "- パスごとの件数:"
  sed -n 's/.*"pathname":"\([^"]*\)".*/\1/p' "$log" | sort | uniq -c | sed 's/^/  /'
}
