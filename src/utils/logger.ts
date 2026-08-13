/**
 * Structured logging.
 *
 * Every line is JSON with a request id, so Workers Logs / Logpush can be
 * queried. A redaction pass strips anything that looks like a credential —
 * passwords, tokens, cookies and storage keys never reach the log sink.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'token',
  'token_hash',
  'session',
  'sessiontoken',
  'cookie',
  'authorization',
  'secret',
  'session_secret',
  'b2_application_key',
  'b2_application_key_id',
  's3_secret_access_key',
  's3_access_key_id',
  'apikey',
  'api_key',
  'csrf',
  'csrftoken',
  'storage_key',
  'storagekey',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export class Logger {
  constructor(
    private readonly minLevel: LogLevel = 'info',
    private readonly base: Record<string, unknown> = {},
  ) {}

  child(fields: Record<string, unknown>): Logger {
    return new Logger(this.minLevel, { ...this.base, ...fields });
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const entry = {
      level,
      time: new Date().toISOString(),
      msg: message,
      ...(redact(this.base) as Record<string, unknown>),
      ...((fields ? (redact(fields) as Record<string, unknown>) : {}) ?? {}),
    };
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  debug(message: string, fields?: Record<string, unknown>) {
    this.write('debug', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>) {
    this.write('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>) {
    this.write('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>) {
    this.write('error', message, fields);
  }
}

export function createLogger(level: string | undefined, base: Record<string, unknown> = {}): Logger {
  const normalized = (level ?? 'info') as LogLevel;
  const min: LogLevel = normalized in LEVEL_ORDER ? normalized : 'info';
  return new Logger(min, base);
}
