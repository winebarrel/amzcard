import indexHtml from "./index.html";
import { renderOgp } from "./render-ogp";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
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

    const debug = url.pathname.match(/^\/debug\/([A-Z0-9]{10})\/?$/i);
    if (debug) {
      return debugProbe(debug[1].toUpperCase());
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
  isBook: boolean;
  description: string;
};

async function debugProbe(asin: string): Promise<Response> {
  const amazonUrl = `https://${AMAZON_HOST}/dp/${asin}`;
  const headers = {
    "User-Agent": BROWSER_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
  };
  const probe = async (redirect: "manual" | "follow") => {
    const started = Date.now();
    try {
      const res = await fetch(amazonUrl, { headers, redirect });
      const text = await res.text();
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      return {
        mode: redirect,
        ok: res.ok,
        status: res.status,
        finalUrl: res.url,
        redirected: res.redirected,
        contentLength: text.length,
        headers: respHeaders,
        bodySnippet: text.slice(0, 400),
        elapsedMs: Date.now() - started,
      };
    } catch (e) {
      return {
        mode: redirect,
        error: String(e),
        elapsedMs: Date.now() - started,
      };
    }
  };
  const [manual, follow] = await Promise.all([probe("manual"), probe("follow")]);
  return new Response(JSON.stringify({ asin, amazonUrl, manual, follow }, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function fetchAmazonProduct(asin: string): Promise<Product> {
  const amazonUrl = `https://${AMAZON_HOST}/dp/${asin}`;
  let title = `Amazon: ${asin}`;
  let image: string | null = null;
  let isBook = false;
  let description = "";
  try {
    const res = await fetch(amazonUrl, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
    });
    if (res.ok) {
      const parsed = await parseAmazonHtml(res);
      if (parsed.title) title = parsed.title;
      if (parsed.image) image = parsed.image;
      if (parsed.authors && parsed.authors.length > 0) {
        isBook = true;
        description = `${parsed.authors.join(", ")} (著)`;
      } else if (parsed.description) {
        description = parsed.description;
      }
    }
  } catch {
    // fall through with defaults
  }
  return { asin, amazonUrl, title, image, isBook, description };
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
  if (product.image) {
    await cache.put(cacheKey, response.clone());
  }
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
  if (product.image) {
    await cache.put(cacheKey, response.clone());
  }
  return response;
}

type Parsed = {
  title?: string;
  image?: string;
  description?: string;
  authors?: string[];
};

async function parseAmazonHtml(res: Response): Promise<Parsed> {
  const titleTag = new TextCollector();
  const productTitle = new TextCollector();
  const authors = new AuthorCollector();
  const meta: { description?: string } = {};
  let landingImage: string | undefined;

  const rewriter = new HTMLRewriter()
    .on("title", titleTag)
    .on("#productTitle", productTitle)
    .on("#bylineInfo .author a", authors)
    .on('meta[name="description"]', {
      element(el) {
        const c = el.getAttribute("content");
        if (c) meta.description = c;
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

  if (landingImage) {
    out.image = stripAmazonImageSize(landingImage);
  }

  if (meta.description) {
    out.description = meta.description.slice(0, 200);
  }

  if (authors.list.length > 0) {
    out.authors = authors.list;
  }

  return out;
}

function stripAmazonImageSize(url: string): string {
  return url.replace(/\._[A-Z0-9_+]+_\.(jpg|jpeg|png|gif|webp)$/i, ".$1");
}

class TextCollector {
  out = "";
  text(chunk: Text) {
    this.out += chunk.text;
  }
}

class AuthorCollector {
  private buf = "";
  list: string[] = [];
  element(el: Element) {
    this.buf = "";
    el.onEndTag(() => {
      const name = this.buf.trim();
      if (name) this.list.push(name);
      this.buf = "";
    });
  }
  text(chunk: Text) {
    this.buf += chunk.text;
  }
}
