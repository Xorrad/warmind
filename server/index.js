/**
 * @file Express app: static client, API routes.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();

// Front-end files
app.use(express.static(path.join(root, 'client')));
// The game engine is shared: the browser imports it directly
app.use('/engine', express.static(path.join(root, 'engine')));
// Browser-side dependencies (mapped in index.html's import map)
app.use('/vendor/d3-delaunay', express.static(path.join(root, 'node_modules/d3-delaunay/dist')));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
    console.log(`WarMind running on http://localhost:${port}`);
});
