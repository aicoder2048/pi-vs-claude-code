import { describe, expect, test } from 'bun:test';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { REQUIRED_SKILLS } from '../src/business/types.ts';

const app = resolve(import.meta.dir, '..');
const forbiddenSDK = /^@(?:earendil-works|mariozechner)\/pi-/;

async function files(pattern: string): Promise<string[]> {
  return Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: app, onlyFiles: true }));
}

function imports(path: string, text: string): { module: string; runtime: boolean }[] {
  const result: { module: string; runtime: boolean }[] = [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly = clause?.isTypeOnly || clause && !clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly);
      result.push({ module: node.moduleSpecifier.text, runtime: !typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const typeOnly = node.isTypeOnly || clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly);
      result.push({ module: node.moduleSpecifier.text, runtime: !typeOnly });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteral(expression)) result.push({ module: expression.text, runtime: !node.isTypeOnly });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const argument = node.arguments[0];
      result.push({ module: argument && ts.isStringLiteral(argument) ? argument.text : '<computed>', runtime: true });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}

describe('four-layer architecture', () => {
  test('manifest and application imports contain no Pi SDK dependency', async () => {
    const manifest = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const dependency of Object.keys(manifest[section] ?? {})) expect(dependency).not.toMatch(forbiddenSDK);
    }
    for (const path of await files('{src,renderer,extensions,scripts}/**/*.{ts,tsx}')) {
      for (const dependency of imports(path, await readFile(join(app, path), 'utf8'))) {
        expect(dependency.module, path).not.toMatch(forbiddenSDK);
        expect(dependency.module, path).not.toBe('<computed>');
      }
    }
  });

  test('L3 has no runtime imports outside its data-access directory', async () => {
    const business = await files('src/business/**/*.{ts,tsx}');
    expect(business.length).toBeGreaterThan(0);
    for (const path of business) {
      const dataAccess = path.startsWith('src/business/market-data/');
      for (const dependency of imports(path, await readFile(join(app, path), 'utf8'))) {
        expect(dependency.module, path).not.toMatch(/^(?:electron|@.*\/pi-|.*src\/agent)/);
        if (!dataAccess) expect(dependency.runtime, `${path} imports ${dependency.module}`).toBe(false);
        if (dataAccess) {
          expect(dependency.module, path).not.toBe('<computed>');
          expect(dependency.module, path).not.toMatch(/(?:^|\/)agent(?:\/|$)|^electron$/);
        }
      }
    }
  });

  test('renderer imports only types from host code and never uses Node or Electron', async () => {
    for (const path of await files('renderer/**/*.{ts,tsx}')) {
      for (const dependency of imports(path, await readFile(join(app, path), 'utf8'))) {
        expect(dependency.runtime, `${path} imports ${dependency.module}`).toBe(false);
        expect(dependency.module, path).toMatch(/^\.\.\/src\/(?:business\/types|desktop)\.ts$/);
      }
    }
  });
});

describe('native skill knowledge contract', () => {
  test('every skill has valid frontmatter, a matching directory and resolvable local links', async () => {
    const paths = await files('skills/**/SKILL.md');
    expect(paths.length).toBe(REQUIRED_SKILLS.length);
    const names = new Set<string>();
    for (const path of paths) {
      const text = await readFile(join(app, path), 'utf8');
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
      expect(frontmatter, path).toBeDefined();
      const name = /^name: ([a-z0-9-]+)$/m.exec(frontmatter ?? '')?.[1];
      const description = /^description: (.+)$/m.exec(frontmatter ?? '')?.[1];
      expect(name, path).toBe(dirname(path).split(sep).at(-1));
      expect(name?.length, path).toBeLessThanOrEqual(64);
      expect(description?.trim().length, path).toBeGreaterThan(0);
      expect(description?.length, path).toBeLessThanOrEqual(1024);
      if (!name) throw new Error(`Missing skill name in ${path}.`);
      expect(names.has(name), path).toBe(false);
      names.add(name);
      for (const link of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = resolve(app, dirname(path), link[1]);
        const local = relative(join(app, 'skills'), target);
        expect(local, path).not.toMatch(/^\.\.(?:[\\/]|$)|^[/\\]/);
        await access(target);
      }
    }
    expect([...names].sort()).toEqual([...REQUIRED_SKILLS].sort());
    const entry = await readFile(join(app, 'skills/option-coach/SKILL.md'), 'utf8');
    for (const principle of REQUIRED_SKILLS.filter(name => name.startsWith('principle-'))) {
      expect(entry).toContain(`../${principle}/SKILL.md`);
    }
  });
});
