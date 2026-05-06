const path = require('path');
const winston = require('winston');

const LOG_FILE = path.join(__dirname, 'lektorat.log');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, job, user, book, ip, stack }) => {
      let ctx = '';
      if (job) ctx = ` [${job}|${user || '-'}|${book || '-'}]`;
      else if (ip || user) ctx = ` [${user || '-'}@${ip || '-'}]`;
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
