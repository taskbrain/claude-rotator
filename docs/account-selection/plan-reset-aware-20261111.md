# 口座選び：リセットが近く残りの多い口座を優先する計画（2026-11-11 案）

- 作成: 2026-11-11 JST。読み取り調査のみ。設定・コード・口座の切替は何もしていない。
- 依頼元: 【常設】LLMウィキ（坂根さん指示 11/11 20:18 JST）。
- 対象: 本番で動いているコード `~/.local/lib/claude-rotator/007ce18-codex-feedback-off-20261101`（PID <pid>、11/1 09:07 起動、コミット 007ce18 = PR #94 の merge）。
  ローカルの `main` ブランチ（b3f0db9）は本番より6コミット古い（ecab7a5 / ede8771 / 88bdff9 / 820462b / 8e035b5 / 007ce18 が未反映）。以下の行番号は本番コード（007ce18）のもの。
- 制約: `--resume` は使わない。実行中のセッションは起動し直さない。切り替えは裏で静かに行う。制限の迂回やなりすましにあたる案は入れない。

## 0. 結論

1. **12本中0本の原因は、先方の見立てどおり `sessionAffinity.mode=on`**。on では、セッション鍵のある要求は `current` を見ず、新規セッションは専用の選び方（`selectForNewAssignment`）で決まる。`switch` が動かすのは「鍵の無い要求の既定口座」だけで、README にもそう書いてある。
2. **「リセットが近く残りの多い口座を優先する」選び方は、すでに本番コードに入っている**（PR #93 `ecab7a5` / `ede8771` の `accountUrgency`、既定 off）。いまの `config.json` には `accountUrgency` キーが無いので off のまま。**コード変更なしで、設定 `accountUrgency.mode` を `shadow` → `on` にするだけで使える**（`sessionAffinity.mode=on` が前提で、これは満たしている）。
3. 10/29 の方針 A〜D は、その実装にすべて対応している（A=shadow、B=97%で移り90%の関門は使わない、C=余りそうなときだけターンの区切りで寄せる、D=通知）。
4. 推奨: shadow を1〜2日 → 比較 → on。LLMウィキの大量処理は `switch` ではなく「新しいセッションを起動する」だけで、自動で最優先の口座に載る。これを使い切りの受け皿にする。

## 1. 今の設計と理由

### 1.1 新規セッションの割り当て（いまの本番：urgency off）

事実（コード）:
- `src/proxy-server.js:1907` 以降 `createSessionAffinityRequest`: mode=on で鍵があれば `pinned`。表に無いセッションは `assign(null)` → `accountManager.selectForNewAssignment(...)`（1942行、1974行）。`currentIndex` は使わない。
- `src/account-manager.js:1400` `selectForNewAssignment` → urgency が無いと `selectLegacyAssignment`。
  - 使用率90%以上を新規割当から外す（`DEFAULT_ASSIGN_STOP_UTILIZATION = 0.9`、55行。全滅なら関門を外す）。
  - **残りが最も多い口座から5ポイント以内の帯**だけを候補にする（`ASSIGN_BAND_WIDTH = 0.05`、56行）。
  - 帯の中は `compareNewAssignmentCandidates`（2146行）の順で選ぶ：①5時間枠の使用率 → ②温かいセッション数 → ③週リセットが近いか（36時間以内） → ④週リセット時刻 → ⑤残り。
- 理由のコメント（2141〜2145行、コミット a875a6f 9/18）: 「以前は週リセット優先を先頭にしていたため、リセットに最も近い1口座が帯の中の新規セッションを使い切るまで全部集めた。5h の実負荷を先頭にして散らす」。帯の幅5ポイントは「計測していない作者判断」（38〜40行のコメント）。

LLMウィキの12本に当てはめると（推測を含む）:
- 11/11 20:20 JST の status では、残りが最も多いのは claude@ 17%・ai@ 17〜18%・earthfreedom@ 18%・develop@ 18%・<user>@ 20% で、帯は使用率おおむね22%以下。aragosta@ は31%で帯の外になり、選ばれる余地がない。
- 5h はどの口座も「no data yet」なので①は同点。②の温かい数で回り持ちになる。実際の12本は earthfreedom→develop→<user>→claude の繰り返しで、これと合う（`preflight/affinity-binds.txt`）。

### 1.2 実行中のセッション（固定）

