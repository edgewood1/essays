/**
 * Essays — core app
 *
 * Architecture: four clean modules wired together at the bottom.
 *   Store   — single source of truth, immutable-style updates
 *   API     — all data fetching; returns plain objects, no DOM
 *   Router  — hash-based routing; push/pop history
 *   UI      — renders state to DOM; never fetches data directly
 *
 * Adding features: extend Store.state, add API methods, wire new
 * routes, and write UI renderers. Nothing here is load-bearing in a
 * way that prevents new entry points (e.g. a workflow script that
 * calls API.loadEssays() and processes the result).
 */

/* ─── Marked config ─────────────────────────────────────────────────────────── */
marked.use({
  gfm: true,
  breaks: false,
  mangle: false,
  headerIds: false,
  renderer: {
    // Attach data-caption so the placeholder handler can label broken images
    image(href, title, text) {
      const cap = title || text || '';
      return `<img src="${href}" alt="${text || ''}" data-caption="${cap}">`;
    },
  },
});

/* ═══════════════════════════════════════════════════════════════════════════════
   STORE
   ─── Single source of truth. All state lives here.
═══════════════════════════════════════════════════════════════════════════════ */
const Store = (() => {
  const _state = {
    essays: [],          // Array<Essay>  — populated on first menu open
    essaysLoaded: false,
    current: null,       // Essay | null  — essay being read
    page: 0,             // Number        — current section index (0-based)
  };

  // Essay shape:
  // { file: string, title: string, raw: string, sections: Section[] | null }
  // Section shape:
  // { title: string, content: string }

  return {
    get: () => ({ ..._state }),
    set: (patch) => Object.assign(_state, patch),
    getEssay: (slug) => _state.essays.find(e => slugOf(e.file) === slug) || null,
  };
})();

