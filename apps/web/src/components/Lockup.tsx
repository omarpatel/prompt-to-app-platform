import { cx } from "../ui/cx.js";

/** The mark alone: a rounded tile with a bracket glyph, matching `public/favicon.svg`. */
export const Mark = ({ size = 24, className }: { size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Appgen" className={className}>
    <rect width="32" height="32" rx="7" fill="#3E8BFF" />
    <path d="M12 10l-5 6 5 6M20 10l5 6-5 6" fill="none" stroke="#0A0A0C" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Mark + wordmark, horizontal. `height` is the height of the lockup box; the wordmark is `currentColor`. */
export const Lockup = ({ height = 22, className }: { height?: number; className?: string }) => (
  <span role="img" aria-label="Appgen" className={cx("inline-flex shrink-0 items-center gap-2 whitespace-nowrap font-semibold text-ink", className)} style={{ height, fontSize: height * 0.8, lineHeight: 1 }}>
    <Mark size={height} />
    <span aria-hidden>appgen</span>
  </span>
);