事実（README「セッション単位のアカウント固定」623〜659行、`src/session-affinity.js` 冒頭）:
- 目的は**プロンプトキャッシュ**。「upstream の prompt cache はアカウント（組織）ごとに別物なので、会話の途中でアカウントが変わると、そのセッションは1ターン分のキャッシュを失う」（README 623行）。
- 付け替えるのは「枠が尽きたとき」「再ログインでしか直らない失効」だけ。それ以外の一時的な失敗は、その要求だけ迂回先で完走させる（README 648行）。
- `warmTtlMs` 1時間 = メイン会話のキャッシュ寿命に合わせた値（`session-affinity.js` の `DEFAULT_WARM_TTL_MS` コメント）。冷えた固定は、使用率85%以上なら空いている口座へ移す（`cold_reassign`）。
- 共通枠が尽きても、60秒以内に戻る見込みなら付け替えずに待つ（`rebindGraceMs`）。理由のコメントは「60秒待てば続けられるのに付け替えると、1ターン分を全損させる」（proxy-server.js の common_exhausted 分岐）。
- 導入の経緯: sticky R-S1〜R-S18（9/16〜9/18、`backup/session-affinity-07b9447-20260917` ほか）。config のバックアップ名 `config.json.bak-20260927-affinity-on` と `...-20260928-affinity-stop09` から、9/27 に on にしたと推測している（ファイル名からの推測で、中身は見ていない）。
- 安定性: affinity の README には single-writer の制限が書かれている（コミット 70023b2「document session affinity, its rollback and the single-writer limit」）。

### 1.3 `switch` と `current`

- 事実: README 659行「`mode: "on"` では `current` の意味が変わる。…**セッション鍵を持たないリクエストの既定アカウント**…`switch <account>` も既定アカウントを動かすだけで、固定済みのセッションの結び付け先は動かさない」。
- `src/cli.js:180` `switch` は `/internal/switch` を呼び、`config.activeAccount` を書くだけ。
- いまの鍵の付与率は 100%（351854/353454、status の Session Affinity 行）。鍵の無い要求は0.5%未満で、`current` はほぼ使われていない。
- さらに、off 状態の urgency でも `current` は自動で動く。`rebalanceActiveAccount`（989行）が使用量の定期取得のたびに、36時間以内にリセットする口座へ `current` を移す。実際、server.log では 11/11 20:07:42 JST に手動で ai@ へ戻したあと、**20:16:54 JST に `reason=weekly-reset-priority trigger=usage-refresh` で aragosta@ へ自動で戻っている**。20:20 の status の `current: aragosta@` はこのため。

## 2. 設定だけでできるか

**できる。コード変更は要らない**（本番 007ce18 にある `accountUrgency`）。

- 設定キー: `accountUrgency.mode` = `off` / `shadow` / `on`（`src/account-urgency.js:13`）。`cli.js:387` で読み込み、`cli.js:449` で reload 時に読み直す。
- on には `sessionAffinity.mode=on` が要る。満たさないと shadow に落とし、`activationBlock: session-affinity-required` を出す（`proxy-server.js:484-491`）。
- 選び方（on）: 新規セッションは `urgency.rank`（`account-urgency.js:193-198`）で決まる。並べ方は**必要ペース `(0.97 − 使用率) ÷ リセットまでの時間` が大きい順**、同じなら週リセットの早い順（161行、196行）。これが「リセットが近く残りが多い」をそのまま数式にしたもの。
  - 11/11 20:20 JST の値で計算すると、aragosta@ 約0.027/h、harness@ 約0.024/h、web@ 約0.020/h、codex@ 約0.011/h、dev@ 約0.010/h となり、aragosta@ が先頭になる（概算）。
- 10/29 方針との対応:
  - A（まず記録だけ）: `shadow`。実際の割当は従来どおりで、「提案した口座」と「実際の口座」を `decisions` に記録する（`account-manager.js:1407-1418`）。
  - B（97%で移る・90%の関門は外す）: 停止線 `URGENCY_THRESHOLD = 0.97`（`account-urgency.js:11`）。on では `switchThreshold = min(0.97, 0.99)`（`account-manager.js:157`）。on では従来の90%の関門と5ポイント帯を通らない（1411行）。
  - C（余りそうなときだけターンの区切りで寄せる）: `planUrgencyReassignment`（226行）。次をすべて満たすときだけ、実行中のセッションの結び付け先を移す。
    - 移し先が「使い残しの恐れ」の口座である（リセットまで12時間以内、かつ予測の使い残しが10%以上。`account-urgency.js:189`）。
    - ユーザーのターンの区切り（最後のメッセージが user で、tool_result を含まない。`isUserTurnBoundary` 289行）。
    - 送信中の要求が無い。
    - 前回の付け替えから1時間以上たっている。
    - ペースの差が十分ある（1.25倍以上、かつ 0.01/h 以上）。
    - 付け替えは裏で行い、`--resume` もセッションの起動し直しも要らない。代わりに、そのセッションはキャッシュを1回作り直す。
  - D（自動で寄せて通知もする）: on のときだけ macOS 通知の経路（alertWatch）へ「weekly unused risk」を出す（`checkRisks` 226〜242行、`proxy-server.js:490`）。shadow では下書きを記録するだけ。
