// Handler fuer die Passwort-Formen der Login-Seite (Admin-Pfad + Demo-Zugang).
// Eigene Datei statt inline, weil CSP `script-src 'self'` ohne 'unsafe-inline'
// Inline-Scripts blockiert. Strings + Endpoint + returnTo kommen per data-*.
//
// Ein Handler fuer beide Formen: sie unterscheiden sich nur im Endpoint, und
// zwei Kopien wuerden bei jeder Aenderung am Fehler-Handling auseinanderlaufen.
// Selektoren sind darum form-relativ (name=/data-) statt per id — auf einer
// Seite koennen beide Formen gleichzeitig stehen.
(function () {
  const forms = document.querySelectorAll('form[data-login-endpoint]');
  if (!forms.length) return;

  forms.forEach((form) => {
    const endpoint = form.dataset.loginEndpoint;
    const returnTo = form.dataset.returnto || '/';
    const msgInvalid = form.dataset.msgInvalid || 'Invalid credentials.';
    const msgRateTpl = form.dataset.msgRateTpl || 'Too many attempts. Retry in {sec}s.';
    const msgCaptcha = form.dataset.msgCaptcha || 'Verification failed. Please retry.';
    const msgInactive = form.dataset.msgInactive || 'This account is not active.';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('[data-login-err]');
      const show = (text) => {
        if (!err) return;
        err.textContent = text;
        err.hidden = false;
      };
      if (err) { err.hidden = true; err.textContent = ''; }
      const email = form.querySelector('input[name="email"]').value.trim();
      const password = form.querySelector('input[name="password"]').value;
      // ALTCHA-Loesung (form-assoziiertes Widget). Feld fehlt, wenn ALTCHA aus ist.
      const altcha = new FormData(form).get('altcha') || null;
      try {
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password, altcha }),
        });
        if (r.ok) {
          window.location.href = returnTo;
          return;
        }
        const j = await r.json().catch(() => ({}));
        if (r.status === 429) {
          show(msgRateTpl.replace('{sec}', j.retryAfter || 900));
        } else if (r.status === 400 && j.error_code === 'CAPTCHA_FAILED') {
          show(msgCaptcha);
          try { form.querySelector('altcha-widget')?.reset?.(); } catch {}
        } else if (r.status === 403 && j.error_code === 'USER_NOT_ACTIVE') {
          show(msgInactive);
        } else {
          show(msgInvalid);
        }
      } catch (ex) {
        show(ex.message);
      }
    });
  });
})();
