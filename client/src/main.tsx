import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { io } from 'socket.io-client';
import 'leaflet/dist/leaflet.css';
import App from './App';
import './index.css';

const serverUrl = import.meta.env.VITE_SERVER_URL || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4000');
const socket = io(serverUrl, {
  autoConnect: false,
});

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <App socket={socket} />
    </BrowserRouter>
  </React.StrictMode>,
);