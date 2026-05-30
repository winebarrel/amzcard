export type OgpInput = {
  amazonUrl: string;
  title: string;
  image: string | null;
  isBook: boolean;
  description: string;
};

export function renderOgp(p: OgpInput): string {
  const t = htmlEscape(p.title);
  const d = htmlEscape(p.description);
  const url = htmlEscape(p.amazonUrl);
  const img = p.image ? htmlEscape(p.image) : "";
  const card = !img || p.isBook ? "summary" : "summary_large_image";

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
