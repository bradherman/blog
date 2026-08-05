/* Site chrome: the theme toggle and the scroll indicator.
   ----------------------------------------------------------------------------
   This ships on every page. It deliberately has no dependencies — a post's own
   scripts may or may not be present, and the chrome has to work either way.
   (The theme itself is applied by a tiny blocking snippet in <head>, so the
   page never paints in the wrong colours first.) */
(function () {
  'use strict';

  var STORAGE_KEY = 'theme';

  function stored() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }

  function effectiveTheme() {
    var stamped = document.documentElement.getAttribute('data-theme');
    if (stamped === 'dark' || stamped === 'light') return stamped;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark' : 'light';
  }

  function initTheme() {
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.addEventListener('click', function () {
        var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* private mode */ }
      });
    }

    /* Follow the OS only while the reader has not made a choice of their own. */
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () {
        if (stored()) return;
        document.documentElement.removeAttribute('data-theme');
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  function initProgress() {
    var dash = document.getElementById('progress-dash');
    if (!dash) return;
    var ticking = false;
    function update() {
      ticking = false;
      var doc = document.documentElement;
      var max = doc.scrollHeight - window.innerHeight;
      var frac = max > 0 ? Math.min(Math.max(doc.scrollTop / max, 0), 1) : 0;
      dash.style.width = (frac * 100).toFixed(2) + '%';
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    update();
  }

  function start() { initTheme(); initProgress(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
