// Which look the program wears: the pixel look (default) or the classic look. Kept on this device.
(function () {
  var look = 'pixel';
  try { look = localStorage.getItem('gb-look') === 'classic' ? 'classic' : 'pixel'; } catch (e) { /* the default */ }
  document.documentElement.dataset.look = look;
})();