- on で変わるそのほかの動き（事実）:
  - `cold_reassign` は止まる（proxy-server.js:1961）。
  - 共通枠の60秒待ちは0になる。
  - 定期取得のたびの `current` の自動移動も止まる（account-manager.js:992-993）。
- 反映のしかた: config.json を書き換えたあと `POST /internal/reload` を1回呼ぶ（README 526行「割当の設定は内部reloadでも再読込できます」）。常駐 server の再起動は要らない。

account-urgency の作業場所の状態:
- `claude-rotator/account-urgency-20261029`（HEAD b3f0db9）はコミットしていない作業の跡。変更7ファイル、未追跡4ファイル（`src/account-urgency.js`、`scripts/simulate-account-urgency.js`、`test/account-urgency.test.js`、`test/account-urgency-simulation.test.js`）。
- `src/account-urgency.js` の sha は本番と違う（60d676… と 790e40…）。整えた版が plan-change（PR #93、`ecab7a5`・`ede8771`）として本番に入っている。
- **使うべきは本番の版**。作業場所に残る価値があるのは、シミュレーター `scripts/simulate-account-urgency.js` とその試験だけ（PR #93 の差分には入っていない）。shadow の結果を再生して比べるのに使えるかもしれない。
- `plan-change-20261031` は PR #93 として統合済み（ede8771）。未追跡は `package-lock.json` だけ。
- `quota-recovery-20261101`（`cff15fd` ほか4コミット、既定 off）は未統合。使用率の観測が1件も無いとき、上限付きで回復の要求を1本だけ送る機能で、今回の目的には要らない。

## 3. 作業計画の案

### 3.1 切り替えるタイミング（on の挙動として）
1. **新しいセッションの最初の要求**: ペース順で一番上の口座へ割り当てる（主な経路）。キャッシュの損失はない。
2. **実行中のセッション**: 上の C の条件を満たしたユーザーのターンの区切りだけ。キャッシュを作り直すのは1回だけ。
3. **尽きたとき**: 97%で次の口座へ移る（B）。
4. `switch` は使わない。どうしても `current` を指定したいときも、効くのは鍵の無い要求だけ。

### 3.2 使い切れそうにないときの寄せ方
- 第1段階（設定だけ）: on にすると、LLMウィキの `claude -p` の大量処理のような新しいセッションは、すべて自動でペースの最上位（いまなら aragosta@ → harness@ → web@ の順）に載る。**LLMウィキ側は `switch` をやめて、普通に新しいセッションを起動するだけでよい**。使い込むとペースが下がるので、次の口座へ自然に移っていく。
- LLMウィキに頼むこと（読み取りだけ）:
  - 処理を始める前に `GET /internal/status` の `accountUrgency.proposedOrder` と各口座の `predictedUnusedFraction` を読み、今の受け皿の口座と、あと何本回せば使い切れるかを決める。
  - 毎日20時の使い残し確認では、この値と status の 7d 欄を突き合わせる。
- 第2段階（必要なら。コード変更）: 実行中のセッションを寄せる窓「12時間・10%」は定数で、設定からは変えられない。72時間先まで見て寄せたい場合は、これを設定にする小さな変更が要る。shadow の結果を見てから決める。

### 3.3 一番良い実現方法
**本番にある `accountUrgency` を設定で有効にする（shadow → on）**。新しいコードは書かない。足りない点が shadow で見えたときだけ、最小のコード変更（窓の設定化など）を別の PR にする。

### 3.4 手順・試し方・元に戻す方法
- S0（読み取りのみ）:
  - 稼働中の設定と `config.json` の差を確かめる。`config.json.next` があるので、reload で意図しない変更まで入らないかを見る。
  - 使用量の定期取得は15分間隔（`usagePolling.intervalMs=900000`）で、観測の鮮度30分（`MAX_AGE`）の内側に収まっている。
