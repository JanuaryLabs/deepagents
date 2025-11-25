import {
  type RouteConfig,
  index,
  layout,
  route,
} from '@react-router/dev/routes';

export default [
  layout('./routes/home.tsx', [index('./app.tsx')]),
  route('docs/*', './routes/docs.tsx'),
  route('api/search', './routes/search.ts'),
] satisfies RouteConfig;
