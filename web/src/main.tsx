import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Overview } from './pages/Overview';
import { Agents } from './pages/Agents';
import { AgentDetail } from './pages/AgentDetail';
import { AgentBuilder } from './pages/AgentBuilder';
import { Runs } from './pages/Runs';
import { RunDetail } from './pages/RunDetail';
import { Triggers } from './pages/Triggers';
import { Library } from './pages/Library';
import { EnvironmentPage } from './pages/EnvironmentPage';
import './styles.css';

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Overview /> },
      { path: '/agents', element: <Agents /> },
      { path: '/agents/new', element: <AgentBuilder /> },
      { path: '/agents/:id', element: <AgentDetail /> },
      { path: '/agents/:id/edit', element: <AgentBuilder /> },
      { path: '/runs', element: <Runs /> },
      { path: '/runs/:dagRunId', element: <RunDetail /> },
      { path: '/triggers', element: <Triggers /> },
      { path: '/library', element: <Library /> },
      { path: '/environment', element: <EnvironmentPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
