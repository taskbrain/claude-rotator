# 案G 試験2 翌日確認 (2026-11-01 07:03-07:05 JST)
- 鍵 "Claude Code-credentials-<redacted>"(属性のみ): cdat 10/31 14:10:45 JST / mdat 11/01 02:10:56 JST(送信前後で同じ)
  → 一晩の間(02:10)に鍵が更新された=自動更新とみられる
- 短問「1+1は？」→「2です。」(done 7:04 AM)。表示 Opus 5.5 · Claude Ultra。エラー・Keychainダイアログなし
- 画面右下「Update installed · /restart to apply」(CLI自動更新あり、未再起動)
- auth status(別シェルから同CLAUDE_CONFIG_DIR): 前後とも loggedIn false / authMethod none / apiProvider firstParty
  → タブは env -i で起動しており環境が異なるため不一致の可能性。タブ内の実動作は正常
