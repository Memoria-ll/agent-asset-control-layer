# Ledger — core/src/catalog

置き場の規則は root `AGENTS.md` の `## Ledger` にある。

## Traps

- **専用の execution-target catalog は `readFile` の前に `stat().isFile()` を通す。**
  `readFile` の errno だけでは FIFO・デバイス・ソケットなどの非通常ファイルを読み取り開始前に分類できない (#66)
