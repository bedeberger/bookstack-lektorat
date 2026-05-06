const path = require('path');
const winston = require('winston');
const { getContext } = require('./lib/log-context');

const LOG_FILE = path.join(__dirname, 'lektorat.log');

// Merged ALS-Context in jedes Log-Info-Objekt; explizite Felder am Call-Site
// haben Vorrang (info.job ?? c.job).
const enrichWithContext = winston.format((info) => {
  const c = getContext();
  if (info.job   == null && c.job   != null) info.job   = c.job;
  if (info.user  == null && c.user  != null) info.user  = c.user;
  if (info.book  == null && c.book  != null) info.book  = c.book;
  if (info.ip    == null && c.ip    != null) info.ip    = c.ip;
  if (info.reqId == null && c.reqId != null) info.reqId = c.reqId;
  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    enrichWithContext(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, job, user, book, ip, reqId, stack }) => {
      let ctx = '';
      if (job) {
        ctx = ` [${job}|${user || '-'}|${book || '-'}]`;
      } else if (ip || user) {
        const id = reqId ? `${reqId} ` : '';
        ctx = ` [${id}${user || '-'}@${ip || '-'}]`;
      }
      const tail = stack ? `\n${stack}` : '';
      return `${timestamp} [${level.toUpperCase()}]${ctx} ${message}${tail}`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: LOG_FILE, maxsize: 5 * 1024 * 1024, maxFiles: 3 }),
    new winston.transports.Console(),
  ],
});

module.exports = logger;
