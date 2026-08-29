# PR #33 Pre-Merge Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR #33で再現された6件の認証・routing・macOS lifecycleバグを、既存構造内の最小変更で修正して安全にmerge・再配布する。

**Architecture:** routing分類、credential preflight、refresh専用durable I/O、reload ownership gate、launchctl deadline、rollback healthを独立した境界として修正する。新しい認証基盤や汎用監視層は作らず、各境界に1本以上の再現テストを先行追加する。

**Tech Stack:** Node.js 20/22 ESM、`node:test`、macOS LaunchAgent/`launchctl`、macOS Keychain、Linux JSON secret store、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-08-29-premerge-correctness-fixes-design.md`

## Global Constraints

- token、refresh token、authorization code、credential JSON、digestをargv、fixture、log、error、文書へ出さない。
- 新しい外部依存を追加しない。
- 実macOS Keychain testは既存の`CLAUDE_ROTATOR_REAL_KEYCHAIN=1` opt-inを維持する。
- 変更中はfocused test、最終段階で`npm run check`を1回実行する。
- 未追跡の`package-lock.json`を編集・stageしない。
- PR #33をsquash mergeするのはcritical再レビューとCI 4 matrixの成功後だけとする。

## File Map

- `src/account-manager.js`: 共通quota枯渇分類とaccount選択。
- `src/proxy-server.js`: duplicate credential preflight、reload ownership gate、request routing。
- `src/cli.js`: reload callbackへaccountsとownership modeを渡す。
- `src/json-file.js`: refresh境界専用のdurable JSON write/remove。
- `src/secret-store.js`: refresh intentとLinux credential commitでdurable helperを使う。
- `src/macos-service.js`: monotonic deadline付きlaunchctl操作。
- `src/install.js`: 変更前health snapshotとrollback後health確認。
- `test/account-manager.test.js`, `test/proxy-server.test.js`: routing/preflight/reload回帰。
- `test/secret-store.test.js`: durable write/remove回帰。
- `test/macos-service.test.js`, `test/install.test.js`, `test/cli.test.js`: macOS/reload回帰。

---

### Task 1: Common token/request exhaustion routing

**Files:**
- Modify: `src/account-manager.js:35-82,956-960`
- Test: `test/account-manager.test.js`
- Test: `test/proxy-server.test.js:1930-1980`

**Interfaces:**
- Consumes: `quotaUnavailableReasonForModelFamily(quota, threshold, modelFamily)`。
- Produces: `isUnifiedQuotaExhaustion(reason)`が5h/7d/token/requestのfamily-independent blockerをtrueにする。

- [ ] **Step 1: managerの失敗テストを追加する**

```js
it('switches every model family away from common token and request exhaustion', () => {
  for (const reasonKind of ['token', 'request']) {
    const manager = managerWithExhaustedCurrentAndReadyAlternate(reasonKind);
    assert.equal(manager.getActiveAccount('fable').id, 'acct_2');
    assert.equal(manager.getActiveAccount(null).id, 'acct_2');
  }
});
```

- [ ] **Step 2: manager testがREDになることを確認する**

Run: `node --test --test-name-pattern='common token and request exhaustion' test/account-manager.test.js`

Expected: `getActiveAccount`が`null`を返してFAIL。

- [ ] **Step 3: proxyの失敗テストを追加する**

2accountを用意し、acct_1のtokenまたはrequest remainingを0、acct_2をreadyにする。
FableとSonnetの両方がacct_2のAuthorizationへ到達し、acct_1へ1件も到達しないことを
literalでassertする。既存の「out of scope gap」コメントは削除する。

- [ ] **Step 4: 共通分類へtoken/requestを追加する**

```js
export function isUnifiedQuotaExhaustion(reason) {
  return ['token_rate_limit_exhausted', 'request_rate_limit_exhausted'].includes(reason?.type)
    || (reason?.type === 'quota_exhausted'
      && (['5h', '7d'].includes(reason.window) || String(reason.window || '').startsWith('7d ')));
}
```

- [ ] **Step 5: focused testsをGREENにする**

Run: `node --test test/account-manager.test.js test/proxy-server.test.js`

Expected: 0 fail。

- [ ] **Step 6: commitする**

```bash
git add src/account-manager.js test/account-manager.test.js test/proxy-server.test.js
git commit -m "fix(routing): 共通rate limit時に代替口座へ切替"
```

---

### Task 2: Duplicate refresh-token preflight

**Files:**
- Modify: `src/proxy-server.js:150-220,292-330,1330-1365`
- Test: `test/proxy-server.test.js`

**Interfaces:**
- Produces: `duplicateRefreshTokenAccountIds(accounts, secretStore) -> Promise<Set<string>>`。
- Produces: duplicate accountはprovider handoff前に`oauth_refresh_failed`としてparkされる。
- Consumes: `secretStore.get(accountId)`。`getOperational`はintent状態を変えるため使わない。

- [ ] **Step 1: 同一tokenの失敗テストを追加する**

```js
it('parks every account sharing a refresh token before native handoff', async () => {
  const store = new MemorySecretStore();
  await store.set('acct_1', credential('access-1', 'shared-refresh'));
  await store.set('acct_2', credential('access-2', 'shared-refresh'));
  let exchanges = 0;
  const proxy = await startProxy({
    accounts: [oauthAccount('acct_1'), oauthAccount('acct_2')],
    secretStore: store,
    tokenRefresher: async () => { exchanges += 1; throw new Error('must not run'); },
  });
  const status = await requestStatus(proxy);
  assert.equal(exchanges, 0);
  assert.deepEqual(status.accounts.map(a => a.unavailableReason.type), [
    'oauth_refresh_failed',
    'oauth_refresh_failed',
  ]);
  assert.equal(JSON.stringify(status).includes('shared-refresh'), false);
});
```

- [ ] **Step 2: duplicate testがREDになることを確認する**

Run: `node --test --test-name-pattern='sharing a refresh token' test/proxy-server.test.js`

Expected: token refresherが1回呼ばれるか、片方だけがparkされてFAIL。

- [ ] **Step 3: preflight helperを実装する**

OAuth accountだけを走査し、`createHash('sha256')`でrefresh tokenをdigest化してMapへgroupする。
group sizeが2以上のIDだけをSetで返し、digestは関数外へ返さない。

```js
async function duplicateRefreshTokenAccountIds(accounts, secretStore) {
  const groups = new Map();
  for (const account of refreshableStoredAccounts(accounts)) {
    const secret = await secretStore.get(account.id);
    if (!secret?.refreshToken) continue;
    const key = createHash('sha256').update(secret.refreshToken).digest('hex');
    const ids = groups.get(key) || [];
    ids.push(account.id);
    groups.set(key, ids);
  }
  return new Set([...groups.values()].filter(ids => ids.length > 1).flat());
}
```

- [ ] **Step 4: startup/reloadへpreflightを接続する**

初回`operationalStateCheck`より前にduplicate Setを適用する。reloadではnext accountsを
replaceする前にscanし、replace直後にduplicate accountをparkしてからHTTP成功を返す。
`refreshAccountUsage`はduplicate errorのaccountをprovider handoff前にskipする。

- [ ] **Step 5: 重複解消reloadテストを追加する**

acct_2のsecretとcredential revisionを別refresh tokenへ更新してreloadし、両accountの
duplicate errorが消え、token refresherが通常どおり呼ばれることをassertする。

- [ ] **Step 6: focused proxy testをGREENにする**

Run: `node --test test/proxy-server.test.js`

Expected: 0 fail、status/logにtoken/digestなし。

- [ ] **Step 7: commitする**

```bash
git add src/proxy-server.js test/proxy-server.test.js
git commit -m "fix(auth): 重複refresh tokenをhandoff前に停止"
```

---

### Task 3: Durable refresh-boundary persistence

**Files:**
- Modify: `src/json-file.js`
- Modify: `src/secret-store.js:650-690,1020-1050`
- Test: `test/secret-store.test.js`

**Interfaces:**
- Produces: `writeJsonFileDurable(path, value, mode = 0o600, deps?) -> Promise<void>`。
- Produces: `removeFileDurable(path, deps?) -> Promise<void>`。
- Durable helperはtemporary file sync → rename → parent directory syncの順で完了する。

- [ ] **Step 1: durable write失敗テストを追加する**

file syncを拒否するdependencyを渡し、destinationが作られずtemporary fileがcleanupされ、
promiseがrejectされることをassertする。directory sync失敗も成功扱いにしない。

- [ ] **Step 2: durable remove失敗テストを追加する**

remove後のdirectory syncを拒否し、`DurableRefreshIntentStore.remove`が
`NATIVE_REFRESH_OUTCOME_UNKNOWN`へ変換することをassertする。

- [ ] **Step 3: testsがREDになることを確認する**

Run: `node --test --test-name-pattern='durable|directory sync' test/secret-store.test.js`

Expected: durable helper未定義またはsync未実行でFAIL。

- [ ] **Step 4: durable helperを実装する**

`open(path, 'wx', mode)`でtemporary fileを開き、`writeFile`、`chmod`、`sync`、`close`、
`rename`、`open(dirname(path), O_RDONLY)`、directory `sync`の順に実行する。失敗時は
handleをcloseしtemporary pathを削除する。removeは`rm(force:true)`後にdirectoryをsyncする。

- [ ] **Step 5: refresh境界だけhelperへ切り替える**

`DurableRefreshIntentStore.write/remove`と`LinuxFileSecretStore.setUnlocked`だけをdurable
helperへ変更する。config/runtime/install JSONは既存`writeJsonFile`のまま維持する。

- [ ] **Step 6: secret-store testsをGREENにする**

Run: `node --test test/secret-store.test.js`

Expected: 0 fail。real Keychain testは既定skip。

- [ ] **Step 7: commitする**

```bash
git add src/json-file.js src/secret-store.js test/secret-store.test.js
git commit -m "fix(store): refresh境界をdurableに永続化"
```

---

### Task 4: Reload credential ownership gate

**Files:**
- Modify: `src/cli.js:333-375`
- Modify: `src/proxy-server.js:45-235`
- Test: `test/cli.test.js`
- Test: `test/proxy-server.test.js`

**Interfaces:**
- `reloadAccounts()`はlegacyの`Account[]`または
  `{ accounts: Account[], allowLiveClaudeCodeCredentials: boolean }`を返す。
- ownership modeが起動時から変わったprocessはupstream credential処理をfail-closedし、
  restartを要求する。

- [ ] **Step 1: manual→gateway reloadの失敗テストを追加する**

initial allow-live=true、reload result=falseとする。`POST /internal/reload`が409、後続
`POST /v1/messages`が503となり、currentCredentialReader/upstreamが0回であることをassertする。

- [ ] **Step 2: gateway→manual reloadの失敗テストを追加する**

initial false、reload result trueでも409と503を維持し、同一processで権限を緩めないことを
assertする。

- [ ] **Step 3: testsがREDになることを確認する**

Run: `node --test --test-name-pattern='ownership|restart' test/proxy-server.test.js test/cli.test.js`

Expected: reloadが200またはcredential readerが呼ばれてFAIL。

- [ ] **Step 4: proxyにownership restart gateを実装する**

`credentialOwnershipRestartRequired`をcreateProxyServer closureに置く。reload resultをvalidationし、
modeが異なる場合はflagをtrueにしてaccountsをreplaceせず409を返す。health/statusは読めるが、
usage refreshとupstream requestはcredential解決前に503を返す。同じmodeのreloadは従来どおり。

- [ ] **Step 5: CLI reload callbackをobject resultへ変更する**

```js
return {
  accounts: nextAccounts,
  allowLiveClaudeCodeCredentials: !nextLoginOverride,
};
```

startupのbooleanと同じ判定関数を使い、override検査を重複実装しない。

- [ ] **Step 6: focused testsをGREENにする**

Run: `node --test test/cli.test.js test/proxy-server.test.js`

Expected: 0 fail、既存array reload互換testもpass。

- [ ] **Step 7: commitする**

```bash
git add src/cli.js src/proxy-server.js test/cli.test.js test/proxy-server.test.js
git commit -m "fix(auth): ownership変更時のreloadを停止"
```

---

### Task 5: Wall-clock bounded launchctl operations

**Files:**
- Modify: `src/macos-service.js`
- Test: `test/macos-service.test.js`

**Interfaces:**
- service operations accept optional `serviceTimeoutMs`, `monotonicNow`, `sleep` for deterministic tests。
- all launchctl calls receive one operation-wide monotonic deadline and AbortSignal。

- [ ] **Step 1: hung launchctl testを追加する**

`execFileImpl`が`print`でsettleしないfixtureを作る。`serviceTimeoutMs:20`で
`reconcileMacosMainService`が250ms guardより前にrejectし、bootstrapへ進まないことをassertする。

- [ ] **Step 2: command latency込みdeadline testを追加する**

fake monotonic clockを各commandで進め、poll sleepだけでなくprint/bootout時間も15秒budgetから
差し引かれることをassertする。

- [ ] **Step 3: testsがREDになることを確認する**

Run: `node --test test/macos-service.test.js`

Expected: hung commandがguardまでpending、またはcommand latencyを無視してFAIL。

- [ ] **Step 4: operation deadline helperを実装する**

operation開始時の`monotonicNow()`からdeadlineを作る。各query/runはremaining timeを計算し、
AbortControllerのtimerと`Promise.race`でexecをboundedにする。default execFileには`signal`を渡す。
remainingが0ならcommandを開始せずservice timeout errorを投げる。

- [ ] **Step 5: deregistration pollをdeadline基準へ変更する**

固定300回ではなく、query後のremaining timeがある間だけ50ms以下sleepする。既存のasync remove、
never remove、watchdog stop testsを新deadline APIへ合わせる。

- [ ] **Step 6: macOS service testsをGREENにする**

Run: `node --test test/macos-service.test.js`

Expected: 0 fail、hung fixtureの未解決promiseがtest processを保持しない。

- [ ] **Step 7: commitする**

```bash
git add src/macos-service.js test/macos-service.test.js
git commit -m "fix(macos): launchctl操作を実時間で制限"
```

---

### Task 6: Rollback generation health verification

**Files:**
- Modify: `src/install.js:145-280,320-455`
- Modify: `src/cli.js:550-640`
- Test: `test/install.test.js`
- Test: `test/cli.test.js`

**Interfaces:**
- lifecycle operationは変更前のhealth `{ ok, serviceGeneration }`をboundedにsnapshotする。
- rollbackは元々登録済みかつ健康だったmainだけ、旧generationの復帰を確認する。

- [ ] **Step 1: install rollback health失敗テストを追加する**

旧generationを返した後、新generation healthを失敗させ、registration復元後も旧generationを
返さないfixtureを使う。結果が`AggregateError`で`rollback failed`を含むことをassertする。

- [ ] **Step 2: uninstall rollback health成功/失敗テストを追加する**

uninstall途中のwatchdog stop failureを起こし、旧job復元後に旧generationが返れば元errorだけ、
返らなければrollback errorも保持することをassertする。

- [ ] **Step 3: testsがREDになることを確認する**

Run: `node --test --test-name-pattern='rollback.*generation|old generation' test/install.test.js test/cli.test.js`

Expected: healthCheckがrollback後に呼ばれずFAIL。

- [ ] **Step 4: 変更前health snapshotを追加する**

registrations.mainがtrueの場合だけ、既存`runMacosHealthAttempt`のbounded callで現在healthを読む。
`ok:true`かつnon-empty generationだけをrollback expectationとして保存する。preflight health取得失敗は
「元々健康だった」という保証を作らず、主操作は継続する。

- [ ] **Step 5: rollback後health checkを追加する**

file/registration restore後、保存した旧generationを`waitForMacosHealth`へ渡す。失敗は
`attemptRollback`でerrorsへ追加する。installとuninstallの両rollbackから同じhelperを使う。

- [ ] **Step 6: CLI uninstallへhealthCheckを渡す**

macOS installと同じ`readHealth`をuninstall lifecycleにも注入し、test dependencyも同じ形にする。

- [ ] **Step 7: focused install/CLI testsをGREENにする**

Run: `node --test test/install.test.js test/cli.test.js test/macos-service.test.js`

Expected: 0 fail。

- [ ] **Step 8: commitする**

```bash
git add src/install.js src/cli.js test/install.test.js test/cli.test.js
git commit -m "fix(macos): rollback後の旧generationを検証"
```

---

### Task 7: Review, CI, merge, and merged-snapshot deployment

**Files:**
- Verify only: entire repository and deployed immutable snapshot。

- [ ] **Step 1: focused combined testsを実行する**

Run:

```bash
node --test test/account-manager.test.js test/proxy-server.test.js test/secret-store.test.js test/macos-service.test.js test/install.test.js test/cli.test.js
```

Expected: 0 fail。

- [ ] **Step 2: full source-of-truth checkを実行する**

Run: `npm run check`

Expected: lint success、全test 0 fail、real Keychain testのみ既定skip。

- [ ] **Step 3: diffとsecret非露出を確認する**

Run:

```bash
git diff --check origin/main..HEAD
git status --short
git diff --stat origin/main..HEAD
```

Expected: diff clean、未追跡はユーザー所有`package-lock.json`のみ。

- [ ] **Step 4: critical independent re-reviewを実行する**

base=`origin/main`、head=`HEAD`で6 findingsの修正と新testをread-only確認する。Critical/Importantが
残ればmergeせず該当taskへ戻る。

- [ ] **Step 5: PR #33へpushしCI 4 matrixを待つ**

Run:

```bash
git push
gh pr checks 33 --watch --interval 10
```

Expected: macOS/Ubuntu × Node 20/22の4件がpass。

- [ ] **Step 6: squash mergeする**

Run: `gh pr merge 33 --squash`

Expected: PR stateがMERGED。remote feature branchは削除しない。

- [ ] **Step 7: local mainをfast-forwardする**

`/Users/cirkit/develop/project/claude-rotator/main`の変更が未追跡`package-lock.json`だけであることを
再確認し、`git pull --ff-only origin main`を実行する。tracked changeがあれば停止する。

- [ ] **Step 8: merge commitからimmutable snapshotを作る**

snapshot名は`<short-merge-sha>-premerge-fixes-20260829`とし、`git archive`から展開する。
既存snapshotを上書きしない。

- [ ] **Step 9: non-force installとhealth確認を行う**

新snapshotのNode 22 CLIを絶対pathで`install`し、exit 0、plist path、新generation health、
watchdog marker hash、refresh marker 0を確認する。失敗時はforce再試行しない。

- [ ] **Step 10: public wrapperをatomicに切り替えてsmoke testする**

health成功後だけ`~/.local/bin/claude-rotator`を新snapshotへ変更する。`status`、幅180の
`monitor --once`、9 accounts、OAuth failure 0、Fable/Other各9 entriesを確認する。

- [ ] **Step 11: branch/worktreeを保持して結果を報告する**

PR URL、merge SHA、snapshot path、test/CI件数、runtime generation、残存skip、未追跡
`package-lock.json`を報告する。worktreeとlocal branchはユーザーの明示削除指示がない限り残す。
