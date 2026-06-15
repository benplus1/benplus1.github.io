// gen.js — generate per-paper landing pages from publications.json.
// Run by hand whenever publications.json changes:  node gen.js
// Emits papers/<id>.html (committed as static files; no build step at serve time).
const fs = require('fs');

const BASE = 'https://www.cs.columbia.edu/~benyang';
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const isMe = (a) => /ben yang|benjamin yang/.test(String(a).toLowerCase());

const PREPAINT = `<script>(function(){try{var s=localStorage.getItem('theme');document.documentElement.setAttribute('data-theme',s==='light'?'light':'dark');}catch(e){}})();</script>`;
const TROPHY = '<svg viewBox="0 0 576 512" aria-hidden="true" focusable="false"><path d="M552 64H448V24c0-13.255-10.745-24-24-24H152c-13.255 0-24 10.745-24 24v40H24C10.745 64 0 74.745 0 88v56c0 35.64 22.529 71.674 61.81 98.873 31.717 21.972 70.259 35.607 110.502 39.844 8.747 20.514 20.281 38.815 33.612 53.621 25.453 28.27 53.762 44.184 76.076 53.766V424H192c-22.091 0-40 17.909-40 40v24c0 6.627 5.373 12 12 12h248c6.627 0 12-5.373 12-12v-24c0-22.091-17.909-40-40-40h-96.476v-93.896c22.314-9.582 50.623-25.496 76.076-53.766 13.331-14.806 24.865-33.107 33.612-53.621 40.243-4.237 78.785-17.872 110.502-39.844C553.471 215.674 576 179.64 576 144V88c0-13.255-10.745-24-24-24zM99.788 184.846C76.106 168.444 64 152.351 64 144v-16h64.595c1.612 28.53 6.297 54.95 13.354 78.62-15.769-5.387-30.298-12.819-42.161-21.774zM512 144c0 8.351-12.106 24.444-35.788 40.846-11.863 8.955-26.392 16.387-42.161 21.774 7.057-23.67 11.742-50.09 13.354-78.62H512v16z"/></svg>';

const ORDER = [['pdf', 'PDF'], ['doi', 'DOI'], ['arxiv', 'arXiv'], ['video', 'Video'], ['code', 'Code'], ['project', 'Project']];

const data = JSON.parse(fs.readFileSync('publications.json', 'utf8'));
fs.mkdirSync('papers', { recursive: true });

for (const p of data.publications) {
  const url = `${BASE}/papers/${p.id}.html`;
  const img = p.thumbnail ? `${BASE}/${p.thumbnail}` : `${BASE}/images/og-image.png`;
  const L = p.links || {};
  const doi = L.doi ? L.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, '') : '';
  const arxiv = L.arxiv ? (L.arxiv.match(/(\d{4}\.\d{4,5})/) || [])[1] : '';

  // Google Scholar (Highwire) citation_* meta
  const cm = [`<meta name="citation_title" content="${esc(p.title)}">`];
  (p.authors || []).forEach((a) => cm.push(`<meta name="citation_author" content="${esc(a)}">`));
  if (p.year) cm.push(`<meta name="citation_publication_date" content="${p.year}">`);
  if (p.venue) cm.push(`<meta name="citation_conference_title" content="${esc(p.venue)}">`);
  if (doi) cm.push(`<meta name="citation_doi" content="${esc(doi)}">`);
  if (arxiv) cm.push(`<meta name="citation_arxiv_id" content="${arxiv}">`);
  if (L.pdf) {
    const pdf = /^https?:/.test(L.pdf) ? L.pdf : `${BASE}/${L.pdf}`;
    cm.push(`<meta name="citation_pdf_url" content="${esc(pdf)}">`);
  }

  const ld = {
    '@context': 'https://schema.org', '@type': 'ScholarlyArticle',
    headline: p.title, name: p.title,
    author: (p.authors || []).map((a) => ({ '@type': 'Person', name: a })),
    datePublished: String(p.year || ''), isPartOf: p.venue, url, image: img,
  };
  if (doi) ld.sameAs = `https://doi.org/${doi}`;

  const authorsHtml = (p.authors || []).map((a) => isMe(a) ? `<strong>${esc(a)}</strong>` : esc(a)).join(', ');
  const venueLine = esc(p.venue) + (p.venueDetail ? ' &middot; ' + esc(p.venueDetail) : '') + ' &middot; ' + (p.year || '');
  const awardHtml = p.award ? `<p class="paper-award">${TROPHY}<span>${esc(p.award)}</span></p>` : '';
  const linksHtml = ORDER.filter(([k]) => L[k]).map(([k, label]) => {
    const href = (k === 'pdf' && !/^https?:/.test(L[k])) ? '../' + L[k] : L[k];
    const ext = /^https?:/.test(L[k]) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${esc(href)}"${ext}>${label}</a>`;
  }).join('');
  const figHtml = p.thumbnail ? `<div class="paper-figure"><img src="../${esc(p.thumbnail)}" alt="${esc(p.title)} — figure" loading="lazy"></div>` : '';
  const absHtml = p.abstract ? `<h2>Abstract</h2><p>${esc(p.abstract)}</p>` : '';
  const bibHtml = p.bibtex ? `<details class="paper-bib"><summary>BibTeX</summary><pre>${esc(p.bibtex)}</pre></details>` : '';
  const ogDesc = p.abstract ? p.abstract.slice(0, 180) : `${p.venue} ${p.year} · Ben Yang, Columbia University`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(p.title)} — Ben Yang</title>
    <meta name="description" content="${esc(ogDesc)}">
    <link rel="canonical" href="${url}">
    ${cm.join('\n    ')}
    <meta property="og:title" content="${esc(p.title)}">
    <meta property="og:description" content="${esc(ogDesc)}">
    <meta property="og:type" content="article">
    <meta property="og:url" content="${url}">
    <meta property="og:image" content="${img}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:image" content="${img}">
    <meta name="theme-color" content="#0e0f12">
    <link rel="icon" href="../favicon.svg" type="image/svg+xml">
    ${PREPAINT}
    <link rel="preload" href="../fonts/inter-v20-latin-regular.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="preload" href="../fonts/merriweather-v33-latin-regular.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="../styles.css">
    <script type="application/ld+json">
    ${JSON.stringify(ld, null, 2)}
    </script>
    <script data-goatcounter="https://theangrybuddhas.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>
</head>
<body id="top">
    <a class="skip-link" href="#main">Skip to content</a>
    <nav id="site-nav" aria-label="Sections">
        <div class="nav-inner">
            <a class="nav-brand" href="../index.html#publications">&larr; All publications</a>
        </div>
    </nav>
    <main id="main" class="paper-page" tabindex="-1">
        <p class="eyebrow">${venueLine}</p>
        <h1 class="paper-title">${esc(p.title)}</h1>
        <p class="paper-authors">${authorsHtml}</p>
        ${awardHtml}
        <div class="pub-links paper-linkrow">${linksHtml}</div>
        ${figHtml}
        ${absHtml}
        ${bibHtml}
    </main>
    <footer>
        <p><a href="../index.html">Ben Yang</a> &middot; CS PhD Candidate, Columbia University</p>
    </footer>
</body>
</html>
`;
  fs.writeFileSync(`papers/${p.id}.html`, html);
  console.log('wrote papers/' + p.id + '.html');
}
console.log('done: ' + data.publications.length + ' pages');
