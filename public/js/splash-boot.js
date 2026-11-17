// The opening animation plays once per visit: on a reload in the same tab it is skipped.
// Loaded as a blocking script in <head>, so the choice is made before the first frame.
(function () {
  try {
    if (sessionStorage.getItem('ty_splash_seen')) document.documentElement.classList.add('no-splash');
    else sessionStorage.setItem('ty_splash_seen', '1');
  } catch (e) { /* private mode: just play it */ }
})();