- S1（承認が要る）:
  - `config.json` をバックアップ（例 `config.json.bak-20261112-urgency-shadow`）。
  - `"accountUrgency": {"mode": "shadow"}` を足して `POST /internal/reload`。
  - 割当は変わらない。
- S2（1〜2日。方針A）: shadow の記録で比べる。
  - `server.log` の `account_urgency` 行（口座は12桁の指紋）と `/internal/status` の `accountUrgency.decisions`（直近50件だけ）。
  - 提案の口座と実際の口座の食い違いの率。
  - 使い残しの恐れの通知の下書きの件数。
  - 実行中のセッションを寄せる判断（`wouldReassign`）の件数と理由。
  - 使い残しの予測が当たったか（リセットのときの実際の使用率と比べる）。
  - LLMウィキの毎日20時の確認も比較に使う。
- S3（承認が要る）: `mode` を `on` にして reload。最初はリセットが近い口座がある時間帯に、LLMウィキの大量処理を小さい本数から流す。見るものは次のとおり。
  - その本数が提案の口座に載ったか（requestId と `affinity_bind` を照合）。
  - 429 や throttled が増えていないか。
  - 送り先の散らばりの警告。
  - キャッシュの外れ率（`scripts/cache-report.sh`）。
- 元に戻す: `accountUrgency.mode` を `off` にする（またはキーを消す）か、バックアップに戻して `POST /internal/reload` を1回呼ぶ。affinity の表はそのまま残るので、実行中のセッションに影響しない。

### 3.5 リスク
- **新規セッションの集中**: on では5ポイント帯と温かい数による分散を通らないので、新しいセッションがペース最上位の1口座に集まる（a875a6f で避けた形に近い）。5h 枠は97%で止まる。ただ今の口座は5h が「no data yet」で、短時間の流量制限（429）が出ないかは試すまで分からない。LLMウィキの同時実行数に上限を設け、S3 で見る。
- 実行中のセッションの付け替えでは、キャッシュの作り直しが1回起きる（その分の使用量は増える）。1時間に1回まで。
- on では `cold_reassign` と60秒待ちが止まる。尽きたときの動きは変わる（待たずに付け替える）。
- shadow の履歴はメモリに50件しか残らない。比較は server.log で行う（ログは容量で回転するので、1〜2日分が残るかを S0 で確かめる）。
- reload は config.json 全体を読み直すので、ほかの未反映の変更（もしあれば）も一緒に入る。
- 別の作業（caseG の swap 計画、37991番の試験）とは設定もポートも別。本番 37891 の `config.json` だけを触る。

### 3.6 坂根さんに決めてもらう点
1. S1: 本番 `config.json` に `accountUrgency.mode: "shadow"` を足して reload してよいか（バックアップを取ったうえで）。
2. shadow の期間（1日か2日か）と、on へ進む判定の基準。案は「提案と実際の比較で問題がなく、エラーが増えていない」。
3. S3: on へ切り替えてよいか。on で変わること（新規の集中、`cold_reassign`・60秒待ちの停止、97%停止）を受け入れるか。
4. LLMウィキの大量処理を受け皿にする運用（`switch` をやめる、同時実行数の上限、事前に `proposedOrder` を読む）でよいか。
5. 実行中のセッションを寄せる窓「12時間・10%」を設定にするコード変更を、shadow の結果を見てから検討するか。
6. account-urgency-20261029 の作業場所のシミュレーターを残すか（ほかは本番に統合済み）。

## 根拠の置き場
- 本番コード: `~/.local/lib/claude-rotator/007ce18-codex-feedback-off-20261101/src/`（account-urgency.js、account-manager.js、proxy-server.js、session-affinity.js、cli.js）と同じ場所の README.md（520〜526行、621〜659行）。
- LLMウィキの証拠: Mac `/private/tmp/llmwiki-r14-burn-20261111/preflight/`、box `/workspace/llmwiki-research-20261107/pilot/operator/r14-burn-20261111/REPORT.md`。
- server.log: 2026-11-11T11:07:42Z（20:07:42 JST）`reason=manual`、2026-11-11T11:16:54Z（20:16:54 JST）`reason=weekly-reset-priority trigger=usage-refresh`。
- 注意: この文書は口座名（メールのローカル部）を含む。push や PR の前に、公開してよいかを確かめる。

## 4. 実施記録：shadow の導入（2026-11-11）

