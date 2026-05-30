# amzcard

Amazon の商品ページ URL を X (Twitter) の OGP カードに対応した URL に変換する Cloudflare Workers アプリ。

## 仕組み

- `https://amzcard.winebarrel.workers.dev/dp/<ASIN>` にアクセスすると、Amazon の商品ページから title / image / description を抽出し、`og:*` と `twitter:card` メタタグを埋めた HTML を返す。これを X に貼るとカード表示される。
- ルートページ (`/`) は Amazon URL を入力するとプロキシ URL を返し、X カード風のプレビューを表示する。

## 開発

```bash
npm ci
npm run lint        # Biome (lint + format check)
npm run typecheck   # tsc --noEmit
npm run build       # wrangler deploy --dry-run
npm run format      # Biome auto-fix
```

## ローカルで動かす

```bash
npm run dev
```

`http://localhost:8787/` でトップページ、`http://localhost:8787/dp/B0CJY79XQY` 等で OGP HTML を確認できる。

## デプロイ

main への push で GitHub Actions が `wrangler deploy` を実行する (`src/` や `wrangler.jsonc`, 依存ファイルが変更された場合のみ)。
