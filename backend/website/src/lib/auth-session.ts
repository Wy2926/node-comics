import { ErrorResponse, User } from 'oidc-client-ts';

export const sessionPrefix = 'nc-site-session:';
export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}
export class RefreshUnavailable extends Error {
  constructor() { super('登录续期未完成，请检查网络后重试；授权已失效时请重新登录。'); }
}
interface StoredSession { id: string; user: string | null; retryAt?: number; relogin?: boolean }
interface SessionBinding { id: string; user: User }
export const changedSession = () => new ApiError('账户已退出，请重新登录。', 401);

export function validUser(user: User): boolean {
  return !!user.access_token && !!user.refresh_token && user.token_type?.toLowerCase() === 'bearer' &&
    Number.isFinite(user.expires_at) && user.expires_at! > 0 && typeof user.profile?.sub === 'string' && !!user.profile.sub;
}

// One atomic record is the only durable token store. Protocol operations do not
// write it: a short write lock commits their result only to its original login.
export class SharedSession {
  constructor(
    private storage: Storage,
    readonly key: string,
    private locks: Pick<LockManager, 'request'>,
    private refresh: (user: User) => Promise<User>,
    private notify: () => void,
  ) {}

  private read(): StoredSession {
    try {
      const value = JSON.parse(this.storage.getItem(this.key) ?? 'null');
      if (typeof value?.id === 'string' && (value.user === null || typeof value.user === 'string')) return value;
    } catch { /* Invalid persisted data is not an identity. */ }
    return { id: '', user: null };
  }

  private write(value: StoredSession, notify = false) {
    this.storage.setItem(this.key, JSON.stringify(value));
    if (notify) this.notify();
  }

  private user(value: StoredSession): User | null {
    if (!value.user) return null;
    try { const user = User.fromStorageString(value.user); return validUser(user) ? user : null; }
    catch { return null; }
  }

  assert(id: string) { if (this.read().id !== id) throw changedSession(); }

  async beginLogin() {
    return this.locks.request(this.key + ':write', () => {
      const prompt = this.read().relogin ? 'login consent' : 'consent';
      const id = crypto.randomUUID();
      this.write({ id, user: null }, true);
      return { id, prompt };
    });
  }

  async finishLogin(id: string, user: User) {
    if (!validUser(user) || user.expired) throw changedSession();
    return this.locks.request(this.key + ':write', () => {
      const current = this.read();
      if (current.id !== id || current.user !== null) throw changedSession();
      this.write({ id, user: user.toStorageString() }, true);
    });
  }

  async signOut() {
    await this.locks.request(this.key + ':write', () => {
      this.write({ id: crypto.randomUUID(), user: null, relogin: true }, true);
    });
  }

  async expire(binding: SessionBinding) {
    await this.locks.request(this.key + ':write', () => {
      const current = this.read();
      if (current.id === binding.id && this.user(current)?.access_token === binding.user.access_token)
        this.write({ id: crypto.randomUUID(), user: null }, true);
    });
  }

  async get(rejectedToken?: string, expectedId?: string): Promise<SessionBinding | null> {
    const initial = this.read();
    if (expectedId !== undefined && initial.id !== expectedId) throw changedSession();
    const first = this.user(initial);
    if (!first) return null;
    const needsRefresh = (user: User) => user.expired || (user.expires_in ?? 0) < 60 ||
      rejectedToken === user.access_token;
    if (!needsRefresh(first)) return { id: initial.id, user: first };
    return this.locks.request(this.key + ':refresh', async () => {
      const before = this.read();
      if (before.id !== initial.id) throw changedSession();
      const user = this.user(before);
      if (!user) return null;
      const binding = { id: before.id, user };
      if (!needsRefresh(user)) return binding;
      if ((before.retryAt ?? 0) > Date.now()) {
        if (!user.expired && !rejectedToken) return binding;
        throw new RefreshUnavailable();
      }
      let renewed: User;
      try {
        renewed = await this.refresh(user);
        if (!validUser(renewed) || renewed.expired || renewed.profile.sub !== user.profile.sub) {
          await this.expire(binding);
          throw changedSession();
        }
      } catch (error) {
        this.assert(before.id);
        if (error instanceof ApiError || error instanceof ErrorResponse &&
          ['invalid_grant', 'login_required', 'interaction_required'].includes(error.error ?? '')) {
          await this.expire(binding);
          throw changedSession();
        }
        await this.locks.request(this.key + ':write', () => {
          const current = this.read();
          if (current.id === before.id && current.user === before.user)
            this.write({ ...current, retryAt: Date.now() + 30000 });
        });
        this.assert(before.id);
        if (!user.expired && !rejectedToken) return binding;
        throw new RefreshUnavailable();
      }
      return this.locks.request(this.key + ':write', () => {
        const current = this.read();
        if (current.id !== before.id || current.user !== before.user) throw changedSession();
        this.write({ id: before.id, user: renewed.toStorageString() });
        return { id: before.id, user: renewed };
      });
    });
  }
}
