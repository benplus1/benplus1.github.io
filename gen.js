// gen.js: writes the generated parts of index.html and every papers/<id>.html from publications.json and news.json.
// Run by hand after editing either file or a citation in index.html:  node gen.js
// In index.html it rewrites only the regions between <!-- name:start --> and <!-- name:end --> (publications,
// news, updated) and the numbers in [<a class="cite" href="#p-<id>">n</a>]; everything else there is hand-written.
// The publications region lists every entry, so the page is complete without JavaScript. Each <li class="pub">
// carries data-selected (its selected flag, 1 or 0) and data-year, and a year label that is hidden unless the entry
// is the first of its year in its list; the Preprints heading and list carry data-selected too (1 if any preprint is
// selected). scripts.js uses these to open on the selected entries and to switch between them and all entries.
// Bad data stops it with a non-zero exit that names the entry, before any file is written.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const BASE = 'https://www.cs.columbia.edu/~benyang';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
// Set in small caps (<abbr>) in roman text only: never inside italics, URLs, DOIs, BibTeX or meta tags.
const ACRONYMS = ['ACM', 'AGU', 'AI', 'AR', 'BCI', 'CGUI', 'CHI', 'COMS', 'ECS', 'EGSC', 'EM', 'GCC', 'GUI', 'HCI',
  'HRI', 'ICRA', 'IEEE', 'IGARSS', 'ISMAR', 'MA', 'MI', 'TA', 'UI', 'UIST', 'VLM', 'VR', 'VRST', 'VRW', 'WA', 'WPM',
  'XR'];
const LINK_ORDER = [['pdf', 'PDF'], ['arxiv', 'arXiv'], ['doi', 'DOI'], ['video', 'Video'], ['code', 'Code'],
  ['project', 'Project']];
const NO_SMALL_CAPS = new Set(['i', 'em', 'cite', 'abbr', 'code', 'pre', 'script', 'style']);
const FADE_SCRIPT = '<script>if (matchMedia(\'(prefers-reduced-motion: no-preference)\').matches) '
  + 'document.documentElement.classList.add(\'fade-ready\');</script>';
// Applies the reader's stored Dark/Light choice before the first paint; index.html carries the same script.
const THEME_SCRIPT = '<script>(function () { try { var theme = localStorage.getItem(\'theme\'); '
  + 'if (theme === \'dark\' || theme === \'light\') document.documentElement.setAttribute(\'data-theme\', theme); } '
  + 'catch (err) { console.warn(\'The stored theme could not be read.\', err); } })();</script>';
const GOATCOUNTER = '<script data-goatcounter="https://theangrybuddhas.goatcounter.com/count" async '
  + 'src="//gc.zgo.at/count.js"></script>';

class DataError extends Error {}
const fail = (msg) => { throw new DataError(msg); };

