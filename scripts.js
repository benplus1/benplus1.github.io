'use strict';

// Figures and thumbnails that start below the first viewport fade in once, after they decode.
// The inline head script adds html.fade-ready only when the reader has not asked for reduced motion.
(function fadeImages() {
  var root = document.documentElement;
  if (!root.classList.contains('fade-ready')) return;
  try {
    var images = Array.prototype.slice.call(document.querySelectorAll('img.fade'));
    var show = function (img) { img.classList.add('shown'); };
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var img = entry.target;
        observer.unobserve(img);
        img.decode().then(function () { show(img); }, function (err) {
          console.error('Image failed to decode: ' + img.currentSrc, err);
          show(img);
        });
      });
    }, { threshold: 0.15 });
    images.forEach(function (img) {
      var box = img.getBoundingClientRect();
      if (box.top < window.innerHeight && box.bottom > 0) show(img);
      else observer.observe(img);
    });
  } catch (err) {
    console.error('Image fade disabled after an error; showing every image.', err);
    root.classList.remove('fade-ready');
  }
})();

// Paper pages: "Copy BibTeX" copies the <pre> it names. It stays hidden where the clipboard is unavailable.
(function copyButtons() {
  Array.prototype.forEach.call(document.querySelectorAll('button[data-copy]'), function (button) {
    var source = document.getElementById(button.getAttribute('data-copy'));
    if (!source) {
      console.error('Copy button target #' + button.getAttribute('data-copy') + ' is missing.');
      return;
    }
    if (!navigator.clipboard || !window.isSecureContext) return;
    var label = button.textContent;
    var timer = null;
    button.hidden = false;
    button.addEventListener('click', function () {
      navigator.clipboard.writeText(source.textContent).then(function () {
        button.textContent = 'Copied';
        clearTimeout(timer);
        timer = setTimeout(function () { button.textContent = label; }, 2000);
      }, function (err) {
        console.error('Copying the BibTeX failed.', err);
      });
    });
  });
})();

// Home page: the last entry of the contents list switches between the light and dark palettes. It names the
// palette it switches to, writes data-theme on <html> and remembers the choice; the inline head script on every
// page applies a remembered choice before the first paint. Without JavaScript the entry stays hidden and the
// palette follows the system setting.
(function themeToggle() {
  var button = document.querySelector('button[data-theme-toggle]');
  if (!button) return;
  var root = document.documentElement;
  var systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  var current = function () {
    var chosen = root.getAttribute('data-theme');
    if (chosen === 'dark' || chosen === 'light') return chosen;
    return systemDark.matches ? 'dark' : 'light';
  };
  var label = function () {
    var next = current() === 'dark' ? 'Light' : 'Dark';
    button.textContent = next;
    button.setAttribute('aria-label', next + ' theme');
  };
  button.addEventListener('click', function () {
    var next = current() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch (err) {
      console.warn('The theme choice could not be stored, so it lasts only until this page is closed.', err);
    }
    label();
  });
  systemDark.addEventListener('change', label);
  label();
  button.parentElement.hidden = false;
})();

// Home page: Publications opens on the entries marked selected in publications.json, and the button by its heading
// switches between them and all entries, renaming the heading and moving each year label to the first entry on view.
// The state is html.pubs-selected, which the inline head script sets before the first paint so the full list never
// flashes; the choice is not remembered. Print shows every entry, so the heading and labels follow it while printing.
// Without JavaScript, or if this fails, every entry shows under the static heading and the button stays hidden.
(function pubSwitch() {
  var root = document.documentElement;
  var button = document.querySelector('button[data-pub-toggle]');
  if (!button && !root.classList.contains('pubs-selected')) return;
  try {
    if (!button) throw new Error('html.pubs-selected is set, but the page has no button[data-pub-toggle].');
    var heading = document.getElementById('publications-heading');
    var section = document.getElementById(button.getAttribute('aria-controls'));
    if (!heading || !section) throw new Error('#publications-heading or the section the button controls is missing.');
    // One array per <ol class="pubs">, read and checked before anything on the page changes.
    var lists = Array.prototype.map.call(section.querySelectorAll('ol.pubs'), function (list) {
      return Array.prototype.map.call(list.querySelectorAll('li.pub'), function (item) {
        var entry = {
          label: item.querySelector('.pub-year'),
          year: item.getAttribute('data-year'),
          selected: item.getAttribute('data-selected')
        };
        if (!entry.label || !entry.year || (entry.selected !== '0' && entry.selected !== '1')) {
          throw new Error('Publication #' + item.id + ' lacks its year label, data-year or data-selected.');
        }
        return entry;
      });
    });
    var printing = window.matchMedia('print');
    // all: every entry is on view. Within each list a year is labeled once, on its first entry on view.
    var show = function (all) {
      heading.textContent = all ? 'Publications' : 'Selected Publications';
      button.textContent = all ? 'Show selected' : 'Show all';
      button.setAttribute('aria-expanded', String(all));
      lists.forEach(function (entries) {
        var seen = {};
        entries.forEach(function (entry) {
          var first = (all || entry.selected === '1') && !seen[entry.year];
          entry.label.hidden = !first;
          if (first) seen[entry.year] = true;
        });
      });
    };
    var render = function () {
      show(printing.matches || !root.classList.contains('pubs-selected'));
    };
    button.addEventListener('click', function () {
      root.classList.toggle('pubs-selected');
      render();
    });
    window.addEventListener('beforeprint', function () { show(true); });
    window.addEventListener('afterprint', render);
    printing.addEventListener('change', render);
    render();
    button.parentElement.hidden = false;
  } catch (err) {
    console.error('The publications switch failed, so every entry is shown.', err);
    root.classList.remove('pubs-selected');
  }
})();
