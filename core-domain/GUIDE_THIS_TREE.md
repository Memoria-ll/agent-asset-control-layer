# GUIDE_THIS_TREE.md — core-domain

この guide は `core-domain/` 以下に適用する。`src/` または `tests/` の子 guide がある場合も先に読む。

## Change considerations

- 公開面は `src/index.ts` の re-export。公開 API を追加した変更で re-export も追加し、package の公開 API を使うテストは `src/index.ts` から import する。
