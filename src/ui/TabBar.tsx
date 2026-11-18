import { BookIcon, HandIcon, InfoIcon } from './icons'

export type Tab = 'translate' | 'dictionary' | 'about'

const TABS: { key: Tab; label: string; Icon: () => React.ReactElement }[] = [
  { key: 'translate', label: 'Translate', Icon: () => <HandIcon /> },
  { key: 'dictionary', label: 'Dictionary', Icon: () => <BookIcon /> },
  { key: 'about', label: 'About', Icon: () => <InfoIcon /> },
]

export function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <nav className="tabbar" aria-label="Sections">
      <div className="tabbar-pill">
        {TABS.map(({ key, label, Icon }) => (
          <button key={key} className={tab === key ? 'on' : ''} aria-current={tab === key ? 'page' : undefined}
            onClick={() => onTab(key)}>
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
