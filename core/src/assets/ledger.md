# Ledger — core/src/assets

置き場の規則は root `AGENTS.md` の `## Ledger` にある。

## Traps

- `save` の直列化キーは **`resolve()` した root ディレクトリ**で、chain は module スコープに
  置く。`rootId` はインスタンスごとのラベルにすぎず、同じディレクトリに別の `rootId` を付けた
  store を 2 つ作れるので、キーには使えない。これにより `expectedRevision` は
  **同一 Core プロセス内のすべての store インスタンスにまたがって**守られる。正規化は字句的
  なので symlink 別名と大小非区別 FS の綴り違いは別キーになる (#60)。プロセス外の writer は
  revision 比較と rename の間に割り込めるままで、そちらは #59 (#58)

