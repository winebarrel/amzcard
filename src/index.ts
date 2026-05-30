const TWITTERBOT_UA = "Twitterbot/1.0";
const AMAZON_HOST = "www.amazon.co.jp";

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    const dp = url.pathname.match(/^\/dp\/([A-Z0-9]{10})\/?$/i);
    if (dp) {
      return ogpPage(dp[1].toUpperCase());
    }

    const api = url.pathname.match(/^\/api\/preview\/([A-Z0-9]{10})\/?$/i);
    if (api) {
      return previewApi(api[1].toUpperCase());
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(indexHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;

type Product = {
  asin: string;
  amazonUrl: string;
  title: string;
  image: string | null;
  description: string;
};

async function fetchAmazonProduct(asin: string): Promise<Product> {
  const amazonUrl = `https://${AMAZON_HOST}/dp/${asin}`;
  let title = `Amazon: ${asin}`;
  let image: string | null = null;
  let description = "";
  try {
    const res = await fetch(amazonUrl, {
      headers: {
        "User-Agent": TWITTERBOT_UA,
        "Accept-Language": "ja,en;q=0.9",
      },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (res.ok) {
      const parsed = await parseAmazonHtml(res);
      if (parsed.title) title = parsed.title;
      if (parsed.image) image = parsed.image;
      if (parsed.description) description = parsed.description;
    }
  } catch {
    // fall through with defaults
  }
  return { asin, amazonUrl, title, image, description };
}

async function ogpPage(asin: string): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(`https://amzcard.invalid/dp/${asin}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const product = await fetchAmazonProduct(asin);
  const body = renderOgp(product);
  const response = new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

async function previewApi(asin: string): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(`https://amzcard.invalid/api/preview/${asin}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const product = await fetchAmazonProduct(asin);
  const response = new Response(JSON.stringify(product), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

type Parsed = { title?: string; image?: string; description?: string };

async function parseAmazonHtml(res: Response): Promise<Parsed> {
  const titleTag = new TextCollector();
  const productTitle = new TextCollector();
  const meta: { description?: string } = {};
  const images: Array<{ url: string; w: number }> = [];
  let landingImage: string | undefined;

  const rewriter = new HTMLRewriter()
    .on("title", titleTag)
    .on("#productTitle", productTitle)
    .on('meta[name="description"]', {
      element(el) {
        const c = el.getAttribute("content");
        if (c) meta.description = c;
      },
    })
    .on("[data-a-dynamic-image]", {
      element(el) {
        const raw = el.getAttribute("data-a-dynamic-image");
        if (!raw) return;
        try {
          const map = JSON.parse(raw) as Record<string, [number, number]>;
          for (const [u, dims] of Object.entries(map)) {
            const w = Array.isArray(dims) ? Number(dims[0]) : 0;
            images.push({ url: u, w });
          }
        } catch {
          // ignore
        }
      },
    })
    .on("#landingImage", {
      element(el) {
        landingImage = el.getAttribute("src") ?? undefined;
      },
    });

  await rewriter.transform(res).text();

  const out: Parsed = {};

  const pt = productTitle.out.trim();
  if (pt) {
    out.title = pt;
  } else {
    const tt = titleTag.out.trim().replace(/\s*\|\s*Amazon\s*$/i, "");
    if (tt) out.title = tt;
  }

  if (images.length) {
    images.sort((a, b) => b.w - a.w);
    out.image = images[0].url;
  } else if (landingImage) {
    out.image = landingImage;
  }

  if (meta.description) {
    out.description = meta.description.slice(0, 200);
  }

  return out;
}

class TextCollector {
  out = "";
  text(chunk: Text) {
    this.out += chunk.text;
  }
}

function renderOgp(p: {
  asin: string;
  amazonUrl: string;
  title: string;
  image: string | null;
  description: string;
}): string {
  const t = htmlEscape(p.title);
  const d = htmlEscape(p.description);
  const url = htmlEscape(p.amazonUrl);
  const img = p.image ? htmlEscape(p.image) : "";
  const card = img ? "summary_large_image" : "summary";

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>${t}</title>
<link rel="canonical" href="${url}">
<meta property="og:type" content="product">
<meta property="og:title" content="${t}">
<meta property="og:url" content="${url}">
${img ? `<meta property="og:image" content="${img}">` : ""}
${d ? `<meta property="og:description" content="${d}">` : ""}
<meta name="twitter:card" content="${card}">
<meta name="twitter:title" content="${t}">
${img ? `<meta name="twitter:image" content="${img}">` : ""}
${d ? `<meta name="twitter:description" content="${d}">` : ""}
<meta http-equiv="refresh" content="0;url=${url}">
</head>
<body>
<p>Redirecting to <a href="${url}">${url}</a></p>
</body>
</html>`;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function indexHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>amzcard</title>
<style>
  :root { color-scheme: light dark; --border: #cfd9de; --muted: #536471; --bg: #f7f9fa; }
  @media (prefers-color-scheme: dark) { :root { --border: #2f3336; --muted: #8b98a5; --bg: #16181c; } }
  body { font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; line-height: 1.6; }
  h1 { font-size: 1.4rem; margin-bottom: 0.4rem; }
  p.lead { color: var(--muted); margin-top: 0; }
  input[type=text] { width: 100%; padding: 0.6rem 0.7rem; font-size: 1rem; border: 1px solid #bbb; border-radius: 6px; box-sizing: border-box; }
  .hint { color: var(--muted); font-size: 0.85rem; margin-top: 0.4rem; }
  .result { margin-top: 1.2rem; padding: 0.9rem 1rem; background: rgba(127,127,127,0.1); border-radius: 6px; display: none; }
  .result.show { display: block; }
  .result.error { color: #c00; }
  .url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.95rem; word-break: break-all; }
  button { margin-top: 0.6rem; padding: 0.4rem 0.9rem; font-size: 0.9rem; cursor: pointer; border-radius: 4px; border: 1px solid #888; background: transparent; color: inherit; }

  .preview-label { margin-top: 1.5rem; font-size: 0.85rem; color: var(--muted); }
  .card { margin-top: 0.4rem; border: 1px solid var(--border); border-radius: 16px; overflow: hidden; max-width: 100%; display: none; }
  .card.show { display: block; }
  .card a { display: block; color: inherit; text-decoration: none; }
  .card .img-wrap { background: var(--bg); aspect-ratio: 1.91 / 1; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .card .img-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .card .img-wrap.empty { color: var(--muted); font-size: 0.85rem; }
  .card .body { padding: 0.7rem 0.9rem; border-top: 1px solid var(--border); }
  .card .domain { color: var(--muted); font-size: 0.8rem; }
  .card .title { font-size: 0.95rem; font-weight: 600; margin: 0.15rem 0 0.2rem; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .card .desc { color: var(--muted); font-size: 0.85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .skeleton { display: none; }
  .skeleton.show { display: block; }
  .skeleton .img-wrap { background: linear-gradient(90deg, var(--bg) 25%, rgba(127,127,127,0.15) 50%, var(--bg) 75%); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; }
  .skeleton .bar { height: 0.7rem; background: linear-gradient(90deg, var(--bg) 25%, rgba(127,127,127,0.15) 50%, var(--bg) 75%); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; border-radius: 4px; margin: 0.3rem 0; }
  .skeleton .bar.w70 { width: 70%; }
  .skeleton .bar.w90 { width: 90%; }
  @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
</style>
</head>
<body>
<h1>amzcard</h1>
<p class="lead">Amazon の商品 URL を OGP カード対応の URL に変換します。</p>
<input id="input" type="text" autofocus placeholder="https://www.amazon.co.jp/dp/ASIN... または ASIN を直接">
<div class="hint">短縮 URL (amzn.asia / amzn.to) は未対応。Amazon の商品ページ URL を貼ってください。</div>

<div id="result" class="result">
  <div class="url"><a id="link" href="" target="_blank" rel="noopener"></a></div>
  <button id="copy" type="button">コピー</button>
</div>

<div id="preview-label" class="preview-label" style="display:none">X でのカード表示プレビュー</div>

<div id="skeleton" class="card skeleton">
  <div class="img-wrap"></div>
  <div class="body">
    <div class="bar w70"></div>
    <div class="bar w90"></div>
    <div class="bar w70"></div>
  </div>
</div>

<div id="card" class="card">
  <a id="card-link" href="" target="_blank" rel="noopener">
    <div id="card-img-wrap" class="img-wrap"><img id="card-img" alt=""></div>
    <div class="body">
      <div class="domain">amazon.co.jp</div>
      <div id="card-title" class="title"></div>
      <div id="card-desc" class="desc"></div>
    </div>
  </a>
</div>

<script>
const input = document.getElementById('input');
const result = document.getElementById('result');
const link = document.getElementById('link');
const copy = document.getElementById('copy');
const previewLabel = document.getElementById('preview-label');
const skeleton = document.getElementById('skeleton');
const card = document.getElementById('card');
const cardLink = document.getElementById('card-link');
const cardImgWrap = document.getElementById('card-img-wrap');
const cardImg = document.getElementById('card-img');
const cardTitle = document.getElementById('card-title');
const cardDesc = document.getElementById('card-desc');

function extractAsin(s) {
  s = (s || '').trim();
  if (!s) return null;
  if (/^[A-Z0-9]{10}$/i.test(s)) return s.toUpperCase();
  const m = s.match(/\\/(?:dp|gp\\/product|gp\\/aw\\/d)\\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
}

let currentAsin = null;
let fetchToken = 0;
let debounceTimer = null;

function hidePreview() {
  previewLabel.style.display = 'none';
  card.classList.remove('show');
  skeleton.classList.remove('show');
}

function showSkeleton() {
  previewLabel.style.display = 'block';
  card.classList.remove('show');
  skeleton.classList.add('show');
}

function showCard(data) {
  cardLink.href = data.amazonUrl;
  cardTitle.textContent = data.title || '';
  cardDesc.textContent = data.description || '';
  if (data.image) {
    cardImg.src = data.image;
    cardImgWrap.classList.remove('empty');
    cardImg.style.display = '';
  } else {
    cardImg.removeAttribute('src');
    cardImg.style.display = 'none';
    cardImgWrap.classList.add('empty');
    cardImgWrap.textContent = '画像なし';
  }
  previewLabel.style.display = 'block';
  skeleton.classList.remove('show');
  card.classList.add('show');
}

async function loadPreview(asin) {
  const token = ++fetchToken;
  showSkeleton();
  try {
    const res = await fetch('/api/preview/' + asin);
    if (token !== fetchToken) return;
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    if (token !== fetchToken) return;
    showCard(data);
  } catch {
    if (token !== fetchToken) return;
    hidePreview();
  }
}

function update() {
  const asin = extractAsin(input.value);
  if (!asin) {
    currentAsin = null;
    hidePreview();
    if (input.value.trim()) {
      result.classList.add('show', 'error');
      link.textContent = 'ASIN を検出できませんでした';
      link.removeAttribute('href');
    } else {
      result.classList.remove('show', 'error');
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    return;
  }
  const out = location.origin + '/dp/' + asin;
  link.textContent = out;
  link.href = out;
  result.classList.add('show');
  result.classList.remove('error');

  if (asin !== currentAsin) {
    currentAsin = asin;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => loadPreview(asin), 350);
  }
}

input.addEventListener('input', update);

copy.addEventListener('click', async () => {
  if (!link.href) return;
  try {
    await navigator.clipboard.writeText(link.href);
    const orig = copy.textContent;
    copy.textContent = 'コピーしました';
    setTimeout(() => copy.textContent = orig, 1500);
  } catch (e) {
    // ignore
  }
});
</script>
</body>
</html>`;
}
