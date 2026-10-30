/** Wire types shared by the framework-free core and the React bindings. */

/** Runtime configuration the host injects as `window.__APPGEN__` via `<script src="/_appgen/env.js">`. */
export interface AppgenEnv {
  /** Appgen app id (cuid). */
  appId: string;
  /** URL slug the app is served under. */
  slug: string;
  /** EVM chain id the app's coin lives on: Robinhood Chain, `4663`. */
  chainId: number;
  /** The app's coin (PONS v2 launch token, 18 decimals). Empty until the coin is launched and on local hosts. */
  tokenAddress: string;
  /** Blockscout explorer origin for Robinhood Chain (`/tx/<hash>`, `/token/<address>`). */
  explorerUrl: string;
  /** Google OAuth web client id used for in-app sign-in. Empty on local dev/preview hosts. */
  googleClientId: string;
  /**
   * Prefix every `/_appgen/*` request has to carry. `""` when the app is served on its own
   * subdomain, `"/a/<slug>"` when it is path-routed. Never has a trailing slash.
   */
  basePath: string;
  /** Origin of the Appgen platform API (for links back to the coin page). */
  apiOrigin: string;
  /** Display name of the app. */
  name?: string;
  /** Coin ticker of the app. */
  ticker?: string;
  /** Live deployment version. */
  version?: number;
  /** Whole tokens required for holder-gated features. */
  holderMin?: string | number;
  /** Server functions declared in `appgen.manifest.json`. */
  functions?: AppgenFunction[];
}

export interface AppgenFunction {
  name: string;
  auth: boolean;
  holderOnly: boolean;
}

export interface AppgenUser {
  id: string;
  /** Robinhood Chain address (0x) the platform holds for this user; `null` before one is assigned. */
  wallet: string | null;
  displayName: string | null;
}

export interface HolderStatus {
  isHolder: boolean;
  /** Whole tokens held, as a decimal string. */
  balance: string;
  /** Whole tokens required to pass the holder gate. */
  minHold: string;
}

export interface MeResult {
  user: AppgenUser | null;
  holder: HolderStatus;
}
