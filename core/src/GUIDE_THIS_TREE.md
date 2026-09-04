# GUIDE_THIS_TREE.md — core/src

この guide は `core/src/` 以下に適用する。子ディレクトリに guide がある場合も先に読む。

## Local invariants

- 一時ファイルから rename する atomic write は、既存ファイルの mode を一時ファイルの作成時から引き継ぐ。狭い mode を書込み後の `chmod` だけで復元しない。
- managed root の読取り失敗は `withFilePath` で `CoreErrorDetail.path` を実ファイル位置へ変換する。複数ファイル全体を指す失敗だけは message で対象を表す。
- Registry、asset、workflow state などの永続化を追加するときは、同一 process 内の直列化だけで process 間競合を解決したものと扱わない。
