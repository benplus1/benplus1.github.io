'use strict';

const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ME = ['ben yang', 'benjamin yang'];
const TROPHY = '<svg viewBox="0 0 576 512" aria-hidden="true" focusable="false"><path d="M552 64H448V24c0-13.255-10.745-24-24-24H152c-13.255 0-24 10.745-24 24v40H24C10.745 64 0 74.745 0 88v56c0 35.64 22.529 71.674 61.81 98.873 31.717 21.972 70.259 35.607 110.502 39.844 8.747 20.514 20.281 38.815 33.612 53.621 25.453 28.27 53.762 44.184 76.076 53.766V424H192c-22.091 0-40 17.909-40 40v24c0 6.627 5.373 12 12 12h248c6.627 0 12-5.373 12-12v-24c0-22.091-17.909-40-40-40h-96.476v-93.896c22.314-9.582 50.623-25.496 76.076-53.766 13.331-14.806 24.865-33.107 33.612-53.621 40.243-4.237 78.785-17.872 110.502-39.844C553.471 215.674 576 179.64 576 144V88c0-13.255-10.745-24-24-24zM99.788 184.846C76.106 168.444 64 152.351 64 144v-16h64.595c1.612 28.53 6.297 54.95 13.354 78.62-15.769-5.387-30.298-12.819-42.161-21.774zM512 144c0 8.351-12.106 24.444-35.788 40.846-11.863 8.955-26.392 16.387-42.161 21.774 7.057-23.67 11.742-50.09 13.354-78.62H512v16z"/></svg>';

let allPublications = [];
let activeTag = 'All';
let showingSelected = true;

document.addEventListener('DOMContentLoaded', () => {
  loadNews();
  loadPublications();
  initThemeToggle();
  initScrollSpy();
  initScrollProgress();
  initBackToTop();
  initModal();
  revealObserve(document.querySelectorAll('.reveal'));
});

/* ---------- data ---------- */
function fetchJSON(path) {
  return fetch(path).then((r) => {
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  });
}

/* ---------- news ---------- */
function loadNews() {
  const list = document.getElementById('news-list');
  if (!list) return;
  fetchJSON('news.json')
    .then((data) => {
      list.innerHTML = '';
      (data.news || []).forEach((n) => {
        const li = document.createElement('li');
        const date = document.createElement('span');
        date.className = 'news-date';
        date.textContent = n.date;
        const body = document.createElement('span');
        body.className = 'news-body';
        body.innerHTML = n.html;
        li.append(date, body);
        list.appendChild(li);
      });
    })
    .catch((err) => { console.error(err); list.innerHTML = '<li>Could not load news.</li>'; });
}

/* ---------- publications ---------- */
function loadPublications() {
  const container = document.getElementById('publications-container');
  fetchJSON('publications.json')
    .then((data) => {
      allPublications = data.publications || [];
      buildFilters();
      renderPublications();
      const toggle = document.getElementById('toggle-publications');
      if (toggle) {
        toggle.addEventListener('click', () => {
          showingSelected = !showingSelected;
          toggle.textContent = showingSelected ? 'Show all' : 'Show selected';
          toggle.setAttribute('aria-expanded', String(!showingSelected));
          document.getElementById('pub-heading').textContent = showingSelected ? 'Selected Publications' : 'Publications';
          renderPublications();
        });
      }
    })
    .catch((err) => { console.error(err); container.innerHTML = 'Could not load publications. See my <a href="https://scholar.google.com/citations?user=wyIkKdgAAAAJ">Google Scholar</a>.'; });
}

function buildFilters() {
  const bar = document.getElementById('pub-filters');
  if (!bar) return;
  const tags = ['All'];
  allPublications.forEach((p) => (p.tags || []).forEach((t) => { if (!tags.includes(t)) tags.push(t); }));
  bar.innerHTML = '';
  tags.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (t === activeTag ? ' active' : '');
    b.textContent = t;
    b.setAttribute('aria-pressed', String(t === activeTag));
    b.addEventListener('click', () => {
      activeTag = t;
      bar.querySelectorAll('.chip').forEach((c) => {
        const on = c.textContent === t;
        c.classList.toggle('active', on);
        c.setAttribute('aria-pressed', String(on));
      });
      renderPublications();
    });
    bar.appendChild(b);
  });
}

