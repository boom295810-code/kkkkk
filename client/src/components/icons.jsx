// Shared icon set for the upload/download affordances — there was no actual
// cloud icon anywhere in the app before this (the dropzone was text-only,
// downloads used a plain "⬇" glyph); these are new, not a redesign of an
// existing asset. Same stroke-based style as Preview.jsx's SwapIcon/GearIcon
// so everything reads as one icon language.

export function CloudUploadIcon({ size = 40 }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} fill="none">
      <defs>
        <linearGradient id="cloudUpGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#8b9bff" />
          <stop offset="100%" stopColor="#b58cf5" />
        </linearGradient>
      </defs>
      <path
        d="M14.5 33.5a8 8 0 0 1-1-15.94A10 10 0 0 1 33 15a7.5 7.5 0 0 1 2.5 14.55"
        stroke="url(#cloudUpGrad)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
      />
      <path d="M24 21v14" stroke="url(#cloudUpGrad)" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M18.5 26.5 24 21l5.5 5.5" stroke="url(#cloudUpGrad)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DownloadIcon({ size = 14 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4v11" />
      <path d="M7.5 11.5 12 16l4.5-4.5" />
      <path d="M5 19.5h14" />
    </svg>
  );
}