承認: 坂根さん t97s852「config.json を控えてから accountUrgency を shadow にして reload してよい。shadow は1日。on は明日判断」。

- 控え: `~/.config/claude-rotator/config.json.bak-20261111-203116-before-urgency-shadow`（`cp -p` で権限 0600 と時刻を保持し、`cmp` で一致を確認）。値は表示も記録もしていない。
- 事前の確認:
  - `config.json` と稼働中の設定のキーの差: 見つからなかった。比べたのはキー名だけ。
    - いまの `config.json` と 10/28 の控え（`...bak-20261031T153338-quotaobs`）の差は `quotaObservation.enabled` だけ。プロセスは 11/1 09:07 起動で、この追加より後。
    - reloadで読み直す節は、直前の reload（11/11 15:24 JST）で同じファイルから読まれている。その後の書き込みは `switch`（20:07:42 JST）だけで、`switch` は `activeAccount` しか変えない（`cli.js:180-188`）。
    - `/internal/status` と照合した。口座 id の集合の指紋が一致（16件）。`switchThreshold` 0.99、`sessionAffinity.mode` on も一致。
    - `config.json` は `JSON.stringify(…, null, 2)` の書き方と1バイトも違わないことを確認した（本番の `writeJsonFile` と同じ形）。
  - `config.json.next`（9/14、口座12件の古い形）: 本番コードのどこからも参照されていない。reload では読まれない。
- 変更: `accountUrgency: {"mode":"shadow"}` を末尾に足しただけ。ほかの全キーが元と同じことを確かめ、0600 の一時ファイルから rename で置き換えた。JSON として正しいことも確認した。
- reload: 2026-11-11 20:31:38 JST に `POST /internal/reload` を1回呼んだ。
  - curl は20秒で打ち切られ、HTTP の応答は受け取れなかった。ただし、server 側は 20:31:39 JST に reload を処理している（`openai-bridge reload` の行あり）。
  - 再送はしていない。
- 反映の確認（20:32 JST）:
  - `/internal/status` で `accountUrgency.mode=shadow`、`activationBlock=null`。16口座すべて eligible。
  - `claude-rotator status` に「Account urgency: shadow」と表示される。
  - PID <pid> は残っており、起動時刻も 11/1 09:07 のまま。
  - 固定: reload の前は87件、後は67件。残った67件は結び付け先がすべて同じで、変わったものは0件。
    - 消えた20件は、reload のときの ttl 退避（`affinity_evict reason=ttl`、最終利用から7時間超、6時間の TTL を過ぎていた古い行）。
    - `credential_changed` は5件のままで、`switchesByReason` も変わっていない。
  - server.log にエラーは出ていない。出たのは毎回の reload に出る `config-notice` 1行と、`account_urgency` の shadow 判断の行（`no-unused-risk`）だけ。
  - proposedOrder（other 系）は aragosta → harness → web → codex → dev → info → earthfreedom → claude → develop → <user> → sakane → ai → dx → ax → fde → kazuma。fable 系も上位5件は同じ順。
  - 必要ペースは aragosta 2.70pt/h、dev 0.98pt/h。

### 4.1 戻し方
```sh
cd ~/.config/claude-rotator
cp -p config.json.bak-20261111-203116-before-urgency-shadow config.json
curl -s -m 90 -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:37891/internal/reload
```
`accountUrgency` が無いと off に戻る。固定の表は消えない。

## 5. on へ進むかの判定（明日 11/12 に実施）

### 5.1 判定基準の案
次の「必須」をすべて満たし、「参考」に止める理由が無ければ on へ進んでよい、とする。

必須:
1. **shadow による影響が無い。**
   - 固定セッションの結び付け先が変わっていない。shadow 期間中に `affinity_switch reason=weekly_unused` が0件、`accountUrgency.reassignments` が空であること。
   - proxy のエラー（`proxy-error`、5xx、`outcome` が ok でない行）の率が、前日の同じ時間帯と比べて増えていない。
   - PID <pid> が同じまま動いている。
2. **提案の順序が式どおり。** `/internal/status` の `accountUrgency.accounts` から、`(0.97 − weekly.usedFraction) ÷ リセットまでの時間` を計算し直す。その値が `requiredPace` と一致し、`proposedOrder` が eligible の口座をその降順に並べたものと一致すること（同じ値なら週リセットの早い順）。
3. **通知の下書きが暴れていない。** `notifications` は口座とリセット1回につき1件まで。
4. **記録の量が許容内。** `account_urgency` の行は要求ごとに出る。server.log は容量で回転するので、1日分の比較ができる量が残っていること。残っていなければ、on の判断の前にログの扱いを決める。

