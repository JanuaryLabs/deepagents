import type { Rule } from 'eslint';

const entry = '@deepagents/experimental/zukhruf';
const define = /^define[A-Z]/;

/**
 * A Zukhruf app is loaded by import, so its layout holds only by a check:
 * each define* function of `@deepagents/experimental/zukhruf` is called once
 * per file, as the file's default export, or as the value its default-exported
 * function returns when the declaration takes arguments.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A Zukhruf define* call is the default export of its file, and a file holds one.',
    },
    messages: {
      notDefault:
        '{{name}}() is the default export of its file: `export default {{name}}(…)`, or the value a default-exported function returns.',
      second:
        'A file holds one Zukhruf define* call; move {{name}}() to its own file.',
    },
    schema: [],
  },
  create(context) {
    const defineReferences = new Map<object, string>();
    const namespaceReferences = new Set<object>();
    const calls: Rule.Node[] = [];

    function defineName(call: Rule.Node): string | undefined {
      if (call.type !== 'CallExpression') return undefined;
      const { callee } = call;
      if (callee.type === 'Identifier') return defineReferences.get(callee);
      if (
        callee.type === 'MemberExpression' &&
        namespaceReferences.has(callee.object) &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        define.test(callee.property.name)
      ) {
        return callee.property.name;
      }
      return undefined;
    }

    return {
      ImportDeclaration(declaration) {
        if (declaration.source.value !== entry) return;
        for (const specifier of declaration.specifiers) {
          const references = context.sourceCode
            .getDeclaredVariables(specifier)
            .flatMap((variable) => variable.references);
          if (specifier.type === 'ImportNamespaceSpecifier') {
            for (const { identifier } of references) {
              namespaceReferences.add(identifier);
            }
          } else if (specifier.type === 'ImportSpecifier') {
            const { imported } = specifier;
            const name =
              imported.type === 'Identifier'
                ? imported.name
                : String(imported.value);
            if (!define.test(name)) continue;
            for (const { identifier } of references) {
              defineReferences.set(identifier, name);
            }
          }
        }
      },
      CallExpression(call) {
        calls.push(call);
      },
      'Program:exit'() {
        const defines = calls.flatMap((node) => {
          const name = defineName(node);
          return name ? [{ node, name }] : [];
        });
        for (const [index, { node, name }] of defines.entries()) {
          if (index > 0) {
            context.report({ node, messageId: 'second', data: { name } });
          } else if (!isDefaultExport(node)) {
            context.report({ node, messageId: 'notDefault', data: { name } });
          }
        }
      },
    };
  },
};

export default rule;

/** `export default define…(…)`, `export default (…) => define…(…)`, or a top-level `return define…(…)` of `export default function`. */
function isDefaultExport(call: Rule.Node): boolean {
  const { parent } = call;
  if (parent?.type === 'ExportDefaultDeclaration') return true;
  if (parent?.type === 'ArrowFunctionExpression' && parent.body === call) {
    return parent.parent?.type === 'ExportDefaultDeclaration';
  }
  if (parent?.type !== 'ReturnStatement') return false;
  const fn = parent.parent?.parent;
  return (
    (fn?.type === 'FunctionDeclaration' ||
      fn?.type === 'FunctionExpression' ||
      fn?.type === 'ArrowFunctionExpression') &&
    fn.parent?.type === 'ExportDefaultDeclaration'
  );
}
