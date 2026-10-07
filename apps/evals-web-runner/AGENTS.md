### General Rules

- The "developer" is working hand in hand with you to build a high quality and maintainable codebase and always ready to answer your questions to give you more context so never hesitate to ask and you are encouraged to ask questions.

- Always ask more questions until you have enough context to give an accurate & confident answer.

### API

- Don't duplicate error handling - it's already global
- The backend reads and writes data through the evals store (`RunStore` from `@deepagents/evals/store`). A route gets the store with `c.get('store')`.
- To check that a record exists, call its store getter. A getter returns `undefined` when the record does not exist. Throw a 404 in that case:

```ts
const run = store.getRun(id);
if (!run) {
  throw new HTTPException(404, { message: 'Run not found' });
}
```

- Custom error messages only when necessary
- To throw errors use `HTTPException` class from Hono:

```ts
throw new HTTPException(400, {
  message: '...',
  cause: {
    code: '<feature/domain>/<code>',
    detail: 'instructive detail',
  },
});
```

- Use `PATCH` for update

### Date & Time

- Use date-fns when possible.
- Use Intl API when date-fns doesn't support the required functionality.

### Generating the client

The frontend calls the backend through a generated client, `@evals/client`. The `frontend:generate-sdk` target makes it in two steps:

1. `backend:openapi` writes the OpenAPI spec of the backend routes to `.evals-sdk-it/openapi.json`.
2. The generator writes the client from that spec to `.evals-sdk-it`.

The frontend `build` and `typecheck` targets run `generate-sdk` for you. To run it alone, use `NX_DAEMON=false nx run frontend:generate-sdk`.

Do not edit the generated client. Change the backend route, then generate the client again.

### API Input Validation

The validator middleware is used both for validating request bodies, path and query parameters at runtime and act as directive for generating OpenAPI schema at build time hence make sure the `against` is staticaly analyzable.

Special schemas are supported only through

- `import * as inputs from '../core/inputs.ts'`

### Pagination

- Use the `toPagination` function to make the response of a paginated list.

### Unit Test

```sh
node --test <target-filename>.test.ts
```

### Using the API

```ts
const { data: suites } = useData('GET /suites', {});
```

`useData` returns the same result as `useQuery` from TanStack Query.

### Client Data Hooks

- Use `useData` and `useAction` from `frontend/src/app/hooks/use-client.ts` for all API calls in React components. Do not call `fetch` directly.
- Prefer server-managed state over duplicating data in component or local storage; reserve `localStorage` only for ephemeral UI preferences (e.g. theme).
- Use the `invalidate` option in `useAction` to refresh dependent queries after mutations rather than manual refetch logic.
- Do not create parallel caches; rely solely on React Query plus generated client typing for consistency and correctness.

### Running Typescript files

We use node version that support running typescript files directly without precompilation. To run a typescript file, use the following command:

```sh
node path/to/file.ts
```

### Building packages

To build a package, use the following command:

```sh
nx run <package-name>:build
```

For example, to build the `frontend` package/app, run:

```sh
nx run frontend:build
```

### Folder and File Structure

In frontend apps, each route should have its own folder under `app/routes/`. why folder is because all componenst related to this route should be colocated in this folder. You might also notice we have `components` folder under `app/` this folder is for components that are shared across multiple routes.

### Small Components

Always break down components into smaller components and colocate them in the same folder as the route. Those broken down components should be autonomous on their own logic, state management and accepts props.

- **Extract sub-components** - When a component has distinct UI sections (cards, forms, selectors), extract each into its own function in the same file.

- **Sub-components own their data** - Each sub-component should fetch its own data via `useData()` if needed, rather than having the parent fetch and pass down.

- **Inline loading states** - Don't early-return loading states in parent; let each sub-component handle its own loading UI inline (e.g., disabled Select with "Loading..." placeholder).

- **Colocate in same file** - Keep sub-components in the same file as the parent. Only move to separate files if reused across multiple routes.

### React Component Architecture

