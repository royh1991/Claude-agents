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
  { to: '/sessions', label: 'Sessions', icon: 'M3 3h10v7H6l-3 3V3ZM6 6h4M6 8h2' },
  { to: '/environments', label: 'Environments', icon: 'M8 2 14 5v6l-6 3-6-3V5l6-3ZM8 8v6M2 5l6 3 6-3' },
  { to: '/deployments', label: 'Schedules', icon: 'M8 4.5V8l2.5 1.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z' },
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
          <span className="env-tag">prod</span>
        </Link>

        <div className="nav-section">Console</div>
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === '/'}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <Icon d={item.icon} />
            {item.label}
          </NavLink>
        ))}

        <div className="nav-section">Workspace</div>
        <NavLink to="/settings" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <Icon d="M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm5.3-2c0 .4 0 .8-.1 1.2l1.6 1.2-1.3 2.2-1.9-.7c-.6.5-1.3.9-2 1.1L9.2 15H6.8l-.4-2c-.7-.2-1.4-.6-2-1.1l-1.9.7-1.3-2.2L2.8 9a5.6 5.6 0 0 1 0-2.4L1.2 5.4l1.3-2.2 1.9.7c.6-.5 1.3-.9 2-1.1L6.8 1h2.4l.4 2c.7.2 1.4.6 2 1.1l1.9-.7 1.3 2.2-1.6 1.2c.1.4.1.8.1 1.2Z" />
          Model providers
        </NavLink>

        <div className="sidebar-foot">
          Execution runs in Airflow (eks-data-prod).<br />
          The console never holds warehouse credentials.
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
