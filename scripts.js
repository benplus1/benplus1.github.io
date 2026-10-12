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