const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel), 'utf8').replace(/\r\n/g, '\n');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const isMe = (name) => /^(ben|benjamin|b\.)\s+yang$/i.test(String(name).trim());
const isYearMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
const monthYear = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1].slice(0, 3)} ${ym.slice(0, 4)}`;

const ACRONYM_RUN = (() => {
  const alt = ACRONYMS.slice().sort((a, b) => b.length - a.length).join('|');
  return new RegExp(`\\b(?:${alt})(?: (?:${alt}))*\\b`, 'g');
})();

// Wraps acronym runs ("IEEE VR", "XR") in <abbr>, joined by no-break spaces, in the text of an HTML fragment,
// skipping italics and code.
function smallCaps(html, where) {
  let depth = 0;
  const out = String(html).split(/(<[^>]*>)/).map((part) => {
    if (part.startsWith('<')) {
      const tag = /^<(\/?)([a-z][a-z0-9]*)\b/i.exec(part);
      if (tag && NO_SMALL_CAPS.has(tag[2].toLowerCase())) depth += tag[1] ? -1 : 1;
      if (depth < 0) fail(`${where}: unbalanced closing tag ${part}`);
      return part;
    }
    return depth > 0 ? part : part.replace(ACRONYM_RUN, (run) => `<abbr>${run.replace(/ /g, '&nbsp;')}</abbr>`);
  }).join('');
  if (depth !== 0) fail(`${where}: an <i>, <em>, <abbr> or <code> element is not closed`);
  return out;
}

function parseBibtex(src, where) {
  const text = String(src || '').trim();
  const head = /^@(\w+)\s*\{\s*([^,\s]+)\s*,/.exec(text);
  if (!head) fail(`${where}: bibtex must start with @type{key,`);
  const fields = { type: head[1].toLowerCase() };
  const name = /\s*([A-Za-z]+)\s*=\s*\{/y;
  const comma = /\s*,/y;
  let i = head[0].length;
  for (;;) {
    name.lastIndex = i;
    const m = name.exec(text);
    if (!m) break;
    let depth = 1;
    let j = name.lastIndex;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      j += 1;
    }
    if (depth !== 0) fail(`${where}: bibtex field ${m[1]} has unbalanced braces`);
    fields[m[1].toLowerCase()] = text.slice(name.lastIndex, j - 1).replace(/\s+/g, ' ').trim();
    comma.lastIndex = j;
    i = comma.exec(text) ? comma.lastIndex : j;
  }
  if (!/^\s*\}$/.test(text.slice(i))) fail(`${where}: bibtex could not be read past character ${i}`);
  return fields;
}

// "2026 IEEE Conference on ... (VRW)" -> "IEEE Conference on ... (VRW)"; also drops "IGARSS 2023 - " and "Proceedings of the ".
function fullVenue(bib) {
  if (!bib.booktitle) return '';
  return bib.booktitle.replace(/^[A-Z]+ \d{4} - /, '').replace(/^Proceedings of the /, '').replace(/^\d{4} /, '');
}

function imageSize(file, label) {
  const b = fs.readFileSync(file);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) fail(`${label}: unreadable JPEG (no marker at byte ${o})`);
      const marker = b[o + 1];
      if (marker === 0xff) { o += 1; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { o += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: b.readUInt16BE(o + 5), w: b.readUInt16BE(o + 7) };
      }
      o += 2 + b.readUInt16BE(o + 2);
    }
  }
  return fail(`${label}: not a PNG or JPEG that gen.js can measure`);
}

function siteImage(rel, where) {
  if (!fs.existsSync(abs(rel))) fail(`${where}: image ${rel} does not exist`);
  return imageSize(abs(rel), rel);
}

// Every local <img> must exist and carry its real pixel size in width and height.
function checkImages(html, dir, where) {
  for (const tag of html.match(/<img\b[^>]*>/g) || []) {
    const src = (/\ssrc="([^"]+)"/.exec(tag) || [])[1];
    if (!src) fail(`${where}: <img> without src: ${tag}`);
    if (/^(https?:)?\/\//.test(src)) continue;
    const file = path.join(ROOT, dir, src);
    if (!fs.existsSync(file)) fail(`${where}: <img src="${src}"> does not exist`);
    const { w, h } = imageSize(file, src);
    const aw = Number((/\swidth="(\d+)"/.exec(tag) || [])[1]);
    const ah = Number((/\sheight="(\d+)"/.exec(tag) || [])[1]);
    if (aw !== w || ah !== h) fail(`${where}: <img src="${src}"> says ${aw}x${ah}, but the file is ${w}x${h}`);
  }
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  const last = parts.pop();
  const given = parts.map((g) => g.split('-').map((s) => (/^[A-Z]\.$/.test(s) ? s : `${s[0]}.`)).join('-'));
  return [...given, last].join(' ');
}
const joinNames = (names) => (names.length <= 2 ? names.join(' and ')
  : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`);
// Each name is kept on one line, so no line ends between initials and a surname.
const authorsHtml = (p) => p.authors.map((a) => `<span class="${isMe(a) ? 'me' : 'nobr'}">${esc(a)}</span>`).join(', ');

