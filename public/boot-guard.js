// Recovers when the game's script fails to load, which happens for a few
// seconds after a deploy while the new version spreads across Cloudflare.
// Reloads with a growing pause (1 s, 2 s, 4 s), then offers a Reload button.
// A plain, unhashed script so it exists in every version; the game calls
// window.__diceLoaded() once it's running, which resets the retry count.
(function () {
  var KEY = "dice.reloads";
  var MAX_RELOADS = 3;
  var recovering = false;

  function attempts() {
    try {
      return Number(sessionStorage.getItem(KEY)) || 0;
    } catch (e) {
      return MAX_RELOADS; // no storage: don't risk a reload loop
    }
  }

  function notice(text, withButton) {
    var box = document.getElementById("boot-guard") || document.createElement("div");
    box.id = "boot-guard";
    box.setAttribute("role", "status");
    box.style.cssText =
      "position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:16px;" +
      "background:#0f1a14;color:#f4efe4;font:16px/1.4 system-ui,-apple-system,sans-serif;text-align:center";
    box.textContent = "";
    var inner = document.createElement("div");
    var p = document.createElement("p");
    p.textContent = text;
    inner.appendChild(p);
    if (withButton) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = "Reload";
      b.style.cssText = "border:0;border-radius:14px;padding:12px 22px;font:inherit;font-weight:700;background:#f2c14e;color:#1d1606;cursor:pointer";
      b.onclick = function () {
        try {
          sessionStorage.removeItem(KEY);
        } catch (e) {}
        location.reload();
      };
      inner.appendChild(b);
    }
    box.appendChild(inner);
    (document.body || document.documentElement).appendChild(box);
  }

  function recover() {
    if (recovering) return;
    recovering = true;
    var n = attempts();
    if (n >= MAX_RELOADS) {
      notice("Couldn't load the game. Check your connection and try again.", true);
      return;
    }
    try {
      sessionStorage.setItem(KEY, String(n + 1));
    } catch (e) {}
    notice("Loading the latest version…", false);
    setTimeout(function () {
      location.reload();
    }, 1000 * Math.pow(2, n));
  }

  // Script and stylesheet load errors don't bubble; catch them on the way down.
  window.addEventListener(
    "error",
    function (e) {
      var t = e.target;
      if (!t || t === window) return;
      var url = t.tagName === "SCRIPT" ? t.src : t.tagName === "LINK" ? t.href : "";
      if (url && url.indexOf("/assets/") !== -1) recover();
    },
    true
  );
  // Vite fires this when a lazily loaded part of the game (e.g. the Discord SDK) fails to load.
  window.addEventListener("vite:preloadError", recover);

  window.__diceLoaded = function () {
    try {
      sessionStorage.removeItem(KEY);
    } catch (e) {}
  };
})();