function renderPublications() {
  const container = document.getElementById('publications-container');
  container.innerHTML = '';
  const list = allPublications
    .filter((p) => (showingSelected ? p.selected === 1 : true))
    .filter((p) => (activeTag === 'All' ? true : (p.tags || []).includes(activeTag)));

  if (!list.length) {
    container.innerHTML = '<p>No publications match this filter.</p>';
    return;
  }
  list.forEach((pub, i) => {
    const card = createCard(pub);
    if (!prefersReduced) card.style.transitionDelay = Math.min(i, 5) * 55 + 'ms';
    container.appendChild(card);
  });
  revealObserve(container.querySelectorAll('.reveal'));
}

function createCard(pub) {
  const card = document.createElement('article');
  card.className = 'pub-card reveal';
  const L = pub.links || {};
  const vid = L.video ? ytId(L.video) : null;

  // thumbnail: image (or YouTube poster); a video shows a play badge and opens in-page
  const thumb = document.createElement('div');
  thumb.className = 'pub-thumb';
  const thumbSrc = pub.thumbnail || (vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '');
  if (thumbSrc) {
    const img = document.createElement('img');
    img.src = thumbSrc;
    img.alt = pub.title + ' — figure';
    img.loading = 'lazy';
    img.decoding = 'async';
    thumb.appendChild(img);
    if (vid) {
      const play = document.createElement('span');
      play.className = 'play-badge';
      play.setAttribute('aria-hidden', 'true');
      play.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
      thumb.appendChild(play);
      wireThumb(thumb, 'Play demo video: ' + pub.title, () => openVideo(vid, pub.title));
    } else {
      wireThumb(thumb, 'Enlarge figure: ' + pub.title, () => openImage(thumbSrc, pub.title));
    }
  } else {
    thumb.classList.add('placeholder');
    thumb.textContent = pub.venue;
  }

  // content
  const content = document.createElement('div');

  const title = document.createElement('div');
  title.className = 'pub-title';
  title.textContent = pub.title;

  const authors = document.createElement('div');
  authors.className = 'pub-authors';
  authors.innerHTML = (pub.authors || [])
    .map((a) => (ME.includes(a.toLowerCase()) ? `<span class="me">${a}</span>` : a))
    .join(', ');

  const meta = document.createElement('div');
  meta.className = 'pub-meta';
  meta.appendChild(tag(pub.venue));
  if (pub.venueDetail) meta.appendChild(tag(pub.venueDetail, 'type'));
  if (pub.award) {
    const aw = tag('', 'award');
    aw.innerHTML = TROPHY;
    const label = document.createElement('span');
    label.textContent = pub.award;
    aw.appendChild(label);
    meta.appendChild(aw);
  }

  content.append(title, authors, meta);

  // links
  const links = document.createElement('div');
  links.className = 'pub-links';
  if (pub.id) {
    const d = document.createElement('a');
    d.href = 'papers/' + pub.id + '.html';
    d.textContent = 'Details';
    links.appendChild(d);
  }
  const order = [['pdf', 'PDF'], ['doi', 'DOI'], ['arxiv', 'arXiv'], ['video', 'Video'], ['code', 'Code'], ['project', 'Project']];
  order.forEach(([key, label]) => {
    if (L[key]) {
      const a = document.createElement('a');
      a.href = L[key];
      a.textContent = label;
      if (/^https?:/.test(L[key])) { a.target = '_blank'; a.rel = 'noopener'; }
      links.appendChild(a);
    }
  });
  if (pub.bibtex) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bib-btn';
    b.textContent = 'Cite';
    b.addEventListener('click', () => openCite(pub));
    links.appendChild(b);
  }
  if (links.children.length) content.appendChild(links);

  card.append(thumb, content);
  return card;
}

function tag(text, extra) {
  const s = document.createElement('span');
  s.className = 'pub-tag' + (extra ? ' ' + extra : '');
  s.textContent = text;
  return s;
}

