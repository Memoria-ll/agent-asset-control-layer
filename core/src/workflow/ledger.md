# Ledger — core/src/workflow

置き場の規則は root `AGENTS.md` の `## Ledger` にある。

## Invariants / identity keys

- **`ExecutionInstanceId` は全 Definition を通じて一意（#50 裁定2）。** State のファイル名が
  instance id 単独 (`workflows/<id>.json`) なのはこの一意性に依る。同居する `workflowId` は
  名前空間ではなく**所属不一致の検出用**で、`readStoredState` が突き合わせて
  `instance_workflow_mismatch` を返す。schema は opaque 値の一意性を検査できないので、
  独自に発番する producer 側がこの一意性を負う (#7)

- **State store は execution instance id を「受け取らず」「組み立てる」。** 注入口は乱数部分だけ
  (`newInstanceSuffix`) で、`instance-<suffix>` の合成と検査は store が持つ。契約が文字集合を
  縛らないため、id を丸ごと受け取る形は「契約上妥当だがファイル名として使えない値」を
  無限に生む（空白・接頭辞・デバイス名・大小文字衝突・長さ・Unicode 正規化で 5 ラウンド分の
  指摘が出た）。**検査は正規化ではなく拒否**で行う — 小文字化や NFC 変換で畳むと、相異なる
  id が 1 ファイルに写像されて一意性が壊れる (#7)

- **ファイル名の安全性は「明示的な英数字集合」で決める — 禁止則の積み上げでは閉じない。**
  大文字禁止 + NFC 必須でも σ と ς は同じ文字に case-fold するため、両方が 1 ファイルを指す。
  case pair も正規化形も持たない集合 (`[a-z0-9-]`) だけが次の一手を許さない (#7)

- **Core が作る階層だけを検査対象にする。** state directory とその配下は store の所有物なので
  実ディレクトリであることを要求できるが、設定されたルートより上の祖先は運用者のもの。
  ルートから全祖先を辿る検査は OS 提供の symlink (macOS の `/var`) を弾き、そのために
  パスを両セパレータで分割する必要が生じて、backslash を含む POSIX ディレクトリ名を壊す (#7)
