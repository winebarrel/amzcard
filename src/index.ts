import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import indexHtml from "./index.html";
import { renderOgp } from "./render-ogp";

const AMAZON_HOST = "www.amazon.co.jp";

interface Env {
  BROWSER: BrowserWorker;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    const dp = url.pathname.match(/^\/dp\/([A-Z0-9]{10})\/?$/i);
    if (dp) {
      return ogpPage(dp[1].toUpperCase(), env);
    }

    const api = url.pathname.match(/^\/api\/preview\/([A-Z0-9]{10})\/?$/i);
    if (api) {
      return previewApi(api[1].toUpperCase(), env);
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(indexHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

type Product = {
  asin: string;
  amazonUrl: string;
  title: string;
  image: string | null;
  isBook: boolean;
  description: string;
};

async function fetchAmazonProduct(asin: string, env: Env): Promise<Product> {
  const amazonUrl = `https://${AMAZON_HOST}/dp/${asin}`;
  let title = `Amazon: ${asin}`;
  let image: string | null = null;
  let isBook = false;
  let description = "";

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.goto(amazonUrl, { waitUntil: "domcontentloaded" });
    const html = await page.content();
    const parsed = await parseAmazonHtml(new Response(html));
    if (parsed.title) title = parsed.title;
    if (parsed.image) image = parsed.image;
    if (parsed.authors && parsed.authors.length > 0) {
      isBook = true;
      description = `${parsed.authors.join(", ")} (著)`;
    } else if (parsed.description) {
      description = parsed.description;
    }
  } catch {
    // fall through with defaults
  } finally {
    if (browser) await browser.close();
  }
  return { asin, amazonUrl, title, image, isBook, description };
}

async function ogpPage(asin: string, env: Env): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(`https://amzcard.invalid/dp/${asin}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const product = await fetchAmazonProduct(asin, env);
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

async function previewApi(asin: string, env: Env): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(`https://amzcard.invalid/api/preview/${asin}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const product = await fetchAmazonProduct(asin, env);
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
