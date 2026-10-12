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
