import { serve } from '@hono/node-server';

import app from './app.ts';
import './startup.ts';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);

serve(
  {
    fetch: app.fetch,
    port: port,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
