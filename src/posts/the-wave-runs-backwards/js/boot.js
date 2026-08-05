/* ============================================================================
   boot.js — starts this post's simulators
   ----------------------------------------------------------------------------
   The theme toggle and scroll indicator are site chrome and live in
   /scripts/site.js, which ships on every page. All this file still needs from
   the theme is a signal to drop the cached palette when it changes, since the
   canvases read their colours from CSS custom properties.
   ========================================================================== */
(function (global) {
  'use strict';

  var T = global.Traffic;

  function watchTheme() {
    if (global.MutationObserver) {
      new MutationObserver(function () { T.invalidateTheme(); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    if (global.matchMedia) {
      var mq = global.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { T.invalidateTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  function start() {
    watchTheme();
    if (T.initLightSim) T.initLightSim();
    if (T.initMergeSim) T.initMergeSim();
    if (T.initSpeedSim) T.initSpeedSim();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

})(window);
