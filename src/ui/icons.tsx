// Small stroke icons (24px grid, currentColor).

type P = { size?: number }
const svg = (size: number, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)

export const HandIcon = ({ size = 24 }: P) =>
  svg(size, <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5V4a1.5 1.5 0 0 1 3 0v7m0-5.5a1.5 1.5 0 0 1 3 0V12m0-3.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.8-2.4L4 15.5a1.6 1.6 0 0 1 2.4-2.1L8 15" />)

export const BookIcon = ({ size = 24 }: P) =>
  svg(size, <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" /></>)

export const InfoIcon = ({ size = 24 }: P) =>
  svg(size, <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></>)

export const ReplayIcon = ({ size = 22 }: P) =>
  svg(size, <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>)

export const StopIcon = ({ size = 22 }: P) =>
  svg(size, <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />)

export const SendIcon = ({ size = 22 }: P) =>
  svg(size, <><path d="M5 12h13" /><path d="m12 5 7 7-7 7" /></>)

export const SearchIcon = ({ size = 20 }: P) =>
  svg(size, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>)

export const LettersIcon = ({ size = 14 }: P) =>
  svg(size, <><path d="M4 18 8 6l4 12M5.5 14h5" /><path d="M15 10h5l-5 8h5" /></>)

export const ClearIcon = ({ size = 20 }: P) =>
  svg(size, <path d="M6 6l12 12M18 6 6 18" />)

export const RecentIcon = ({ size = 20 }: P) =>
  svg(size, <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 8v4l3 2" /></>)

export const CameraIcon = ({ size = 20 }: P) =>
  svg(size, <><rect x="2.5" y="6" width="13" height="12" rx="2.5" /><path d="m15.5 10.5 6-3.5v10l-6-3.5z" /></>)

export const CameraOffIcon = ({ size = 20 }: P) =>
  svg(size, <><rect x="2.5" y="6" width="13" height="12" rx="2.5" /><path d="m15.5 10.5 6-3.5v10l-6-3.5z" /><path d="M3 3l18 18" /></>)

export const RepeatIcon = ({ size = 24 }: P) =>
  svg(size, <><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></>)

export const MirrorIcon = ({ size = 24 }: P) =>
  svg(size, <><path d="M12 3v18" strokeDasharray="2 3" /><path d="M9 7 4 12l5 5z" /><path d="m15 7 5 5-5 5z" /></>)

export const LearnIcon = ({ size = 24 }: P) =>
  svg(size, <><path d="M2 9.5 12 5l10 4.5L12 14z" /><path d="M6 11.5V16c3.5 2.5 8.5 2.5 12 0v-4.5" /><path d="M22 9.5v5" /></>)

export const CheckIcon = ({ size = 24 }: P) =>
  svg(size, <path d="M5 12.5 10 17.5 19.5 7" />)

export const LockIcon = ({ size = 20 }: P) =>
  svg(size, <><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>)

// filled silhouettes read better than outlines at this size
const solid = (size: number, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    {children}
  </svg>
)

/** slower */
export const TurtleIcon = ({ size = 22 }: P) =>
  solid(size, <>
    <path d="M2 16.2a8.2 7.6 0 0 1 16.4 0z" />
    <circle cx="19.6" cy="14.2" r="2.3" />
    <rect x="4.2" y="15" width="3.2" height="4.6" rx="1.4" />
    <rect x="12.9" y="15" width="3.2" height="4.6" rx="1.4" />
  </>)

/** faster */
export const HareIcon = ({ size = 22 }: P) =>
  solid(size, <>
    <ellipse cx="10" cy="15" rx="6.9" ry="4.7" />
    <circle cx="17.3" cy="10.9" r="2.9" />
    <ellipse cx="14.8" cy="5.6" rx="1.2" ry="3.6" transform="rotate(-28 14.8 5.6)" />
    <ellipse cx="17.6" cy="5.1" rx="1.2" ry="3.6" transform="rotate(-8 17.6 5.1)" />
    <circle cx="3" cy="12.6" r="1.6" />
    <rect x="13.4" y="17.6" width="4.6" height="2.4" rx="1.2" />
  </>)

export const FlameIcon = ({ size = 24 }: P) =>
  solid(size, <path d="M12.6 2c.7 3.7 5.9 6 5.9 11.4 0 3.9-2.9 7.1-6.5 7.1s-6.5-3-6.5-6.9c0-2.8 1.5-4.8 3.2-5.9.1 2 1 3.4 2.4 3.9-.6-3.5-.2-6.6 1.5-9.6z" />)
