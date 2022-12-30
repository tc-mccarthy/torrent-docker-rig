import React from 'react';
import { createRoot } from 'react-dom/client';

import Home from './components/Home/Home';

const root = createRoot(document.getElementById('app'));
// eslint-disable-next-line react/jsx-filename-extension
root.render(<Home />);
