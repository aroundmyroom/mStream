import winston from 'winston';
import 'winston-daily-rotate-file';
import os from 'os';

let fileTransport;

const myFormat = winston.format.printf(info => {
  let msg = `${info.timestamp} ${info.level}: ${info.message}`;
  if (!info.stack) { return msg; }

  const stackStr = typeof info.stack === 'string' ?
    { stack: info.stack } :
    JSON.parse(JSON.stringify(info.stack, Object.getOwnPropertyNames(info.stack)));

  return msg +=  os.EOL + stackStr.stack;
});

winston.configure({
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        myFormat
      )
    })
  ],
  exitOnError: false
});

// Valid retention values (must stay in sync with config.js validation + admin UI)
export const VALID_RETENTIONS = ['1d', '3d', '7d', '14d', '30d'];
export const DEFAULT_RETENTION = '14d';

export function addFileLogger(filepath, maxFiles = DEFAULT_RETENTION) {
  if (fileTransport) {
    reset();
  }

  fileTransport = new (winston.transports.DailyRotateFile)({
    filename: 'mstream-%DATE%',
    dirname: filepath,
    extension: '.log',
    datePattern: 'YYYY-MM-DD-HH',
    maxSize: '20m',
    maxFiles: VALID_RETENTIONS.includes(maxFiles) ? maxFiles : DEFAULT_RETENTION,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
  });

  winston.add(fileTransport);
}

export function reset() {
  if (fileTransport) {
    winston.remove(fileTransport);
  }

  fileTransport = undefined;
}
