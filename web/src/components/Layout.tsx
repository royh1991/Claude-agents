import { NavLink, Link, Outlet } from 'react-router-dom';

function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

const NAV = [
  { to: '/', label: 'Overview', icon: 'M2 8.5 8 3l6 5.5M4 7.5V13h8V7.5' },
  { to: '/agents', label: 'Agents', icon: 'M8 2v2M4.5 4.5h7a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1ZM6 8h.01M10 8h.01M5.5 14h5' },
  { to: '/runs', label: 'Runs', icon: 'M2.5 8h3l1.5-4 2 8 1.5-4h3' },
  { to: '/triggers', label: 'Triggers', icon: 'M9 1.5 3 9h4l-1 5.5L12 7H8l1-5.5Z' },
  { to: '/library', label: 'Library', icon: 'M3 2.5h7a2 2 0 0 1 2 2V13a1.5 1.5 0 0 0-1.5-1.5H3V2.5ZM3 11.5V13h7.5' },
  { to: '/environment', label: 'Environment', icon: 'M8 2 14 5v6l-6 3-6-3V5l6-3ZM8 8v6M2 5l6 3 6-3' },
];

export function Layout() {
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link to="/" className="wordmark">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
            <rect width="32" height="32" rx="7" fill="#C15F3C" />
            <path d="M8 22V12l8-4 8 4v10" stroke="#FAF9F5" strokeWidth="2.5" fill="none"
              strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="16" cy="17" r="2.4" fill="#FAF9F5" />
          </svg>
          <span className="name">Gantry</span>
          <span className="env-tag">BI</span>
        </Link>

        <div className="nav-section">Console</div>
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === '/'}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <Icon d={item.icon} />
            {item.label}
          </NavLink>
        ))}

        <div className="sidebar-foot">
          Agents are YAML in the backend repo. Runs execute as
          ai-agent-runner DAG runs in Airflow, inside the VPC, with Vault
          credentials. This console never touches secrets.
        </div>
      </aside>
      <main className="main">
        <div className="content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