- **Keep components in the same file** - When breaking down large components, create smaller React function components in the same file. Do NOT create new files unless the component is reused across multiple files.
- **Components should own their state** - Avoid passing callbacks as props. Move logic into the component that uses it to avoid prop drilling.
- **Proactively breakdown large components** - If a component is getting large, split it into smaller components in the same file separated by regions.

## Testing

- **Do NOT write tests during feature implementation** unless explicitly asked. Complete the feature first, test later.
- Focus on **integration tests** that test entire flows, not unit tests for individual functions.

### Loading Buttons

Use `Button` and `Spinner` from `@deepagents/react-shadcn` for buttons that trigger async operations and need to show loading state.

### Local Database

The backend keeps its data in one SQLite file. `EVALS_DB_PATH` sets the path of that file. When `EVALS_DB_PATH` is not set, the path is `.evals/store.db` in the working directory of the backend. To debug, open this file and examine the data.

## UI Skills

Opinionated constraints for building better interfaces with agents.

### Shadcn UI

All components are exported from `packages/react/shadcn/src/index.ts` and imported from `@deepagents/react-shadcn`. The package uses Base UI as its primitive foundation.

Always make sure to make extensive use of existing components before creating new ones.

### Stack

- MUST use Tailwind CSS defaults (spacing, radius, shadows) before custom values
- MUST use `motion/react` (formerly `framer-motion`) when JavaScript animation is required
- SHOULD use `tw-animate-css` for entrance and micro-animations in Tailwind CSS
- MUST use `cn` utility (`clsx` + `tailwind-merge`) for class logic

### Components

- MUST use accessible component primitives for anything with keyboard or focus behavior (`Base UI`, `React Aria`, `Radix`)
- MUST use the project's existing component primitives first
- NEVER mix primitive systems within the same interaction surface
- SHOULD prefer [Base UI](https://base-ui.com/react/components) for new primitives if compatible with the stack
- MUST add an `aria-label` to icon-only buttons
- NEVER rebuild keyboard or focus behavior by hand unless explicitly requested

### Interaction

- MUST use an `AlertDialog` for destructive or irreversible actions
- SHOULD use structural skeletons for loading states
- NEVER use `h-screen`, use `h-dvh`
- MUST respect `safe-area-inset` for fixed elements
- MUST show errors next to where the action happens
- NEVER block paste in `input` or `textarea` elements

### Animation

- NEVER add animation unless it is explicitly requested
- MUST animate only compositor props (`transform`, `opacity`)
- NEVER animate layout properties (`width`, `height`, `top`, `left`, `margin`, `padding`)
- SHOULD avoid animating paint properties (`background`, `color`) except for small, local UI (text, icons)
- SHOULD use `ease-out` on entrance
- NEVER exceed `200ms` for interaction feedback
- MUST pause looping animations when off-screen
- MUST respect `prefers-reduced-motion`
- NEVER introduce custom easing curves unless explicitly requested
- SHOULD avoid animating large images or full-screen surfaces

### Typography

- MUST use `text-balance` for headings and `text-pretty` for body/paragraphs
- MUST use `tabular-nums` for data
- SHOULD use `truncate` or `line-clamp` for dense UI
- NEVER modify `letter-spacing` (`tracking-`) unless explicitly requested

### Layout

- MUST use a fixed `z-index` scale (no arbitrary `z-x`)
- SHOULD use `size-x` for square elements instead of `w-x` + `h-x`

### Performance

- NEVER animate large `blur()` or `backdrop-filter` surfaces
- NEVER apply `will-change` outside an active animation
- NEVER use `useEffect` for anything that can be expressed as render logic

### Design

- NEVER use gradients unless explicitly requested
- NEVER use purple or multicolor gradients
- NEVER use glow effects as primary affordances
- SHOULD use Tailwind CSS default shadow scale unless explicitly requested
- MUST give empty states one clear next action
- SHOULD limit accent color usage to one per view
- SHOULD use existing theme or Tailwind CSS color tokens before introducing new ones
