import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_MS = 30 * 24 * 3600 * 1000;
const COOKIE = 'kalends_session';

export class Auth {
  constructor(store) {
    this.store = store;
    this.sessions = new Map();
    this.failures = new Map();
  }

  hasPassword() {
    return Boolean(this.store.getKv('adminHash'));
  }

  setPassword(password) {
    if (typeof password !== 'string' || password.length < 8) throw new Error('Password must be at least 8 characters');
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);
    this.store.setKv('adminHash', `${salt.toString('hex')}:${hash.toString('hex')}`);
    this.sessions.clear();
  }

  check(password) {
    const stored = this.store.getKv('adminHash');
    if (!stored || typeof password !== 'string') return false;
    const [saltHex, hashHex] = stored.split(':');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return timingSafeEqual(expected, actual);
  }

  throttled(ip) {
    const f = this.failures.get(ip);
    return f && f.count >= 5 && Date.now() - f.at < 60000;
  }

  fail(ip) {
    const f = this.failures.get(ip);
    if (f && Date.now() - f.at < 60000) f.count += 1;
    else this.failures.set(ip, { count: 1, at: Date.now() });
  }

  createSession() {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, Date.now() + SESSION_MS);
    return token;
  }

  destroy(token) {
    if (token) this.sessions.delete(token);
  }

  tokenFrom(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  }

  isAuthed(req) {
    const token = this.tokenFrom(req);
    if (!token) return false;
    const exp = this.sessions.get(token);
    if (!exp) return false;
    if (exp < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  cookie(token, req) {
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
    if (!token) return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`;
  }
}
