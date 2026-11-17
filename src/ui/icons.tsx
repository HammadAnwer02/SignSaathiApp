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
