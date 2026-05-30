import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import indexHtml from "./index.html";
import { renderOgp } from "./render-ogp";

const AMAZON_HOST = "www.amazon.co.jp";

interface Env {
  BROWSER: BrowserWorker;
  CACHE_VERSION: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const refresh = url.searchParams.get("refresh") === "1";

    const dp = url.pathname.match(/^\/dp\/([A-Z0-9]{10})\/?$/i);
    if (dp) {
      return ogpPage(dp[1].toUpperCase(), env, refresh);
    }

    const api = url.pathname.match(/^\/api\/preview\/([A-Z0-9]{10})\/?$/i);
    if (api) {
      return previewApi(api[1].toUpperCase(), env, refresh);
    }

    if (url.pathname === "/" || url.pathname === "") {
      const input = url.searchParams.get("url");
      if (input) {
        const asin = extractAsin(input);
        if (asin) {
          return Response.redirect(`${url.origin}/dp/${asin}`, 302);
        }
      }
      return new Response(indexHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function extractAsin(input: string): string | null {
  const trimmed = input.trim();
  if (/^[A-Z0-9]{10}$/i.test(trimmed)) return trimmed.toUpperCase();
  const m = trimmed.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
}

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
    await page.setExtraHTTPHeaders({ "Accept-Language": "ja,en;q=0.9" });
    await page.goto(amazonUrl, { waitUntil: "domcontentloaded" });

    const extracted = (await page.evaluate(`(() => {
      const text = (el) => (el?.textContent ?? "").trim();
      const productTitle = text(document.getElementById("productTitle"));
      const docTitle = (document.title || "").trim().replace(/\\s*\\|\\s*Amazon\\s*$/i, "");
      const landing = document.getElementById("landingImage");
      const oldHires = landing?.getAttribute("data-old-hires") ?? "";
      const imgSrc = landing?.getAttribute("src") ?? "";
      const metaDesc =
        document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "";
      const authors = Array.from(document.querySelectorAll("#bylineInfo .author a"))
        .map((a) => text(a))
        .filter(Boolean);
      return {
        title: productTitle || docTitle || "",
        imageSrc: imgSrc,
        imageOldHires: oldHires,
        description: metaDesc.slice(0, 200),
        authors,
      };
    })()`)) as {
      title: string;
      imageSrc: string;
      imageOldHires: string;
      description: string;
      authors: string[];
    };

    if (extracted.title) title = extracted.title;
    const rawImage = extracted.imageSrc || extracted.imageOldHires;
    if (rawImage) image = stripAmazonImageSize(rawImage);
    if (extracted.authors.length > 0) {
      isBook = true;
      description = `${extracted.authors.join(", ")} (著)`;
    } else if (extracted.description) {
      description = extracted.description;
    }
  } catch {
    // fall through with defaults
  } finally {
    if (browser) await browser.close();
  }
  return { asin, amazonUrl, title, image, isBook, description };
}

async function ogpPage(asin: string, env: Env, refresh: boolean): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(`https://amzcard.invalid/${env.CACHE_VERSION}/dp/${asin}`);
  if (!refresh) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const product = await fetchAmazonProduct(asin, env);
  const body = renderOgp(product);
  const response = new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": product.image ? "public, max-age=3600" : "no-store",
    },
  });
  if (product.image) {
    await cache.put(cacheKey, response.clone());
  }
  return response;
}

async function previewApi(asin: string, env: Env, refresh: boolean): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(`https://amzcard.invalid/${env.CACHE_VERSION}/api/preview/${asin}`);
  if (!refresh) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const product = await fetchAmazonProduct(asin, env);
  const response = new Response(JSON.stringify(product), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": product.image ? "public, max-age=3600" : "no-store",
    },
  });
  if (product.image) {
    await cache.put(cacheKey, response.clone());
  }
  return response;
}

function stripAmazonImageSize(url: string): string {
  return url.replace(/\._[A-Z0-9_+]+_\.(jpg|jpeg|png|gif|webp)$/i, ".$1");
}
