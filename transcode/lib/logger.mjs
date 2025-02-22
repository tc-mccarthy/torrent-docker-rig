import winston from 'winston';

const log_format = [
  winston.format.errors({ stack: true }),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.json()
];

if (process.env.LOG_PRETTY === 'on') {
  log_format.push(winston.format.prettyPrint());
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(...log_format),
  defaultMeta: { hostname: process.env.HOSTNAME || 'localhost' },
  transports: [new winston.transports.Console()]
});

export default logger;
