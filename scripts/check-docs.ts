// Docs gate: every page in docs/de and docs/en links its counterpart in the other language and
// back, each pair and the README's `## Deutsch` and `## English` halves have the same headings per
// level, the README halves link only pages of their own language, and every relative link and
// #anchor in the user docs resolves. Runs in CI and the pre-push hook.
// Usage: node scripts/check-docs.ts [root], root defaulting to this repository.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Heading {
  level: number;
  text: string;
  line: number;
}
interface Link {
  target: string;
  line: number;
}
interface Page {
  headings: Heading[];
  links: Link[];
  slugs: Set<string>;
}

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const deDir = join(root, 'docs', 'de');
const enDir = join(root, 'docs', 'en');
const problems: string[] = [];
const pages = new Map<string, Page>();

// An inline link or image target: `](target)` or `](target "title")`.
const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const show = (file: string) => relative(root, file).split(sep).join('/');

/** GitHub's heading anchor: link markup reduced to its text, punctuation dropped, spaces as `-`. */
function slugOf(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_ -]/gu, '')
    .replace(/ /g, '-');
}

/** The lines of a Markdown file outside fenced code blocks, with their line numbers. */
function proseLines(text: string): { raw: string; line: number }[] {
  const lines: { raw: string; line: number }[] = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((raw, index) => {
    if (/^\s*(`{3}|~{3})/.test(raw)) inFence = !inFence;
    else if (!inFence) lines.push({ raw, line: index + 1 });
  });
  return lines;
}

/** GitHub's anchors for these headings: a repeated slug gets `-1`, `-2`, … appended. */
function slugsOf(headings: Heading[]): Set<string> {
  const seen = new Map<string, number>();
  const slugs = new Set<string>();
  for (const { text } of headings) {
    const base = slugOf(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${String(count)}`);
  }
  return slugs;
}

/** Headings and links of a Markdown file, ignoring fenced code blocks and inline code. */
function parse(text: string): Page {
  const headings: Heading[] = [];
  const links: Link[] = [];
  for (const { raw, line } of proseLines(text)) {
    const [, hashes, title] = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw) ?? [];
    if (hashes !== undefined) headings.push({ level: hashes.length, text: title ?? '', line });
    for (const [, target] of raw.replace(/`[^`]*`/g, '').matchAll(LINK)) {
      links.push({ target: target ?? '', line });
    }
  }
  return { headings, links, slugs: slugsOf(headings) };
}

function page(file: string): Page {
  let parsed = pages.get(file);
  if (parsed === undefined) {
    parsed = parse(readFileSync(file, 'utf8'));
    pages.set(file, parsed);
  }
  return parsed;
}

/** The file a relative link points to, or undefined for an external link. */
function linkedFile(file: string, target: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
  const path = decodeURIComponent(target.split('#')[0] ?? '');
  return path === '' ? file : resolve(dirname(file), path);
}

function checkLinks(file: string): void {
  for (const { target, line } of page(file).links) {
    const linked = linkedFile(file, target);
    if (linked === undefined) continue;
    const where = `${show(file)}:${String(line)}`;
    if (!existsSync(linked)) {
      problems.push(`${where}: link target ${target} does not exist`);
      continue;
    }
    const anchor = target.includes('#')
      ? decodeURIComponent(target.slice(target.indexOf('#') + 1))
      : '';
    if (anchor !== '' && linked.endsWith('.md') && !page(linked).slugs.has(anchor)) {
      problems.push(`${where}: anchor #${anchor} is not a heading of ${show(linked)}`);
    }
  }
}

const levels = (headings: Heading[]) =>
  [1, 2, 3, 4, 5, 6].map((level) => headings.filter((h) => h.level === level).length).join(',');

/** The other-language pages a page links to (its language switch). */
function partnersOf(file: string, otherDir: string): Set<string> {
  const partners = new Set<string>();
  for (const { target } of page(file).links) {
    const linked = linkedFile(file, target);
    if (linked !== undefined && dirname(linked) === otherDir && linked.endsWith('.md')) {
      partners.add(linked);
    }
  }
  return partners;
}

function checkPair(file: string, otherDir: string): void {
  const partners = [...partnersOf(file, otherDir)];
  const partner = partners[0];
  if (partners.length !== 1 || partner === undefined) {
    problems.push(
      `${show(file)}: links ${String(partners.length)} pages in ${show(otherDir)}, expected exactly its counterpart`,
    );
    return;
  }
  if (!existsSync(partner)) return; // reported by checkLinks
  const back = [...partnersOf(partner, dirname(file))];
  if (back.length !== 1 || back[0] !== file) {
    problems.push(`${show(file)}: its counterpart ${show(partner)} does not link back to it alone`);
  } else if (otherDir === enDir && levels(page(file).headings) !== levels(page(partner).headings)) {
    problems.push(
      `${show(file)} and ${show(partner)}: headings per level differ (${levels(page(file).headings)} vs ${levels(page(partner).headings)})`,
    );
  }
}

/** The line ranges of the README's German and English halves, from their `##` headings. */
function readmeHalves(headings: Heading[]): { de: number; en: number; end: number } | undefined {
  const start = (name: string) => headings.find((h) => h.level === 2 && h.text === name)?.line;
  const de = start('Deutsch');
  const en = start('English');
  if (de === undefined || en === undefined || de > en) return undefined;
  return { de, en, end: headings.find((h) => h.level <= 2 && h.line > en)?.line ?? Infinity };
}

/** The README's German and English halves: same headings per level, links to their own language. */
function checkReadme(file: string): void {
  const { headings, links } = page(file);
  const halves = readmeHalves(headings);
  if (halves === undefined) {
    problems.push(`${show(file)}: needs "## Deutsch" followed by "## English"`);
    return;
  }
  const within = (from: number, to: number) => headings.filter((h) => h.line > from && h.line < to);
  const deLevels = levels(within(halves.de, halves.en));
  const enLevels = levels(within(halves.en, halves.end));
  if (deLevels !== enLevels) {
    problems.push(
      `${show(file)}: headings per level differ between Deutsch (${deLevels}) and English (${enLevels})`,
    );
  }
  const ranges = [
    { from: halves.de, to: halves.en, otherDir: enDir },
    { from: halves.en, to: halves.end, otherDir: deDir },
  ];
  for (const { target, line } of links) {
    const otherDir = ranges.find((range) => line > range.from && line < range.to)?.otherDir;
    if (otherDir !== undefined && dirname(linkedFile(file, target) ?? '') === otherDir) {
      problems.push(
        `${show(file)}:${String(line)}: links ${target} from the other language's half`,
      );
    }
  }
}

const markdownIn = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => join(dir, name))
    : [];

const deFiles = markdownIn(deDir);
const enFiles = markdownIn(enDir);
if (deFiles.length === 0) problems.push('docs/de has no Markdown pages');
if (enFiles.length === 0) problems.push('docs/en has no Markdown pages');

const readme = join(root, 'README.md');
const files = [readme, join(root, 'CONTRIBUTING.md'), join(root, 'spec', 'README.md')];
for (const file of [...files, ...deFiles, ...enFiles]) {
  if (existsSync(file)) checkLinks(file);
  else problems.push(`${show(file)} is missing`);
}
if (existsSync(readme)) checkReadme(readme);
for (const file of deFiles) checkPair(file, enDir);
for (const file of enFiles) checkPair(file, deDir);

if (problems.length > 0) {
  console.error(`docs drift:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `docs: ${String(files.length + deFiles.length + enFiles.length)} pages, ${String(deFiles.length)} language pairs in parity, all links resolve`,
);
