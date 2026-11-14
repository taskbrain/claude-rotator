# Claude Rotator worktree 整理の記録（2026-11-07 JST）

坂根さんの指示: t79u（整理の依頼）、カード t79s619（11:34、削除と統合の承認）、t81u（14:08、作業を進めさせる指示）。

## 実施したこと
- 11:37 マージ済みの worktree を8か所、`git worktree remove`（--force なし）で削除した。branch はすべて残っている。
  - codex-usage-clock-20261102、codex-guard-browser-20261103、codex-feedback-off-20261026、docs-codex-home-20261025、alert-watch-fix-20261025、release-v051-20261025、expiry-notice、routing-pr1-20261101
  - codex-usage-20261101 は削除していない。git の対象外にしている tmp/ が残っていたため。
- 11:37 このbranch（docs/caseG-verification-20261103）に2本の branch を merge した。競合はなかった。
  - test/caseG-T1-helper（8d7a4d5）→ f8003cf
  - test/caseG-T3-proxy-proto（fcb2883）→ ef23003
  - 試作のテスト（experiments/caseG-t1・t3）は138件すべて成功、lint も成功。
- 14:1x 保存されていなかった成果を、repo の外 `~/develop/project/claude-rotator-backup-20261107/` に控えた（MANIFEST.tsv と EXCLUDED.txt 付き）。
  - 控えたのはコード・文書・ログの許可リストに当たるファイルだけ。秘密を含みそうな名前のファイルは名前だけを記録し、原本はそのまま残した。
- Orca の表示名と親子関係を整理した。変更前の値は backup の orca-before-20261107.txt にある。

## 再開する場所
- 認証切替の検証は、この worktree（~/develop/project/claude-rotator-wt/docs-caseG-20261103）で再開する。
- T1・T3 の試作は実機で試していない。本番には入れない。
