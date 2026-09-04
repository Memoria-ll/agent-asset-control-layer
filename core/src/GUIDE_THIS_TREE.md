# GUIDE_THIS_TREE.md — core/src

この guide は `core/src/` 以下に適用する。子ディレクトリに guide がある場合も先に読む。

## Local invariants

- 一時ファイルから rename する atomic write は、既存ファイルの mode を一時ファイルの作成時に指定して狭い権限を最初から適用し、umask で落ちた既存 mode のビットは書込み後かつ rename 前の `chmod` で復元する。
- managed root の読取り失敗は `withFilePath` で `CoreErrorDetail.path` を実ファイル位置へ変換する。複数ファイル全体を指す失敗だけは message で対象を表す。
- Registry、asset、workflow state などの永続化を追加するときは、同一 process 内の直列化だけで process 間競合を解決したものと扱わない。
- Project Registry reconciliation の timeout は warning を記録して listen を継続し、Registry の read / parse / lock / write failure は listen 前の startup failure とする。
- Workflow State と Agent Execution の link を別 document に永続化する場合、片側の atomic rename を全体の transaction と扱わず、transaction または idempotency を設計する。
- Marker を読む全経路で `.aacl` を real directory、Marker を regular file として扱う。POSIX では nonblocking / no-follow で open し、全 platform で前後の `lstat` と descriptor identity を照合する。
- cross-process lock は恒久 regular lock file への OS-native exclusive FD lock で保持する。lock path を unlink / rename せず、descriptor と path の identity を検証する。
- asset の `list` は手作業の filesystem path を読み、`save` は portable path だけを受理する。list 結果の `relativePath` を無条件に save へ渡さない。
- server の `error` handler は `listen()` と同じ同期 turn で登録する。
- `index.ts` は import-safe な composition root とし、listen などの起動副作用は `main.ts` だけに置く。
- `main.ts` は SIGINT / SIGTERM handler を `startCore()` の await 前に登録する。起動中の停止要求は startup cleanup と listen 済み Core の close が終わるまで保持し、要求後は `core.listening` と startup failure event を記録しない。
- managed root の同一性は `resolve()` による字句正規化で扱う。caller は symlink alias や case-insensitive filesystem 上の綴り違いを別 source として渡さない。