参考（on にしたときの効き目の見込み）:
5. 新規割当で、提案と実際が食い違った率と、食い違ったときにどの口座へ寄るはずだったか。率が高いほど on の効き目が大きい。
6. 実行中のセッションを寄せる判断（`wouldReassign=true`）の件数と理由の内訳。aragosta@ は 11/12 08:59 JST 以降、harness@ は 09:00 JST 以降にリセット前12時間に入るので、その時間帯の件数を見る。
7. リセットのときの実際の使用率（aragosta 11/12 20:59 JST、harness 11/12 22:00 JST）と、shadow が出した使い残しの予測との差。
8. LLMウィキの毎日20時の使い残し確認の結果。

### 5.2 比較に使うコマンド（読み取りのみ）
```sh
export PATH="/usr/local/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"; cd ~/.config/claude-rotator
SINCE=2026-11-11T11:31:38Z   # shadow 開始（20:31:38 JST）
# (1) 影響が無いこと
cat server.log.1 server.log | awk -v s=$SINCE '$1>=s' | grep -a -c 'reason=weekly_unused'
cat server.log.1 server.log | awk -v s=$SINCE '$1>=s' | grep -a -c 'proxy-error'
ps -o pid,lstart -p 73215
# (2)(3) 順序の検算・通知・寄せる判断
curl -s http://127.0.0.1:37891/internal/status | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=JSON.parse(s).accountUrgency,H=3.6e6;
const rows=u.accounts.filter(r=>r.eligible).map(r=>({id:r.accountId,rp:r.requiredPace,
  calc:(0.97-r.weekly.usedFraction)/((r.weekly.resetAt-u.generatedAt)/H),reset:r.weekly.resetAt}));
const bad=rows.filter(r=>Math.abs(r.rp-r.calc)>1e-3*Math.max(1,r.calc));
const order=[...rows].sort((a,b)=>b.calc-a.calc||a.reset-b.reset).map(r=>r.id);
console.log({mode:u.mode,paceMismatch:bad.length,orderMatches:JSON.stringify(order)===JSON.stringify(u.proposedOrder.filter(id=>order.includes(id))),
  top3:u.proposedOrder.slice(0,3),reassignments:u.reassignments.length,notifications:u.notifications.map(n=>n.delivery)});})'
# (5)(6) 判断の集計（理由別、提案と実際の食い違い、wouldReassign）
cat server.log.1 server.log | awk -v s=$SINCE '$1>=s' | grep -a ' account_urgency ' | sed 's/^[^{]*//' | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c={};let asg=0,diff=0,would=0;
for(const l of s.trim().split("\n")){if(!l)continue;const e=JSON.parse(l);const k=e.kind+":"+e.reason;c[k]=(c[k]||0)+1;
 if(e.kind==="decisions"&&["required-pace","no-known-candidate"].includes(e.reason)){asg++;if(e.actualAccount!==e.proposedAccount)diff++;}
 if(e.wouldReassign)would++;}
console.log({byReason:c,assignments:asg,assignmentDiffers:diff,wouldReassign:would});})'
# (4) 記録の量（ログの最古時刻と行数）
head -c 30 server.log.1; echo; cat server.log.1 server.log | grep -a -c ' account_urgency '
```
ログの口座は12桁の指紋なので、口座名との対応は `/internal/status` の `accountUrgency.decisions`（直近50件、口座 id 付き）で確かめる。

## 6. on への切り替え（2026-11-12 21:28 JST）

- 判定（11/11 20:31〜11/12 21:16 の shadow）：必須2〜4は合格。必須1は付け替え0件・PID不変だが、proxy-errorがshadow後5件（うち4件は 11/12 01:13〜01:21 の upstream `read ECONNRESET`、1件は 11/10 の /internal/switch 引数ミス）で文字どおりは未達。
- 参考：新規割当88件中64件（73%）で提案と実際が不一致。wouldReassign 0件。
- 坂根さん判断（t98s863）：ECONNRESET は shadow と無関係と見て on にする。
- 実施：`config.json.bak-20261112-212851-before-urgency-on` に控え → `accountUrgency.mode` のみ shadow→on（差分1行）→ `/internal/reload` 21:28:59 http=200、PID <pid> 不変、ログ上 `mode:"on"`。
- 戻し方：控えを config.json へ `cp -p` で戻し、`/internal/reload` を1回。
