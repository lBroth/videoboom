import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider, keepPreviousData } from '@tanstack/react-query';
import App from './App';
import { ConfirmProvider } from './components/ui';
import './index.css';

// No auth gate, no network: state is local files read through window.vb. Keep last data while refetching.
const qc = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false, placeholderData: keepPreviousData, retry: 0 },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
