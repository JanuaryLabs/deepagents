import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      name: 'sql-loader',
      transform(code, id) {
        if (id.endsWith('.sql')) {
          return {
            code: `export default ${JSON.stringify(code)};`,
            map: null,
          };
        }
      },
    },
  ],
});
