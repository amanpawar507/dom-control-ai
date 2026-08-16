export interface AuthenticatedContext {
  /** Serialized Playwright storage state. Contains a session cookie, never a credential. */
  storageState: string;
  acquiredAt: string;
}

export interface SessionProvider {
  acquire(product: string, tenant: string): Promise<AuthenticatedContext>;
  refresh(ctx: AuthenticatedContext): Promise<AuthenticatedContext>;
  release(ctx: AuthenticatedContext): Promise<void>;
}