function wireThumb(el, label, action) {
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', label);
  el.addEventListener('click', action);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action(); } });
}
function ytId(url) { const m = String(url).match(/(?:youtu\.be\/|[?&]v=|embed\/)([\w-]{11})/); return m ? m[1] : null; }
function fmtPlain(p) {
  const a = (p.authors || []).join(', ');
  const doi = (p.links && p.links.doi) ? ' ' + p.links.doi : '';
  return `${a}. "${p.title}." ${p.venue}${p.venueDetail ? ' (' + p.venueDetail + ')' : ''}, ${p.year}.${doi}`;
}
function risName(n) { const parts = String(n).trim().split(/\s+/); if (parts.length < 2) return n; const last = parts.pop(); return last + ', ' + parts.join(' '); }
function fmtRIS(p) {
  const lines = ['TY  - CPAPER'];
  (p.authors || []).forEach((a) => lines.push('AU  - ' + risName(a)));
  lines.push('TI  - ' + p.title);
  if (p.year) lines.push('PY  - ' + p.year);
  if (p.venue) lines.push('T2  - ' + p.venue);
  const doiUrl = p.links && p.links.doi;
  if (doiUrl) { lines.push('DO  - ' + doiUrl.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')); lines.push('UR  - ' + doiUrl); }
  lines.push('ER  - ');
  return lines.join('\n');
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { console.error(e); }
  document.body.removeChild(ta);
}

/* ---------- reveal on scroll ---------- */
let revealIO = null;
function revealObserve(nodes) {
  if (!nodes || !nodes.length) return;
  if (prefersReduced || !('IntersectionObserver' in window)) {
    nodes.forEach((n) => n.classList.add('in'));
    return;
  }
  if (!revealIO) {
    revealIO = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); revealIO.unobserve(e.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
  }
  nodes.forEach((n) => revealIO.observe(n));
}

/* ---------- scroll spy ---------- */
function initScrollSpy() {
  const links = Array.from(document.querySelectorAll('.nav-links a'));
  const map = {};
  links.forEach((l) => { const id = l.getAttribute('href').slice(1); const s = document.getElementById(id); if (s) map[id] = l; });
  const sections = Object.keys(map).map((id) => document.getElementById(id));
  if (!sections.length || !('IntersectionObserver' in window)) return;
  const spy = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        links.forEach((l) => { l.classList.remove('active'); l.removeAttribute('aria-current'); });
        const l = map[e.target.id];
        if (l) { l.classList.add('active'); l.setAttribute('aria-current', 'true'); }
      }
    });
  }, { rootMargin: '-45% 0px -45% 0px' });
  sections.forEach((s) => spy.observe(s));
}

/* ---------- reading progress ---------- */
function initScrollProgress() {
  const bar = document.getElementById('scroll-progress');
  if (!bar) return;
  let ticking = false;
  const update = () => {
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    bar.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + '%';
    ticking = false;
  };
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  update();
}

/* ---------- back to top ---------- */
function initBackToTop() {
  const btn = document.getElementById('back-to-top');
  if (!btn) return;
  btn.hidden = false;
  const onScroll = () => btn.classList.toggle('show', window.scrollY > 600);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  btn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: prefersReduced ? 'auto' : 'smooth' });
    const main = document.getElementById('main');
    if (main) main.focus({ preventScroll: true });
  });
}

