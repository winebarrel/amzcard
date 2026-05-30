import indexHtml from "./index.html";
import { renderOgp } from "./render-ogp";

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
      return new Response(indexHtml, {
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
