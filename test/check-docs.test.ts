import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// Runs the docs gate through Node's type stripping against a small docs tree in a temp directory.
const script = fileURLToPath(new URL('../scripts/check-docs.ts', import.meta.url));

// A valid tree: an umlaut anchor, a duplicate heading, and a fence whose `#` line and link only
// look like Markdown (on the German side only, so a fence read as Markdown breaks the parity).
const VALID: Record<string, string> = {
  'README.md': `# Title

[Deutsch](#deutsch) · [English](#english)

## Deutsch

### Häufige Fragen

[Seite](docs/de/seite.md#häufige-fragen) · [Mitmachen](CONTRIBUTING.md)

## English

### FAQ

[Page](docs/en/page.md#faq) · [Contributing](CONTRIBUTING.md)
`,
  'CONTRIBUTING.md': '# Contributing\n\n[Spec](spec/README.md#corrections) `[x](nowhere.md)`\n',
  'spec/README.md': '# Spec\n\n## Corrections\n\n## Corrections\n\n[Second](#corrections-1)\n',
  'docs/de/seite.md': `# Seite

**Deutsch** · [English](../en/page.md)

## Häufige Fragen

\`\`\`sh
# not a heading
[x](missing.md)
\`\`\`
`,
  'docs/en/page.md': '# Page\n\n[Deutsch](../de/seite.md) · **English**\n\n## FAQ\n',
};

function check(changes: Record<string, string | undefined> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sevdesk-mcp-docs-'));
  for (const [name, text] of Object.entries({ ...VALID, ...changes })) {
    if (text === undefined) continue;
    mkdirSync(join(root, dirname(name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
}

function edit(name: string, from: string, to: string) {
  const text = VALID[name] ?? '';
  if (!text.includes(from)) throw new Error(`${name} has no ${from}`);
  return { [name]: text.replace(from, to) };
}

test('a consistent docs tree passes', () => {
  const { status, stdout, stderr } = check();

  expect(stderr).toBe('');
  expect(stdout).toContain('1 language pairs in parity');
  expect(status).toBe(0);
});

test.each([
  {
    breakage: 'a missing link target',
    changes: edit('README.md', '[Mitmachen](CONTRIBUTING.md)', '[Mitmachen](CONTRIBUTE.md)'),
    message: 'README.md:9: link target CONTRIBUTE.md does not exist',
  },
  {
    breakage: 'a missing anchor',
    changes: edit('docs/en/page.md', '../de/seite.md)', '../de/seite.md#faq)'),
    message: 'docs/en/page.md:3: anchor #faq is not a heading of docs/de/seite.md',
  },
  {
    breakage: 'a page without its back link',
    changes: edit('docs/en/page.md', '[Deutsch](../de/seite.md)', 'Deutsch'),
    message: 'docs/de/seite.md: its counterpart docs/en/page.md does not link back to it alone',
  },
  {
    breakage: 'a page without a counterpart',
    changes: { 'docs/en/extra.md': '# Extra\n' },
    message: 'docs/en/extra.md: links 0 pages in docs/de, expected exactly its counterpart',
  },
  {
    breakage: 'a pair with different headings',
    changes: { 'docs/en/page.md': `${VALID['docs/en/page.md'] ?? ''}\n## Extra\n` },
    message: 'docs/de/seite.md and docs/en/page.md: headings per level differ',
  },
  {
    breakage: 'README halves with different headings',
    changes: { 'README.md': `${VALID['README.md'] ?? ''}\n### Extra\n` },
    message: 'README.md: headings per level differ between Deutsch',
  },
  {
    breakage: 'a README half linking the other language',
    changes: edit('README.md', '(docs/de/seite.md#häufige-fragen)', '(docs/en/page.md)'),
    message: "README.md:9: links docs/en/page.md from the other language's half",
  },
  {
    breakage: 'a missing CONTRIBUTING.md',
    changes: { 'CONTRIBUTING.md': undefined },
    message: 'CONTRIBUTING.md is missing',
  },
])('$breakage fails the gate', ({ changes, message }) => {
  const { status, stderr } = check(changes);

  expect(stderr).toContain(message);
  expect(status).toBe(1);
});