// Keeps each hyphenated compound ("Reality-Linked") on one line in a display title.
const keepCompounds = (html) => String(html).split(/(<[^>]*>)/)
  .map((part) => (part.startsWith('<') ? part
    : part.replace(/[A-Za-z0-9À-ÖØ-öø-ÿ]+(?:-[A-Za-z0-9À-ÖØ-öø-ÿ]+)+/g, (word) => `<span class="nobr">${word}</span>`)))
  .join('');

function durationWords(mss) {
  const [m, s] = mss.split(':').map(Number);
  return [m ? `${m} min` : '', s ? `${s} s` : ''].filter(Boolean).join(' ');
}

function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

function checkEntry(p, kind) {
  const where = `${kind} ${p.id || '(no id)'}`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.id || '')) fail(`${where}: id must be lower-case words joined by hyphens`);
  if (!p.title) fail(`${where}: title is empty`);
  if (!Array.isArray(p.authors) || !p.authors.length) fail(`${where}: authors are missing`);
  if (p.authors.filter(isMe).length !== 1) fail(`${where}: authors must name Ben Yang exactly once`);
  if (!isYearMonth(p.date)) fail(`${where}: date must be YYYY-MM`);
  if (Number(p.date.slice(0, 4)) !== p.year) fail(`${where}: year ${p.year} does not match date ${p.date}`);
  if (!p.venue) fail(`${where}: venue is empty`);
  if (!p.bibtex) fail(`${where}: bibtex is empty`);
  if (p.selected !== 0 && p.selected !== 1) fail(`${where}: selected must be the number 1 or 0`);
  const L = p.links || {};
  for (const key of Object.keys(L)) {
    if (!LINK_ORDER.some(([k]) => k === key)) fail(`${where}: unknown link "${key}"`);
    if (!/^https?:\/\//.test(L[key]) && !fs.existsSync(abs(L[key]))) fail(`${where}: links.${key} file ${L[key]} is missing`);
  }
  if (p.thumbnail && !p.teaserCaption) fail(`${where}: thumbnail is set but teaserCaption is empty`);
  if (p.thumbnail && !p.teaser) fail(`${where}: thumbnail is set but teaser is empty`);
  if (p.teaser && !p.teaserAlt) fail(`${where}: teaser is set but teaserAlt is empty`);
  if (p.videoDuration && !/^\d+:[0-5]\d$/.test(p.videoDuration)) fail(`${where}: videoDuration must look like 1:46`);
  if (p.videoPoster && !L.video) fail(`${where}: videoPoster is set but links.video is empty`);
  if (p.videoPoster && !(p.videoCaption && p.videoAlt)) fail(`${where}: videoPoster needs videoCaption and videoAlt`);
  if (L.video && !/^https:\/\/(youtu\.be|(www\.)?youtube\.com)\//.test(L.video)) {
    fail(`${where}: links.video is not a YouTube URL, but the captions say "opens on YouTube"`);
  }
  if (p.abstract && /https?:\/\/\S+\s*$/.test(p.abstract)) fail(`${where}: abstract ends with a URL; move it to links`);
}

function homeVenue(p, venueFull) {
  const lead = /^((?:IEEE|ACM) [A-Z]+|[A-Z]{2,})(?=\s|$)/.exec(p.venue);
  let html = lead && venueFull
    ? `<abbr title="${esc(venueFull)}">${esc(lead[1]).replace(/ /g, '&nbsp;')}</abbr>${smallCaps(esc(p.venue.slice(lead[1].length)), p.id)}`
    : smallCaps(esc(p.venue), p.id);
  if (p.venueDetail) html += `, ${esc(p.venueDetail)}`;
  if (p.award) html += `. <i>${esc(p.award)}.</i>`;
  return html;
}

