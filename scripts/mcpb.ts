// The Claude Desktop extension (.mcpb, decision 24 addendum): the npm package as it is published,
// installed under the bundle's node_modules, so it runs as an installed package (`launchKind()` is
// `npx`: exactly `search` and `execute`), with a manifest whose form asks for the API token.
// Claude Desktop keeps the token in the OS keychain and starts the server with it in
// SEVDESK_API_TOKEN (decision 2); its built-in Node.js runs the entry, so users install nothing else.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packExtension } from '@anthropic-ai/mcpb/cli';

/** The fields of package.json the bundle and its manifest are made from. */
export interface PackageJson {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  keywords: string[];
  homepage: string;
  repository: { type: string; url: string };
  bugs: { url: string };
  bin: Record<string, string>;
  files: string[];
  engines: { node: string };
}

/** The bundle's file name, the same for every version, so a link to the latest release's asset lasts. */
export const MCPB_FILE = 'sevdesk-mcp.mcpb';

// The profile name of the token the form asks for: the audit log's profile and the PDF folder
// (~/Downloads/sevdesk/claude-desktop).
const PROFILE = 'claude-desktop';

// sevdesk's privacy policy: the extension sends the account's data to sevdesk and nowhere else.
const SEVDESK_PRIVACY_POLICY = 'https://sevdesk.de/datenschutz/';

const root = fileURLToPath(new URL('..', import.meta.url));

/** This repository's package.json. */
export function readPackage(): PackageJson {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
}

/** The package's CLI entry, relative to the bundle root: its only `bin`, under node_modules. */
function entryOf(pkg: PackageJson): string {
  const [bin, ...more] = Object.values(pkg.bin);
  if (bin === undefined || more.length > 0)
    throw new Error('package.json must have exactly one bin');
  return `node_modules/${pkg.name}/${bin.replace(/^\.\//, '')}`;
}

/**
 * The extension's manifest (MCPB 0.3): everything but the form and sevdesk's privacy policy taken
 * from package.json.
 */
export function mcpbManifest(pkg: PackageJson) {
  const entry = entryOf(pkg);
  return {
    manifest_version: '0.3',
    name: pkg.name.replace(/^@[^/]+\//, ''),
    display_name: 'sevdesk-mcp',
    version: pkg.version,
    description: pkg.description,
    author: { name: pkg.author },
    repository: pkg.repository,
    homepage: pkg.homepage,
    support: pkg.bugs.url,
    license: pkg.license,
    keywords: pkg.keywords,
    // The one service the extension sends account data to.
    privacy_policies: [SEVDESK_PRIVACY_POLICY],
    server: {
      type: 'node',
      entry_point: entry,
      mcp_config: {
        command: 'node',
        args: [`\${__dirname}/${entry}`],
        env: {
          SEVDESK_API_TOKEN: '${user_config.api_token}',
          SEVDESK_READONLY: '${user_config.read_only}',
          SEVDESK_PROFILE: PROFILE,
        },
      },
    },
    user_config: {
      api_token: {
        type: 'string',
        title: 'sevdesk API token',
        description:
          'In sevdesk under Extensions → API. Claude Desktop keeps it in your system keychain; the AI never sees it.',
        sensitive: true,
        required: true,
      },
      read_only: {
        type: 'boolean',
        title: 'Read-only',
        description:
          'Only reads from sevdesk: nothing is created, changed, sent or deleted. One exception: saving the PDF of a draft first renders it again in sevdesk, without changing its status. Recommended while you try it out.',
        default: false,
      },
    },
    compatibility: {
      platforms: ['darwin', 'win32'],
      runtimes: { node: pkg.engines.node },
    },
  };
}

/** Runs a command without a shell; a failure throws with its output. */
function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    // Both are null when the command could not start; join turns null into ''.
    const output = [result.stdout, result.stderr].join('').trim();
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.error?.message ?? `exit ${String(result.status)}`}):\n${output}`,
    );
  }
}

/**
 * Builds the extension into `outDir`/sevdesk-mcp.mcpb and returns its path. The package directory
 * holds what npm publishes (`files`, package.json, README.md, LICENSE) with `dist` compiled anew,
 * and its production dependencies from this repository's bun.lock, without optional ones: the
 * keychain library's native binaries are never loaded with SEVDESK_API_TOKEN set, so one bundle
 * serves Windows and macOS.
 */
export async function buildMcpb(outDir: string): Promise<string> {
  const pkg = readPackage();
  const stage = mkdtempSync(join(tmpdir(), 'sevdesk-mcp-stage-'));
  try {
    const packageDir = join(stage, 'node_modules', ...pkg.name.split('/'));
    mkdirSync(packageDir, { recursive: true });
    for (const name of pkg.files.filter((file) => file !== 'dist')) {
      cpSync(join(root, name), join(packageDir, name), { recursive: true });
    }
    for (const name of ['package.json', 'README.md', 'LICENSE', 'bun.lock']) {
      copyFileSync(join(root, name), join(packageDir, name));
    }
    run('bun', ['run', 'build', '--outDir', join(packageDir, 'dist')], root);
    run(
      'bun',
      ['install', '--production', '--frozen-lockfile', '--ignore-scripts', '--omit=optional'],
      packageDir,
    );
    rmSync(join(packageDir, 'bun.lock'));
    writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(mcpbManifest(pkg), null, 2)}\n`);

    const file = join(outDir, MCPB_FILE);
    if (!(await packExtension({ extensionPath: stage, outputPath: file, silent: true }))) {
      throw new Error(`mcpb could not pack ${stage}`);
    }
    return file;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
