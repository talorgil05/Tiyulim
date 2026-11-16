// Light / dark theme (same as תיאומון).
// Loaded as a plain blocking script in <head>, before the stylesheets, so the page is drawn in the right
// colors from the first frame. Choice: localStorage "ty_theme" = auto (follow the phone) | light | dark.
(function () {
  var KEY = 'ty_theme';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function pref() { try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; } }
  function apply() {
    var p = pref();
    var dark = p === 'dark' || (p === 'auto' && mq && mq.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      if (!meta.dataset.light) meta.dataset.light = meta.getAttribute('content');
      meta.setAttribute('content', dark ? '#0E1524' : meta.dataset.light);
    }
  }
  apply();
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', apply);   // the <meta> may come after this script
  window.tmTheme = {
    get: pref,
    set: function (p) { try { localStorage.setItem(KEY, p); } catch (e) { /* private mode */ } apply(); },
  };
})();