/* ═══════════════════════════════════════════════════════════════════════════════
   API
   ─── Pure async functions. Return data, throw on error.
       Safe to call from external scripts / workflows.
═══════════════════════════════════════════════════════════════════════════════ */
const API = (() => {

  const cache = new Map(); // file → raw markdown string

  async function fetchText(url) {
    if (cache.has(url)) return cache.get(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    const text = await res.text();
    cache.set(url, text);
    return text;
  }

  async function loadIndex() {
    const text = await fetchText('essays/index.json');
    return JSON.parse(text); // string[]
  }

  async function loadEssay(file) {
    return fetchText(`essays/${file}`);
  }

  /**
   * Load all essays listed in index.json.
   * Each essay gets its H1 extracted as `title`.
   * Heavy content (sections) is parsed lazily on first read.
   */
  async function loadEssays() {
    const files = await loadIndex();
    const essays = await Promise.all(files.map(async (file) => {
      const raw = await loadEssay(file);
      const title = extractH1(raw) || stripExt(file);
      return { file, title, raw, sections: null };
    }));
    return essays;
  }

  return { loadEssays, loadEssay };
})();

/* ═══════════════════════════════════════════════════════════════════════════════
   PARSER
   ─── Markdown → sections. Pure functions, no side effects.
═══════════════════════════════════════════════════════════════════════════════ */
const Parser = (() => {

  // Matches a lone markdown image on its own line (with optional whitespace)
  const LONE_IMAGE_RE = /^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/;

  /**
   * Split raw markdown into sections on ## headings.
   * Returns Array<Section>
   *
   * Section shape:
   *   { title: string, content: string, imageOnly: bool, imageSrc: string, imageAlt: string }
   *
   * imageOnly sections contain a single image and are rendered full-bleed.
   *
   * Convention:
   *   # Essay Title          ← H1, essay title
   *   intro paragraphs       ← becomes section with no title
   *   ## Section Name        ← titled section/page
   *   body text...
   *   ## Photo Caption       ← section containing only ![...](images/x.jpg) → full-page image
   */
  function splitSections(raw) {
    const chunks = raw.split(/^(?=##\s)/m);
    const sections = [];

    chunks.forEach(chunk => {
      const h2 = chunk.match(/^##\s+(.+?)(?:\r?\n|$)/);
      if (h2) {
        const title   = h2[1].trim();
        const content = chunk.slice(h2[0].length).trim();
        sections.push(makeSection(title, content));
      } else {
        // Intro chunk — strip H1 line
        const content = chunk.replace(/^#\s+.+?(?:\r?\n|$)/, '').trim();
        if (content) sections.push(makeSection('', content));
      }
    });

    if (sections.length === 0) {
      const content = raw.replace(/^#\s+.+?(?:\r?\n|$)/, '').trim();
      sections.push(makeSection('', content));
    }

    return sections;
  }

  /**
   * Build a section object. Detects image-only sections automatically.
   * A section is image-only when its entire content is a single image tag.
   */
  function makeSection(title, content) {
    const imgMatch = content.match(LONE_IMAGE_RE);
    if (imgMatch) {
      return {
        title,
        content,
        imageOnly: true,
        imageAlt: imgMatch[1],
        imageSrc: imgMatch[2],
      };
    }
    return { title, content, imageOnly: false, imageAlt: '', imageSrc: '' };
  }

  function renderSection(content) {
    return marked.parse(content);
  }

  /**
   * Render an image-only section as a single <img> (or placeholder if missing).
   * The caller is responsible for attaching the onerror placeholder handler.
   */
  function renderImageSection(section) {
    return `<img src="${esc(section.imageSrc)}" alt="${esc(section.imageAlt)}" data-caption="${esc(section.imageAlt)}">`;
  }

  return { splitSections, makeSection, renderSection, renderImageSection };
})();

/* ═══════════════════════════════════════════════════════════════════════════════
   ROUTER
   ─── Hash-based routing. Format: #<slug>[/<page>]
       Dispatches to UI.showLanding() or UI.showEssay().
═══════════════════════════════════════════════════════════════════════════════ */
const Router = (() => {

  function push(path) {
    history.pushState(null, '', path);
  }

  function replace(path) {
    history.replaceState(null, '', path);
  }

  function essayPath(file, page = 0) {
    const slug = slugOf(file);
    return `#${slug}${page > 0 ? `/${page + 1}` : ''}`;
  }

  function parse(hash) {
    if (!hash) return { view: 'landing' };
    const parts = hash.replace(/^#/, '').split('/');
    const slug = parts[0];
    const page = parts[1] ? parseInt(parts[1], 10) - 1 : 0;
    return { view: 'essay', slug, page: Math.max(0, page) };
  }

  async function dispatch() {
    const route = parse(window.location.hash);

    if (route.view === 'landing') {
      UI.showLanding();
      return;
    }

    // Ensure essays are loaded
    if (!Store.get().essaysLoaded) {
      await ensureEssaysLoaded();
    }

    const essay = Store.getEssay(route.slug);
    if (!essay) {
      UI.showLanding();
      return;
    }

    openEssay(essay, route.page);
  }

  return { push, replace, essayPath, parse, dispatch };
})();

/* ═══════════════════════════════════════════════════════════════════════════════
   UI
   ─── All DOM manipulation lives here. Reads from Store; calls Router.push.
═══════════════════════════════════════════════════════════════════════════════ */
const UI = (() => {

  /* ── DOM refs ── */
  const dom = {
    menuBtn:       document.getElementById('menuBtn'),
    menuOverlay:   document.getElementById('menuOverlay'),
    menuClose:     document.getElementById('menuClose'),
    menuBackdrop:  document.getElementById('menuBackdrop'),
    essayTiles:    document.getElementById('essayTiles'),
    tilesStatus:   document.getElementById('tilesStatus'),
    navHome:       document.getElementById('navHome'),
    viewLanding:   document.getElementById('viewLanding'),
    viewEssay:     document.getElementById('viewEssay'),
    latestEssay:   document.getElementById('latestEssay'),
    essayMeta:     document.getElementById('essayMeta'),
    essayTitle:    document.getElementById('essayTitle'),
    sectionLabel:  document.getElementById('sectionLabel'),
    essayHeader:   document.getElementById('viewEssay').querySelector('.essay-header'),
    essayBody:     document.getElementById('essayBody'),
    pagination:    document.getElementById('pagination'),
    scrollProgress: document.getElementById('scrollProgress'),
    prevBtn:       document.getElementById('prevBtn'),
    nextBtn:       document.getElementById('nextBtn'),
    pageIndicator: document.getElementById('pageIndicator'),
  };

  /* ── Views ── */

  function showLanding() {
    dom.viewLanding.hidden = false;
    dom.viewEssay.hidden   = true;
    dom.navHome.textContent = 'Essays';
    Store.set({ current: null, page: 0 });

    // Show latest essay teaser if essays are loaded
    const { essays } = Store.get();
    if (essays.length > 0) renderLatest(essays[0]);
  }

  function renderLatest(essay) {
    dom.latestEssay.hidden = false;
    dom.latestEssay.innerHTML = `
      <p class="latest-label">Latest</p>
      <p class="latest-title" tabindex="0" role="button" data-file="${esc(essay.file)}">${esc(essay.title)}</p>
    `;
    dom.latestEssay.querySelector('.latest-title').addEventListener('click', () => {
      openEssay(essay, 0);
    });
  }

  function showEssay() {
    dom.viewLanding.hidden = true;
    dom.viewEssay.hidden   = false;
    dom.viewEssay.classList.remove('view-enter');
    void dom.viewEssay.offsetWidth; // reflow to restart animation
    dom.viewEssay.classList.add('view-enter');
    dom.navHome.textContent = '← Essays';
  }

  /* ── Essay rendering ── */

  function renderEssayPage() {
    const { current, page } = Store.get();
    if (!current) return;

    const sections = current.sections;
    const section  = sections[page];
    const total    = sections.length;

    // Header
    dom.essayTitle.textContent   = current.title;
    dom.sectionLabel.textContent = section.title || '';
    dom.essayHeader.classList.toggle('intro', !section.title);

    // Full-page image vs prose
    if (section.imageOnly) {
      dom.viewEssay.classList.add('image-page');
      dom.essayBody.innerHTML = Parser.renderImageSection(section);
      const img = dom.essayBody.querySelector('img');
      if (img) {
        img.addEventListener('error', () => showImgPlaceholder(img), { once: true });
        img.addEventListener('click', () => openLightbox(img.src, img.alt));
      }
    } else {
      dom.viewEssay.classList.remove('image-page');
      dom.essayBody.innerHTML = Parser.renderSection(section.content);
      dom.essayBody.querySelectorAll('img').forEach(img => {
        img.addEventListener('error', () => showImgPlaceholder(img), { once: true });
        img.addEventListener('click', () => openLightbox(img.src, img.alt));
        img.style.cursor = 'zoom-in';
      });
    }

    // Pagination
    if (total > 1) {
      dom.pagination.hidden         = false;
      dom.pageIndicator.textContent = `${page + 1} / ${total}`;
      dom.prevBtn.disabled          = page === 0;
      dom.nextBtn.disabled          = page === total - 1;
    } else {
      dom.pagination.hidden = true;
    }

    window.scrollTo({ top: 0, behavior: 'instant' });
    updateScrollProgress(0); // reset on page turn
  }

  function updateScrollProgress(pct) {
    dom.scrollProgress.style.width = `${pct}%`;
  }

  /**
   * Replace a broken <img> with a styled placeholder box.
   * Preserves the alt text as the label so the author can see what goes there.
   */
  function showImgPlaceholder(img) {
    const caption = img.dataset.caption || img.alt || 'Image pending';
    const ph = document.createElement('div');
    ph.className = 'img-placeholder';
    ph.innerHTML = `
      <span class="img-placeholder-icon">&#9634;</span>
      <span class="img-placeholder-label">${esc(caption)}</span>
    `;
    img.replaceWith(ph);
  }

  /* ── Menu ── */

  function openMenu() {
    dom.menuOverlay.setAttribute('aria-hidden', 'false');
    dom.menuBtn.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }

  function closeMenu() {
    dom.menuOverlay.setAttribute('aria-hidden', 'true');
    dom.menuBtn.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  function renderTiles(essays) {
    if (essays.length === 0) {
      dom.essayTiles.innerHTML = '<p class="tiles-loading">No essays found.</p>';
      return;
    }

    dom.essayTiles.innerHTML = '';
    essays.forEach(essay => {
      const sectionCount = (essay.raw.match(/^##\s/gm) || []).length;
      const meta = sectionCount > 0
        ? `${sectionCount} section${sectionCount !== 1 ? 's' : ''}`
        : '';

      const tile = document.createElement('div');
      tile.className  = 'tile';
      tile.role       = 'listitem';
      tile.tabIndex   = 0;
      tile.innerHTML  = `
        <div class="tile-title">${esc(essay.title)}</div>
        ${meta ? `<div class="tile-meta">${esc(meta)}</div>` : ''}
      `;
      tile.addEventListener('click', () => {
        closeMenu();
        openEssay(essay, 0);
      });
      tile.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') tile.click();
      });
      dom.essayTiles.appendChild(tile);
    });
  }

  /* ── Expose DOM for event wiring ── */
  return {
    updateScrollProgress,
    dom,
    showLanding,
    showEssay,
    renderEssayPage,
    openMenu,
    closeMenu,
    renderTiles,
  };
})();

/* ═══════════════════════════════════════════════════════════════════════════════
   CONTROLLER
   ─── Wires API, Store, Router, UI together. Handles events.
═══════════════════════════════════════════════════════════════════════════════ */

const { dom } = UI;

/* ── Essay loading ── */

async function ensureEssaysLoaded() {
  if (Store.get().essaysLoaded) return;
  try {
    const essays = await API.loadEssays();
    Store.set({ essays, essaysLoaded: true });
  } catch (err) {
    console.error('Failed to load essays:', err);
    Store.set({ essays: [], essaysLoaded: true });
  }
}

function openEssay(essay, pageIndex = 0) {
  // Parse sections lazily
  if (!essay.sections) {
    essay.sections = Parser.splitSections(essay.raw);
  }

  const safePage = Math.min(pageIndex, essay.sections.length - 1);
  Store.set({ current: essay, page: safePage });

  UI.showEssay();
  UI.renderEssayPage();

  // Update URL
  Router.push(Router.essayPath(essay.file, safePage));
}

function changePage(delta) {
  const { current, page } = Store.get();
  if (!current) return;
  const next = page + delta;
  if (next < 0 || next >= current.sections.length) return;
  Store.set({ page: next });
  UI.renderEssayPage();
  Router.replace(Router.essayPath(current.file, next));
}

/* ── Menu events ── */

dom.menuBtn.addEventListener('click', async () => {
  UI.openMenu();
  if (!Store.get().essaysLoaded) {
    dom.tilesStatus.textContent = 'Loading\u2026';
    dom.essayTiles.innerHTML = '';
    dom.essayTiles.appendChild(dom.tilesStatus);
    await ensureEssaysLoaded();
  }
  UI.renderTiles(Store.get().essays);
});

dom.menuClose.addEventListener('click', UI.closeMenu);
dom.menuBackdrop.addEventListener('click', UI.closeMenu);

/* ── Nav home ── */

dom.navHome.addEventListener('click', (e) => {
  e.preventDefault();
  if (Store.get().current) {
    Router.push(window.location.pathname);
    UI.showLanding();
  }
});

/* ── Pagination events ── */

dom.prevBtn.addEventListener('click', () => changePage(-1));
dom.nextBtn.addEventListener('click', () => changePage(1));

/* ── Keyboard navigation ── */

document.addEventListener('keydown', (e) => {
  if (document.activeElement.closest('.menu-overlay')) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') changePage(1);
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   changePage(-1);
});

/* ── Swipe (mobile) ── */

let touchStartX = 0;
let touchStartY = 0;

dom.viewEssay.addEventListener('touchstart', (e) => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });

dom.viewEssay.addEventListener('touchend', (e) => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  // Only trigger if horizontal swipe dominates
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    changePage(dx < 0 ? 1 : -1);
  }
}, { passive: true });

/* ── Scroll progress ── */

window.addEventListener('scroll', () => {
  if (!Store.get().current) return;
  const scrolled = window.scrollY;
  const total    = document.documentElement.scrollHeight - window.innerHeight;
  const pct      = total > 0 ? Math.min((scrolled / total) * 100, 100) : 100;
  UI.updateScrollProgress(pct);
}, { passive: true });

/* ── Browser back/forward ── */

window.addEventListener('popstate', () => Router.dispatch());

/* ─── Init ─────────────────────────────────────────────────────────────────── */

(async () => {
  // Eagerly load essay list so landing teaser is available
  await ensureEssaysLoaded();
  Router.dispatch();
})();

/* ═══════════════════════════════════════════════════════════════════════════════
   LIGHTBOX
   ─── Full-screen image overlay. Native pinch-zoom works freely inside it.
       Header and footer are covered by the overlay, unaffected by any zoom.
═══════════════════════════════════════════════════════════════════════════════ */

function openLightbox(src, alt) {
  const box = document.createElement('div');
  box.className = 'img-lightbox';
  box.innerHTML = `
    <button class="img-lightbox-close" aria-label="Close">close</button>
    <img src="${esc(src)}" alt="${esc(alt || '')}">
  `;

  const close = () => box.remove();
  box.addEventListener('click', e => { if (e.target === box) close(); });
  box.querySelector('.img-lightbox-close').addEventListener('click', close);

  // Keyboard close
  const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  document.body.appendChild(box);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════════════════════════ */

function slugOf(file) {
  return file.replace(/\.md$/i, '');
}

function stripExt(file) {
  return file.replace(/\.[^.]+$/, '');
}

function extractH1(raw) {
  const m = raw.match(/^#\s+(.+?)(?:\r?\n|$)/m);
  return m ? m[1].trim() : null;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ─── Public surface for workflow scripts ──────────────────────────────────── */
window.EssaysApp = { Store, API, Parser, Router, UI, openEssay, ensureEssaysLoaded };
