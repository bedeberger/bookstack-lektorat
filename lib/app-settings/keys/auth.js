'use strict';
// Settings-Keys: Anmeldung, Mailversand, Benachrichtigungen.
// Teil der Registry — Deskriptor-Format und Regeln stehen in
// [../registry.js](../registry.js).

module.exports = {
  // Auth
  'auth.allow_open_signup': { default: false, env: [['ALLOW_OPEN_SIGNUP', v => v === 'true' || v === '1']] },
  // ALTCHA-Proof-of-Work-Schutz fuer /register und den ENV-Admin-Login.
  // Self-hosted, kein Drittanbieter-Call. enabled=false = aus; harter
  // Rate-Limit (3/h/IP Register, 5/15min Admin-Login) bleibt unabhaengig
  // davon aktiv. Das HMAC-Secret (auth.altcha.hmac_secret) wird beim
  // Aktivieren automatisch generiert, falls noch leer.
  'auth.altcha.enabled': { default: false },
  // PoW-Schwierigkeit = obere Grenze der zu durchsuchenden Zahl. Hoeher =
  // mehr Browser-Rechenzeit pro Loesung (Bot-Kosten), aber traegere UX.
  'auth.altcha.complexity': { default: 100000, validate: { type: 'int', min: 1000, max: 5000000 } },
  // Lebensdauer einer ausgegebenen PoW-Challenge in Minuten. Lang genug fuer
  // langsame Geraete, kurz genug um das Replay-Fenster eng zu halten (der
  // Rate-Limit deckt den Rest).
  'auth.altcha.challenge_ttl_min': { default: 10, validate: { type: 'int', min: 1, max: 120 } },
  // Maximalalter pending-Anfragen; Cron setzt sie danach auf
  // 'expired' (DB-Status). Default 30 Tage analog spec.
  'auth.registration.expire_days': { default: 30, validate: { type: 'int', min: 1, max: 365 } },
  // Register-Formular-Rate-Limit (In-Memory, pro IP). max Anfragen pro
  // window_min Minuten; danach 429 mit Retry-After. Schuetzt das oeffentliche
  // /register vor Spam-Anmeldungen, unabhaengig vom ALTCHA-Toggle.
  'auth.register.rate_limit_max': { default: 3, validate: { type: 'int', min: 1, max: 1000 } },
  'auth.register.rate_limit_window_min': { default: 60, validate: { type: 'int', min: 1, max: 1440 } },
  // Admin-Login-Lockout (In-Memory, pro IP). Nach max_fails Fehlversuchen
  // innerhalb window_min Minuten wird die IP fuer denselben Zeitraum gesperrt
  // (429 + Retry-After).
  'auth.admin_login.max_fails': { default: 5, validate: { type: 'int', min: 1, max: 1000 } },
  'auth.admin_login.window_min': { default: 15, validate: { type: 'int', min: 1, max: 1440 } },

  // SMTP (Gmail-App-Password). Pflichtfelder fuer Mailer-Aktivierung sind
  // `smtp.gmail.user` + `smtp.gmail.app_password`. Defaults leer, damit das
  // Admin-Settings-UI die Keys auch ohne bestehende DB-Row rendert (sonst
  // greift der `if (!s) continue`-Guard im Save-Pfad).
  'smtp.gmail.user': { default: '' },
  'smtp.gmail.app_password': { default: '', secret: true },
  'smtp.from_name': { default: 'Schreibwerkstatt' },
  'smtp.reply_to': { default: '' },
  'smtp.rate_limit_per_minute': { default: 30, validate: { type: 'int', min: 1, max: 500 } },

  // Notification-Mails (Job-Crash, Token-Cap, Budget-Overrun).
  // Master-Toggles je Pfad; Throttle deduped Crash-/Token-Cap-Mails
  // pro {type,errorPrefix} fuer N Minuten. skip_errors blockiert genannte
  // i18n-Keys (Komma-Liste); leer = Defaults aus lib/notify.js.
  'mail.notify.admin_on_job_fail': { default: true },
  'mail.notify.admin_on_token_cap': { default: true },
  'mail.notify.user_on_budget_overrun': { default: true },
  'mail.notify.admin_on_budget_overrun': { default: true },
  // Beta-Leser-Feedback: Owner-Mail bei neuem Share-Kommentar (gedrosselt pro
  // Link, opt-out). Owner-eigene Antworten loesen nichts aus.
  'mail.notify.owner_on_share_comment': { default: true },
  // Reviewer-Mail, wenn der Autor auf seinen Thread antwortet (nur wenn der Leser
  // eine Adresse hinterlegt hat; gedrosselt pro Thread, opt-out).
  'mail.notify.reader_on_owner_reply': { default: true },
  'mail.notify.job_fail_throttle_min': { default: 60, validate: { type: 'int', min: 0, max: 1440 } },
  'mail.notify.skip_errors': { default: 'job.cancelled,BUDGET_EXCEEDED,job.error.aiTruncated,job.error.parseFailed,job.error.aiInvalidJson' },
  // Forward-Adresse fuer Admin-Notifications. Leer = an alle aktiven Admin-User
  // (global_role='admin'). Gesetzt = ersetzt diese Liste komplett, sodass
  // Mails an eine Adresse gehen, die nicht zwingend einem Admin-Account
  // entspricht.
  'mail.notify.admin_recipient': { default: '' },
};