function linkItems(p, onPage) {
  const L = p.links || {};
  const items = [];
  for (const [key, label] of LINK_ORDER) {
    const url = L[key];
    if (!url) continue;
    let href = url;
    let text = label;
    if (!/^https?:\/\//.test(url)) {
      href = (onPage ? '../' : '') + url;
      if (key === 'pdf' && onPage) text += ` (${Math.round(fs.statSync(abs(url)).size / 1024)} KB)`;
    }
    if (key === 'video') {
      if (p.videoDuration) text += ` (${p.videoDuration})`;
      if (onPage) href = '#video';
    }
    items.push(`<li><a href="${esc(href)}">${text}</a></li>`);
  }
  items.push(`<li><a href="${onPage ? '#cite' : `papers/${p.id}.html#cite`}">BibTeX</a></li>`);
  return items.join('');
}

function pubItem(p, showYear) {
  const out = [`<li class="pub" id="p-${p.id}" data-selected="${p.selected}" data-year="${p.year}">`,
    `<span class="pub-year"${showYear ? '' : ' hidden'}>${p.year}</span>`];
  out.push('<div class="pub-body">',
    `<p class="pub-title"><span class="pub-num">[${p.num}]</span><a href="papers/${p.id}.html">${keepCompounds(smallCaps(esc(p.title), p.id))}</a></p>`,
    `<p class="pub-meta pub-authors">${authorsHtml(p)}</p>`,
    `<p class="pub-meta">${homeVenue(p, p.venueFull)}</p>`,
    `<ul class="pub-meta links dots">${linkItems(p, false)}</ul>`,
    '</div>');
  if (p.thumbnail) {
    const { w, h } = siteImage(p.thumbnail, p.id);
    const pos = p.thumbPosition ? ` style="object-position: ${esc(p.thumbPosition)}"` : '';
    out.push(`<a class="pub-thumb" href="papers/${p.id}.html" aria-hidden="true" tabindex="-1">`
      + `<img class="fade" src="${esc(p.thumbnail)}" alt="" width="${w}" height="${h}" loading="lazy" decoding="async"${pos}></a>`);
  }
  out.push('</li>');
  return out.join('\n');
}

// Newest first. Every entry has a year label, shown only on the first entry of each year; in the Selected view
// scripts.js moves it to the first entry on view. attrs adds attributes to the <ol>.
function pubList(list, attrs = '') {
  let year = null;
  const items = list.slice().sort((a, b) => a.num - b.num).map((p) => {
    const item = pubItem(p, p.year !== year);
    year = p.year;
    return item;
  });
  return `<ol class="pubs"${attrs}>\n${items.join('\n')}\n</ol>`;
}

function underReviewList(data) {
  const showTitles = data.showDoubleBlindTitles === true;
  const rows = data.underReview.map((u, i) => {
    const where = `underReview item ${i + 1} (${u.venue})`;
    if (!u.venue) fail(`${where}: venue is empty`);
    if (!isYearMonth(u.submitted)) fail(`${where}: submitted must be YYYY-MM`);
    if (typeof u.anonymized !== 'boolean') fail(`${where}: anonymized must be true or false`);
    if (u.decisionExpected && !/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(u.decisionExpected)) {
      fail(`${where}: decisionExpected must be YYYY-MM-DD`);
    }
    const venue = smallCaps(esc(u.venue), where);
    const decision = u.decisionExpected
      ? `; decision expected ${MONTHS[Number(u.decisionExpected.slice(5, 7)) - 1]} ${u.decisionExpected.slice(0, 4)}` : '';
    // A titled entry shows its title and venue only; the author role appears only while the title is withheld.
    let text;
    if (u.title && (!u.anonymized || showTitles)) text = `<i>${esc(u.title)}.</i> ${venue}${decision}.`;
    else if (u.anonymized) {
      const role = u.authorRole ? `${esc(u.authorRole.replace(/ /g, '-'))} paper` : 'Paper';
      text = `${role} under review at ${venue} (double-blind)${decision}.`;
    } else fail(`${where}: a single-blind entry needs its title`);
    return { submitted: u.submitted, html: `<li><time datetime="${u.submitted}">${monthYear(u.submitted)}</time><span>${text}</span></li>` };
  });
  rows.sort((a, b) => b.submitted.localeCompare(a.submitted));
  return `<ol class="dated">\n${rows.map((r) => r.html).join('\n')}\n</ol>`;
}

function newsRegion(news) {
  if (!Array.isArray(news) || !news.length) fail('news.json: news must be a non-empty list');
  const rows = news.map((n, i) => {
    const where = `news.json item ${i + 1} (${n.date})`;
    if (!isYearMonth(n.date)) fail(`${where}: date must be YYYY-MM`);
    if (!n.html) fail(`${where}: html is empty`);
    if (/<\s*(strong|b)\b/i.test(n.html)) fail(`${where}: no <strong> or <b> in news; italics are for titles only`);
    return { date: n.date, html: `<li><time datetime="${n.date}">${monthYear(n.date)}</time><span>${smallCaps(n.html, where)}</span></li>` };
  }).sort((a, b) => b.date.localeCompare(a.date)).map((r) => r.html);
  // Every item, newest first, in one list inside a box that shows about five and scrolls (.news-scroll in styles.css).
  // tabindex lets a keyboard scroll the box; print shows the whole list.
  return `<div class="news-scroll" tabindex="0" role="region" aria-label="News">\n<ol class="dated">\n${rows.join('\n')}\n</ol>\n</div>`;
}

function fillRegion(html, name, content, inline) {
  const re = new RegExp(`<!-- ${name}:start -->[\\s\\S]*?<!-- ${name}:end -->`);
  if (!re.test(html)) fail(`index.html: the <!-- ${name}:start --> and <!-- ${name}:end --> markers are missing`);
  const body = inline ? content : `\n${content}\n`;
  return html.replace(re, () => `<!-- ${name}:start -->${body}<!-- ${name}:end -->`);
}

function fillCitations(html, byId) {
  return html.replace(/(<a class="cite" href="#p-)([^"]+)(">)[^<]*(<\/a>)/g, (m, open, id, mid, close) => {
    const p = byId.get(id);
    if (!p) fail(`index.html: a citation points to #p-${id}, which is not a publication id`);
    return `${open}${id}${mid}${p.num}${close}`;
  });
}