/* ---------- theme toggle ---------- */
const ICON_MOON = '<svg class="ic" viewBox="0 0 512 512" aria-hidden="true" focusable="false"><path d="M283.211 512c78.962 0 151.079-35.925 198.857-94.792 7.068-8.708-.639-21.43-11.562-19.35-124.203 23.654-238.262-71.576-238.262-196.954 0-72.222 38.662-138.635 101.498-174.394 9.686-5.512 7.25-20.197-3.756-22.23A258.156 258.156 0 0 0 283.211 0c-141.309 0-256 114.511-256 256 0 141.309 114.511 256 256 256z"/></svg>';
const ICON_SUN = '<svg class="ic" viewBox="0 0 512 512" aria-hidden="true" focusable="false"><path d="M256 160c-52.9 0-96 43.1-96 96s43.1 96 96 96 96-43.1 96-96-43.1-96-96-96zm246.4 80.5l-94.7-47.3 33.5-100.4c4.5-13.6-8.4-26.5-21.9-21.9l-100.4 33.5-47.4-94.8c-6.4-12.8-24.6-12.8-31 0l-47.3 94.7L92.7 70.8c-13.6-4.5-26.5 8.4-21.9 21.9l33.5 100.4-94.7 47.4c-12.8 6.4-12.8 24.6 0 31l94.7 47.3-33.5 100.5c-4.5 13.6 8.4 26.5 21.9 21.9l100.4-33.5 47.3 94.7c6.4 12.8 24.6 12.8 31 0l47.3-94.7 100.4 33.5c13.6 4.5 26.5-8.4 21.9-21.9l-33.5-100.4 94.7-47.3c13-6.5 13-24.7.2-31.1zm-155.9 106c-49.9 49.9-131.1 49.9-181 0-49.9-49.9-49.9-131.1 0-181 49.9-49.9 131.1-49.9 181 0 49.9 49.9 49.9 131.1 0 181z"/></svg>';
function initThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const sync = () => {
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    btn.setAttribute('aria-pressed', String(dark));
    btn.innerHTML = dark ? ICON_SUN : ICON_MOON;
  };
  sync();
  btn.addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    const next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
    sync();
  });
}

/* ---------- accessible media / cite modal ---------- */
let lastFocused = null;
function initModal() {
  const modal = document.getElementById('mediaModal');
  if (!modal) return;
  modal.querySelector('.modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });
}
function openModalWith(node, label) {
  const modal = document.getElementById('mediaModal');
  const body = document.getElementById('modalBody');
  if (!modal || !body) return;
  lastFocused = document.activeElement;
  body.innerHTML = '';
  body.appendChild(node);
  if (label) modal.setAttribute('aria-label', label);
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('show'));
  modal.querySelector('.modal-close').focus();
}
function openImage(src, alt) {
  const img = document.createElement('img');
  img.className = 'modal-content';
  img.src = src;
  img.alt = alt || '';
  openModalWith(img, 'Figure: ' + (alt || ''));
}
function openVideo(id, title) {
  const wrap = document.createElement('div');
  wrap.className = 'video-wrap';
  const f = document.createElement('iframe');
  f.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
  f.title = 'Demo video: ' + (title || '');
  f.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
  wrap.appendChild(f);
  openModalWith(wrap, 'Demo video: ' + (title || ''));
}
function openCite(pub) {
  const formats = { BibTeX: pub.bibtex || '', Plain: fmtPlain(pub), RIS: fmtRIS(pub) };
  const box = document.createElement('div');
  box.className = 'cite-box';
  const tabs = document.createElement('div');
  tabs.className = 'cite-tabs';
  tabs.setAttribute('role', 'tablist');
  const pre = document.createElement('pre');
  pre.className = 'cite-pre';
  pre.tabIndex = 0;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'bib-btn cite-copy';
  copy.textContent = 'Copy';
  let current = 'BibTeX';
  const show = (k) => {
    current = k;
    pre.textContent = formats[k];
    tabs.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.k === k;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
  };
  Object.keys(formats).forEach((k) => {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'cite-tab';
    t.dataset.k = k;
    t.textContent = k;
    t.setAttribute('role', 'tab');
    t.addEventListener('click', () => show(k));
    tabs.appendChild(t);
  });
  copy.addEventListener('click', () => {
    const done = () => { copy.classList.add('copied'); copy.textContent = 'Copied!'; setTimeout(() => { copy.classList.remove('copied'); copy.textContent = 'Copy'; }, 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(formats[current]).then(done).catch(() => fallbackCopy(formats[current], done));
    else fallbackCopy(formats[current], done);
  });
  const head = document.createElement('div');
  head.className = 'cite-head';
  head.append(tabs, copy);
  box.append(head, pre);
  show('BibTeX');
  openModalWith(box, 'Cite: ' + pub.title);
}
function closeModal() {
  const modal = document.getElementById('mediaModal');
  const body = document.getElementById('modalBody');
  modal.classList.remove('show');
  const finish = () => { modal.hidden = true; if (body) body.innerHTML = ''; if (lastFocused) lastFocused.focus(); };
  if (prefersReduced) finish(); else setTimeout(finish, 220);
}
