import { jsxRenderer } from 'hono/jsx-renderer';

export const renderer = jsxRenderer(({ children }) => (
  <html lang="en" data-theme="light">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Evals Dashboard</title>
      <link
        href={import.meta.env.PROD ? '/assets/styles.css' : '/styles.css'}
        rel="stylesheet"
      />
    </head>
    <body class="bg-base-200 text-base-content antialiased">{children}</body>
  </html>
));
