import type { FC, Child } from 'hono/jsx';

const navItems = [
  { href: '/suites', label: 'Suites' },
  { href: '/runs', label: 'Runs' },
  { href: '/datasets', label: 'Datasets' },
  { href: '/prompts', label: 'Prompts' },
  { href: '/evals/new', label: 'New Eval' },
];

export const Layout: FC<{ title?: string; children: Child }> = ({ title, children }) => (
  <div class="flex min-h-screen bg-base-200">
    <nav class="w-56 shrink-0 border-r border-base-content/10 bg-base-100 px-4 py-6">
      <a href="/suites" class="block text-lg font-bold mb-8">
        Evals Dashboard
      </a>
      <ul class="menu menu-sm">
        {navItems.map((item) => (
          <li>
            <a href={item.href}>{item.label}</a>
          </li>
        ))}
      </ul>
    </nav>
    <main class="flex-1 p-8">
      {title && <h1 class="text-2xl font-bold mb-6">{title}</h1>}
      {children}
    </main>
  </div>
);
