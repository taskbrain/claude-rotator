#!/usr/bin/env node
// codex-rotator の実行ファイル。振り分けは src/codex/cli.js が行い、ここは終了コードを返すだけ。
import { main } from '../src/codex/cli.js';

process.exitCode = await main(process.argv.slice(2));
