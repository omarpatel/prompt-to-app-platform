import { AppgenError } from "./errors.js";
import type { AppgenEnv } from "./types.js";

declare global {
  interface Window {
    __APPGEN__?: AppgenEnv;
  }
}

/**
 * Fields the SDK cannot work without. `googleClientId` and `tokenAddress` are deliberately
 * absent: a local `vite dev`/`vite preview` host leaves them empty, and the SDK then runs
 * without Google sign-in / holder gating instead of crashing the app.
 */
const REQUIRED: readonly (keyof AppgenEnv)[] = ["appId", "slug"];

let cached: AppgenEnv | null = null;

/**
 * The host injects `<script src="/_appgen/env.js">` before `</head>`, which assigns
 * `window.__APPGEN__`. Anything importing the SDK outside a hosted Appgen app gets a
 * loud error instead of silent `undefined` dereferences.
 */
export function appgenEnv(): AppgenEnv {
  if (cached) return cached;
  const raw = typeof window === "undefined" ? undefined : window.__APPGEN__;
  if (!raw) {
    throw new AppgenError(
      "window.__APPGEN__ is missing — @appgen/app-sdk only runs inside an app hosted on Appgen, " +
        'where the platform injects <script src="/_appgen/env.js"></script>. ' +
        "Locally, `npm run dev` / `npm run preview` provide it via dev/appgen-local-host.ts.",
      { code: "env_missing" },
    );
  }
  const missing = REQUIRED.filter((k) => typeof raw[k] !== "string" || raw[k] === "");
  if (missing.length > 0) {
    throw new AppgenError(`window.__APPGEN__ is incomplete — missing: ${missing.join(", ")}`, {
      code: "env_incomplete",
    });
  }
  // `basePath` is "" on subdomain hosting; normalise a trailing slash away so URL joins stay simple.
  cached = {
    ...raw,
    basePath: (raw.basePath ?? "").replace(/\/+$/, ""),
    chainId: raw.chainId ?? 4663,
    googleClientId: raw.googleClientId ?? "",
    tokenAddress: raw.tokenAddress ?? "",
    explorerUrl: (raw.explorerUrl ?? "https://robinhoodchain.blockscout.com").replace(/\/+$/, ""),
    apiOrigin: raw.apiOrigin ?? "",
  };
  return cached;
}

/** True when the page was served by the Appgen host, i.e. the SDK can be used. */
export function hasAppgenEnv(): boolean {
  return typeof window !== "undefined" && !!window.__APPGEN__;
}

/** Absolute-on-origin URL for a platform endpoint, e.g. `/a/my-app/_appgen/me`. */
export function appgenUrl(path: string): string {
  const env = appgenEnv();
  return `${env.basePath}${path.startsWith("/") ? path : `/${path}`}`;
}
