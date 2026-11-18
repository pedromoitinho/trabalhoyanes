export const MIN = 60_000;

export const iso = (ms) => new Date(ms).toISOString();

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function fail(status, code, message) {
  throw new HttpError(status, code, message);
}

export function idOf(value, what = 'id') {
  const s = String(value ?? '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) fail(400, 'ID_INVALIDO', `${what} inválido.`);
  return s;
}

export const isAlreadyExists = (e) => e?.code === 6 || e?.code === 'ALREADY_EXISTS';