function ieeeReference(p) {
  const bib = p.bib;
  let where;
  if (p.venueFull) where = `in <i>Proc. ${esc(p.venueFull)}</i>, ${p.year}`;
  else if (bib.eprint) where = `arXiv preprint arXiv:${esc(bib.eprint)}, ${p.year}`;
  else fail(`${p.id}: bibtex has neither booktitle nor eprint, so the reference has no venue`);
  const pages = bib.pages ? `, pp. ${esc(bib.pages.replace(/-+/, '–'))}` : '';
  const status = p.venueDetail === 'to appear' ? ', to appear' : '';
  const doi = bib.doi ? `, doi: ${esc(bib.doi)}` : '';
  const names = p.authors.map((a) => `<span class="nobr">${esc(initials(a))}</span>`);
  return `${joinNames(names)}, “${smallCaps(esc(p.title), p.id)},” ${where}${pages}${status}${doi}.`;
}

function paperPage(p, updated) {
  const L = p.links || {};
  const url = `${BASE}/papers/${p.id}.html`;
  const ogRel = p.teaser ? `images/og/${p.id}.jpg` : 'images/og-image.png';
  const og = siteImage(ogRel, `${p.id} (link-preview image, 1200x630 from the teaser)`);
  const doi = L.doi ? L.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, '') : '';
  const arxiv = L.arxiv ? (/(\d{4}\.\d{4,5})/.exec(L.arxiv) || [])[1] : '';
  const venueText = p.venueFull || p.venue;
  const description = p.abstract ? clip(p.abstract, 200) : `${p.title}. ${venueText}, ${p.year}.`;

  const meta = [`<meta name="citation_title" content="${esc(p.title)}">`];
  p.authors.forEach((a) => meta.push(`<meta name="citation_author" content="${esc(a)}">`));
  meta.push(`<meta name="citation_publication_date" content="${p.year}">`);
  if (p.venueFull) meta.push(`<meta name="citation_conference_title" content="${esc(p.venueFull)}">`);
  if (p.bib.pages) {
    const [first, last] = p.bib.pages.split(/-+/);
    meta.push(`<meta name="citation_firstpage" content="${esc(first)}">`);
    if (last) meta.push(`<meta name="citation_lastpage" content="${esc(last)}">`);
  }
  if (doi) meta.push(`<meta name="citation_doi" content="${esc(doi)}">`);
  if (arxiv) meta.push(`<meta name="citation_arxiv_id" content="${arxiv}">`);
  if (L.pdf) meta.push(`<meta name="citation_pdf_url" content="${esc(/^https?:/.test(L.pdf) ? L.pdf : `${BASE}/${L.pdf}`)}">`);

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'ScholarlyArticle',
    headline: p.title,
    name: p.title,
    author: p.authors.map((a) => ({ '@type': 'Person', name: a })),
    datePublished: p.date,
    isPartOf: venueText,
    url,
    image: `${BASE}/${ogRel}`,
  };
  if (doi) ld.sameAs = `https://doi.org/${doi}`;

  const body = [
    `<h1 class="paper-title">${keepCompounds(smallCaps(esc(p.title), p.id))}</h1>`,
    `<p class="paper-authors">${authorsHtml(p)}</p>`,
  ];
  const detail = p.venueDetail ? ` ${esc(p.venueDetail[0].toUpperCase() + p.venueDetail.slice(1))}.` : '';
  body.push(`<p class="paper-venue">${smallCaps(esc(venueText), p.id)}, ${p.year}.${detail}</p>`);
  if (p.award) body.push(`<p class="paper-venue"><i>${esc(p.award)}.</i></p>`);
  body.push(`<ul class="links dots">${linkItems(p, true)}</ul>`);
  if (p.teaser) {
    const t = siteImage(p.teaser, p.id);
    body.push('<figure class="fig">',
      `<img class="fade" src="../${esc(p.teaser)}" width="${t.w}" height="${t.h}" alt="${esc(p.teaserAlt)}">`,
      `<figcaption><span class="fig-label">Fig. 1.</span> ${smallCaps(esc(p.teaserCaption), p.id)}</figcaption>`,
      '</figure>');
  }
  if (p.abstract) body.push('<h2>Abstract</h2>', `<p>${smallCaps(esc(p.abstract), p.id)}</p>`);
  if (L.video) {
    const length = p.videoDuration ? durationWords(p.videoDuration) : '';
    body.push('<h2 id="video">Video</h2>');
    if (p.videoPoster) {
      const v = siteImage(p.videoPoster, p.id);
      body.push('<figure class="fig">',
        `<a href="${esc(L.video)}"><img class="fade" src="../${esc(p.videoPoster)}" width="${v.w}" height="${v.h}" alt="${esc(p.videoAlt)} Opens on YouTube." loading="lazy" decoding="async"></a>`,
        `<figcaption><span class="fig-label">Video 1.</span> ${smallCaps(esc(p.videoCaption), p.id)}. ${length ? `${length}; ` : ''}opens on YouTube.</figcaption>`,
        '</figure>');
    } else {
      body.push(`<p>The video is on <a href="${esc(L.video)}">YouTube</a>${length ? ` (${length})` : ''}.</p>`);
    }
  }
  body.push('<h2 id="cite">Cite</h2>',
    `<p class="ref">${ieeeReference(p)}</p>`,
    `<pre id="bibtex">${esc(p.bibtex)}</pre>`,
    '<button class="copy" type="button" data-copy="bibtex" hidden>Copy BibTeX</button>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141414" media="(prefers-color-scheme: dark)">
<title>${esc(p.title)} — Ben Yang</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
${meta.join('\n')}
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${BASE}/${ogRel}">
<meta property="og:image:width" content="${og.w}">
<meta property="og:image:height" content="${og.h}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${BASE}/${ogRel}">
<link rel="icon" href="../favicon.ico" sizes="32x32">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="preload" href="../fonts/ibarra-real-nova-roman.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="../fonts/source-sans-3-roman.woff2" as="font" type="font/woff2" crossorigin>
${THEME_SCRIPT}
<link rel="stylesheet" href="../styles.css">
${FADE_SCRIPT}
<script type="application/ld+json">
${JSON.stringify(ld, null, 2).replace(/</g, '\\u003c')}
</script>
${GOATCOUNTER}
</head>
<body>
<div class="page">
<header class="runhead"><p><a href="../">Ben Yang</a></p></header>
<main class="paper">
${body.join('\n')}
</main>
<footer class="colophon">
<p>Set in Ibarra Real Nova and Source Sans 3. Updated ${updated}.<span class="print-url"> ${url}</span></p>
</footer>
</div>
<script src="../scripts.js" onerror="document.documentElement.classList.remove('fade-ready')"></script>
</body>
</html>
`;
}

function main() {
  const data = JSON.parse(read('publications.json'));
  const news = JSON.parse(read('news.json')).news;
  const papers = (data.publications || []).map((p) => ({ ...p }));
  const preprints = (data.preprints || []).map((p) => ({ ...p }));
  papers.forEach((p) => checkEntry(p, 'publication'));
  preprints.forEach((p) => checkEntry(p, 'preprint'));
  const byId = new Map();
  for (const p of [...papers, ...preprints]) {
    if (byId.has(p.id)) fail(`publications.json: the id ${p.id} is used twice`);
    p.bib = parseBibtex(p.bibtex, p.id);
    p.venueFull = fullVenue(p.bib);
    byId.set(p.id, p);
  }
  // Numbers follow the display order: the newest paper is [1], and preprints continue the count after the papers.
  // Adding a paper renumbers the list; the in-text citations are regenerated from the ids.
  const newestFirst = (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id);
  papers.sort(newestFirst).forEach((p, i) => { p.num = i + 1; });
  preprints.sort(newestFirst).forEach((p, i) => { p.num = papers.length + i + 1; });

  const now = new Date();
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const updated = `<time datetime="${iso}">${now.getDate()}&nbsp;${MONTHS[now.getMonth()]}&nbsp;${now.getFullYear()}</time>`;

  const pubParts = [pubList(papers)];
  if (preprints.length) {
    const selectedAttr = ` data-selected="${preprints.some((p) => p.selected === 1) ? 1 : 0}"`;
    pubParts.push(`<h3${selectedAttr}>Preprints</h3>`, pubList(preprints, selectedAttr));
  }
  if ((data.underReview || []).length) pubParts.push('<h3>Under Review</h3>', underReviewList(data));

  let home = read('index.html');
  home = fillRegion(home, 'publications', pubParts.join('\n'));
  home = fillRegion(home, 'news', newsRegion(news));
  home = fillRegion(home, 'updated', updated, true);
  home = fillCitations(home, byId);
  checkImages(home, '', 'index.html');

  const pages = [...papers, ...preprints].map((p) => {
    const html = paperPage(p, updated);
    checkImages(html, 'papers', `papers/${p.id}.html`);
    return [`papers/${p.id}.html`, html];
  });

  fs.writeFileSync(abs('index.html'), home);
  fs.mkdirSync(abs('papers'), { recursive: true });
  for (const [rel, html] of pages) fs.writeFileSync(abs(rel), html);
  const stale = fs.readdirSync(abs('papers')).filter((f) => f.endsWith('.html') && !byId.has(f.slice(0, -5)));
  for (const f of stale) console.warn(`gen.js: papers/${f} has no entry in publications.json; delete it if the paper was removed`);
  console.log(`gen.js: wrote index.html (${papers.length} papers, ${preprints.length} preprint${preprints.length === 1 ? '' : 's'}, ${news.length} news items) and ${pages.length} paper pages`);
}

try {
  main();
} catch (err) {
  if (!(err instanceof DataError)) throw err;
  console.error(`gen.js: ${err.message}`);
  process.exitCode = 1;
}
