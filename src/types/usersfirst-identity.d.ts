// Types for the vendored @usersfirst/identity (src/vendor/identity, plain JS with JSDoc).
// Only what this app uses is declared; the shapes follow the JSDoc in client.js and
// elements/uf-signin.js at the version named in src/vendor/identity/IDENTITY_VERSION.json.
// The specifiers are aliased to the vendored files in vite.config.ts.

declare module "@usersfirst/identity/client" {
  export type LoginInfo = { name?: string; avatar?: string | null };
  export type IdentityUser = {
    id: number | string;
    name: string;
    avatar: string | null;
    identities: Record<string, LoginInfo>;
    provider?: string;
  } & Record<string, unknown>;
  export type KeyValue = {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    removeItem(k: string): void;
  };
  export type IdentityOptions = {
    apiBase: string;
    storage?: KeyValue;
    tabStorage?: KeyValue;
    keys?: { user: string; token: string };
    fetch?: typeof fetch;
    deviceId?: () => string | undefined;
    sessionId?: () => string | undefined;
    location?: Pick<Location, "hash" | "pathname" | "search" | "origin" | "assign">;
    history?: Pick<History, "replaceState">;
    now?: () => number;
    /** refresh(): any 401 ends the session (default: only `account_gone` does). */
    forgetOn401?: boolean;
    /** Asked before a sign-in replaces a different account (default: the browser's confirm). */
    confirmSwitch?: (q: { from: { name?: string } | null; to: { name?: string } }) => boolean | Promise<boolean>;
  };
  export type ApiAnswer = { ok: boolean; status: number; data: Record<string, any> };

  export function decodeToken(token: string): Record<string, unknown> | null;
  export function takeRedirect(
    loc?: Pick<Location, "hash" | "pathname" | "search">,
    hist?: Pick<History, "replaceState">,
  ): { token?: string; result?: { id: string; code: string }; link?: { id: string; code: string }; server?: string; steam?: string } | null;

  export class IdentityClient {
    constructor(opts: IdentityOptions);
    apiBase: string;
    user: IdentityUser | null;
    token: string | null;
    lastError: string | null;
    /** The last refresh()'s HTTP status (0: offline). */
    meStatus: number;
    isSignedIn(): boolean;
    tokenExpired(marginSec?: number): boolean;
    onChange(fn: (user: IdentityUser | null, reason: string) => void): () => void;
    apply(token: string, serverUser: unknown, extra?: Record<string, unknown>, reason?: string): IdentityUser;
    clearToken(): void;
    signOut(): void;
    api(path: string, o?: { method?: string; body?: unknown; auth?: boolean }): Promise<ApiAnswer>;
    refresh(): Promise<IdentityUser | null>;
    /** Back from a redirect: swap `#ht_result` for a session (or an older `#ht_auth`, after a yes), or finish a link. Null: nothing to do. */
    resume(): Promise<{ signedIn?: boolean; expired?: boolean; mismatch?: boolean; declined?: boolean; link?: string; error?: string; server?: string; steam?: string; after?: string } | null>;
    /** Take `?ht_code` off the address and swap it for a session. Null: there was no code. */
    redeemHandoff(): Promise<{ signedIn: boolean; error?: string; declined?: boolean } | null>;
    begin(
      provider: "discord" | "steam",
      o?: { mode?: "redirect" | "device"; link?: boolean; returnTo?: string; joinServer?: boolean; scopes?: string[]; anyTab?: boolean },
    ): Promise<Record<string, any>>;
  }
}

declare module "@usersfirst/identity/elements/uf-signin" {
  /** `<uf-signin providers="discord">`; fires `uf-signin` with `detail.provider`. */
  export class UfSignin extends HTMLElement {
    readonly providers: string[];
    links: Record<string, string>;
    busy: string;
    error: string;
    button(provider: string): HTMLElement | null;
    buttons(): HTMLElement[];
    named(name: string): HTMLElement | null;
    renderNow(): void;
  }
}
