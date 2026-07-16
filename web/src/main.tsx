import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Overview } from './pages/Overview';
import { Agents } from './pages/Agents';
import { AgentDetail } from './pages/AgentDetail';
import { AgentForm } from './pages/AgentForm';
import { Sessions } from './pages/Sessions';
import { SessionDetail } from './pages/SessionDetail';
import { Environments, EnvironmentDetail } from './pages/Environments';
import { Deployments, DeploymentDetail, DeploymentForm } from './pages/Deployments';
import { Settings } from './pages/Settings';
import './styles.css';

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Overview /> },
      { path: '/agents', element: <Agents /> },
      { path: '/agents/new', element: <AgentForm /> },
      { path: '/agents/:id', element: <AgentDetail /> },
      { path: '/agents/:id/edit', element: <AgentForm /> },
      { path: '/sessions', element: <Sessions /> },
      { path: '/sessions/:id', element: <SessionDetail /> },
      { path: '/environments', element: <Environments /> },
      { path: '/environments/:id', element: <EnvironmentDetail /> },
      { path: '/deployments', element: <Deployments /> },
      { path: '/deployments/new', element: <DeploymentForm /> },
      { path: '/deployments/:id', element: <DeploymentDetail /> },
      { path: '/settings', element: <Settings /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
