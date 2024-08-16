import React from 'react';
import { createRoot } from 'react-dom/client';

// eslint-disable-next-line import/no-named-as-default
import Home from './components/Home/Home';

const root = createRoot(document.getElementById('app'));
// eslint-disable-next-line react/jsx-filename-extension
root.render(<Home />);
