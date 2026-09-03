# Ledger — core/src/assets

置き場の規則は root `AGENTS.md` の `## Ledger` にある。

## Traps

- `AssetListResult.failures` は **全 managed root の診断が混ざった 1 本の列**で、`source.rootId`
  でしか出どころを区別できない。**1 つの root について判断する消費側は、結果を絞るのではなく
  `scanRoot` でその root だけを走査する。** 絞り込みが効くのは全 root の走査が終わったあと
  なので、応答しないマウント上の root が 1 つあると健全な root の処理がその完了を待たされる
  — `list()` を呼んで `rootId` で filter する形では防げない (#58)

- `save` の直列化キーは **`resolve()` した root ディレクトリ**で、chain は module スコープに
  置く。`rootId` はインスタンスごとのラベルにすぎず、同じディレクトリに別の `rootId` を付けた
  store を 2 つ作れるので、キーには使えない。これにより `expectedRevision` は
  **同一 Core プロセス内のすべての store インスタンスにまたがって**守られる。正規化は字句的
  なので symlink 別名と大小非区別 FS の綴り違いは別キーになる (#60)。プロセス外の writer は
  revision 比較と rename の間に割り込めるままで、そちらは #59 (#58)

- **managed root の同一性判定は `resolve()` による字句正規化までしか見ていない。** symlink 別名と
  大小非区別 FS の綴り違いは別 root として受理され、同じ物理ファイルが 2 つの論理 source として
  list される。duplicate 検査は `rootId` で絞っているので診断も出ない。#4 の override / disable は
  「同じ id を別 root で宣言する」で成立させるので、**この重複は実在しない override 候補として
  #4 の判定に直接混入する**。完全な identity 判定は #60 (#58)

- **`save` が受理する `relativePath` は Windows でも成立する名前に限る**（禁止文字 `< > " | ? *`、
  制御文字、末尾のピリオド/空白、予約デバイス名 `CON` / `PRN` / `AUX` / `NUL` / `CONIN$` /
  `CONOUT$` / `COM1-9` / `COM¹²³` / `LPT1-9` / `LPT¹²³` を、末尾空白を落とした stem の
  完全一致で拒否）。**数字は 1 始まりで、`COM0` / `LPT0` は予約ではないので受理する。**
  **`list` にはこの制限が効かない** — 正本は
  human-readable filesystem なので、手で置かれた名前はそのまま読む。したがって
  「list に出た asset の `relativePath` を、そのまま save に渡し直せるとは限らない」。
  read-modify-write する消費側はこの非対称を前提にすること (#58)
