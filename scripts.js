'use strict';

const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ME = ['ben yang', 'benjamin yang'];

let allPublications = [];
let activeTag = 'All';

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

  // thumbnail
  const thumb = document.createElement('div');
  thumb.className = 'pub-thumb';
  if (pub.thumbnail) {
    const img = document.createElement('img');
    img.src = pub.thumbnail;
    img.alt = pub.title + ' — figure';
    img.loading = 'lazy';
    img.decoding = 'async';
    thumb.appendChild(img);
    thumb.setAttribute('role', 'button');
    thumb.setAttribute('tabindex', '0');
    thumb.setAttribute('aria-label', 'Enlarge figure: ' + pub.title);
    const open = () => openModal(pub.thumbnail, pub.title);
    thumb.addEventListener('click', open);
    thumb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
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
  if (pub.award) meta.appendChild(tag('★ ' + pub.award, 'award'));

  content.append(title, authors, meta);

  // links
  const links = document.createElement('div');
  links.className = 'pub-links';
  const L = pub.links || {};
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
    b.textContent = 'BibTeX';
    b.addEventListener('click', () => copyBibtex(b, pub.bibtex));
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

function copyBibtex(btn, text) {
  const done = () => { btn.classList.add('copied'); btn.textContent = 'Copied!'; setTimeout(() => { btn.classList.remove('copied'); btn.textContent = 'BibTeX'; }, 1600); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  else fallbackCopy(text, done);
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
function initThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const icon = btn.querySelector('i');
  const sync = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
      || (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    btn.setAttribute('aria-pressed', String(dark));
    if (icon) icon.className = dark ? 'fas fa-sun' : 'fas fa-moon';
  };
  sync();
  btn.addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
      || (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
    sync();
  });
}

/* ---------- accessible modal ---------- */
let lastFocused = null;
function initModal() {
  const modal = document.getElementById('imageModal');
  if (!modal) return;
  modal.querySelector('.modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });
}
function openModal(src, alt) {
  const modal = document.getElementById('imageModal');
  const img = document.getElementById('modalImage');
  lastFocused = document.activeElement;
  img.src = src; img.alt = alt || '';
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('show'));
  modal.querySelector('.modal-close').focus();
}
function closeModal() {
  const modal = document.getElementById('imageModal');
  modal.classList.remove('show');
  const finish = () => { modal.hidden = true; if (lastFocused) lastFocused.focus(); };
  if (prefersReduced) finish(); else setTimeout(finish, 220);
}
