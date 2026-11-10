import { isAbsolute } from 'node:path';
import { auditDir } from './audit.ts';
import { installedClients, profileEntries, readServers } from './clients.ts';
import {
  type Config,
  configFile,
  loadConfig,
  type ProfileSettings,
  setAudit,
  setProfileKey,
} from './config.ts';
import { type Locale, type MessageKey, t } from './i18n/index.ts';
import { defaultDownloadDir } from './paths.ts';
import {
  runCheck,
  runRegister,
  runRemove,
  runSetup,
  runUnregister,
  type SetupIO,
} from './setup.ts';

// The `config` command (issue #46): an interactive menu over the config file, the OS keychain (only
// through setup's own steps) and the installed MCP clients. Every change is written at once, whole
// or not at all, after the question that leads to it is answered, so leaving it (Esc, q, Ctrl+C)
// never leaves a half-written change.

type Params = Record<string, string>;

/** One entry of a menu: its label, and what it does, resolving to whether that went well. */
interface Action {
  label: string;
  run: () => Promise<boolean> | boolean;
}

/** A menu: its title with `params`, its actions, and the label of its last item, which leaves it. */
interface Menu {
  title: MessageKey;
  params: Params;
  actions: Action[];
  leave: MessageKey;
}

/** The message of a failed write, never anything else the error carries. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `config` menu in `locale`, talking through `io`. */
function menu(locale: Locale, io: SetupIO) {
  const text = (key: MessageKey, params?: Params) => t(locale, key, params);
  const say = (key: MessageKey, params?: Params) => {
    io.print(text(key, params));
  };

  /** The config of the config file, or undefined when it is invalid, reported on `io.fail`. */
  function load(): Config | undefined {
    const loaded = loadConfig();
    if (loaded.ok) return loaded.config;
    io.fail(text('setup.invalidConfig', { message: loaded.error.message }));
    return undefined;
  }

  /**
   * Writes a change to the config file with `write`, then says `done` and that the MCP clients need
   * a restart. A failed write is reported and leaves the file as it was.
   */
  function change(write: () => void, done: MessageKey, params: Params = {}): boolean {
    try {
      write();
    } catch (error) {
      io.fail(text('config.writeFailed', { file: configFile(), reason: reasonOf(error) }));
      return false;
    }
    say(done, params);
    say('config.restart');
    return true;
  }

  /** The lines of the client entries that start `profile`, one per installed client. */
  function clientLines(profile: string): string[] {
    return installedClients().map((installed) => {
      const params = { client: installed.client.name, file: installed.file };
      let servers;
      try {
        servers = readServers(installed).servers;
      } catch (error) {
        return text('config.clientUnreadable', { ...params, reason: reasonOf(error) });
      }
      const entries = profileEntries(servers, profile).map(({ name, kind }) =>
        text('config.entry', {
          entry: name,
          kind: text(kind === 'npx' ? 'config.kindNpx' : 'config.kindLocal'),
        }),
      );
      const shown = entries.length === 0 ? text('config.noEntry') : entries.join(', ');
      return text('config.clientEntries', { ...params, entries: shown });
    });
  }

  /**
   * The overview: the config file, the audit log, and every profile with company, read-only state,
   * download directory and its entries in the installed MCP clients. It reads the config file and
   * the client configs, never the OS keychain.
   */
  function overview(config: Config): void {
    say('config.file', { file: configFile() });
    const audit = text(config.audit ? 'config.on' : 'config.off');
    say('config.audit', { state: audit, dir: auditDir() });
    if (config.profiles.length === 0) say('config.noProfiles');
    if (installedClients().length === 0) say('config.noClients');
    for (const { name, company, readonly, downloadDir } of config.profiles) {
      const access = text(readonly ? 'setup.accessReadonly' : 'setup.accessReadWrite');
      say('setup.listEntry', { profile: name, company, access });
      if (downloadDir === undefined) {
        say('config.downloadsDefault', { dir: defaultDownloadDir(name) });
      } else {
        say('config.downloads', { dir: downloadDir });
      }
      for (const line of clientLines(name)) io.print(line);
    }
  }

  // Set once a menu is cancelled (Ctrl+C, end of input): every menu then leaves at once.
  let cancelled = false;

  /**
   * Shows `menu.actions` under its title with the key hint, and its `leave` item last, and runs the
   * action picked. Resolves to `leave` when the user picks that, goes back or cancels, else to the
   * action's outcome.
   */
  async function pick({ title, params, actions, leave }: Menu): Promise<boolean | 'leave'> {
    const choice = await io.prompter.choose(`${text(title, params)}\n${text('config.keys')}`, [
      ...actions.map(({ label }) => label),
      text(leave),
    ]);
    if (choice === undefined) cancelled = true;
    const action = typeof choice === 'number' ? actions[choice] : undefined;
    return action === undefined ? 'leave' : await action.run();
  }

  /**
   * Shows the menu `next` makes from the config file, again after each action, until the user
   * leaves or cancels or `next` has none. Resolves to whether every action went well and the config
   * file stayed valid.
   */
  async function loop(next: (config: Config) => Menu | undefined): Promise<boolean> {
    let ok = true;
    while (!cancelled) {
      const config = load();
      if (config === undefined) return false;
      const menu = next(config);
      if (menu === undefined) break;
      const outcome = await pick(menu);
      if (outcome === 'leave') break;
      ok = outcome && ok;
    }
    return ok;
  }

  /** Asks for the download directory of `profile` and stores it; it must be an absolute path. */
  async function askDownloadDir({ name, downloadDir }: ProfileSettings): Promise<boolean> {
    const current = downloadDir ?? defaultDownloadDir(name);
    const answer = await io.prompter.ask(text('config.askDownloadDir', { current }));
    if (answer === undefined) {
      io.fail(text('config.cancelled'));
      return false;
    }
    const dir = answer.trim();
    if (dir === '') {
      say('config.unchanged');
      return true;
    }
    if (!isAbsolute(dir)) {
      io.fail(text('config.notAbsolute', { dir }));
      return false;
    }
    return change(
      () => {
        setProfileKey(name, 'downloadDir', dir);
      },
      'config.downloadDirSet',
      {
        profile: name,
        dir,
      },
    );
  }

  /** The actions on `profile`; each resolves to whether it went well. */
  function profileActions(profile: ProfileSettings): Action[] {
    const { name, readonly, downloadDir } = profile;
    const params = { profile: name };
    const actions: Action[] = [
      {
        label: text(readonly ? 'config.makeReadWrite' : 'config.makeReadonly'),
        run: () =>
          change(
            () => {
              setProfileKey(name, 'readonly', !readonly);
            },
            readonly ? 'config.nowReadWrite' : 'config.nowReadonly',
            params,
          ),
      },
      { label: text('config.setDownloadDir'), run: () => askDownloadDir(profile) },
    ];
    if (downloadDir !== undefined) {
      actions.push({
        label: text('config.resetDownloadDir'),
        run: () =>
          change(
            () => {
              setProfileKey(name, 'downloadDir', undefined);
            },
            'config.downloadDirReset',
            {
              ...params,
              dir: defaultDownloadDir(name),
            },
          ),
      });
    }
    actions.push(
      { label: text('config.register'), run: () => runRegister(locale, io, name) },
      { label: text('config.unregister'), run: () => runUnregister(locale, io, name) },
      { label: text('config.check'), run: () => runCheck(locale, io, name) },
      { label: text('config.remove'), run: () => runRemove(locale, io, name) },
    );
    return actions;
  }

  /** The menu of the profile `name`, until the user goes back or the profile is gone. */
  function profileMenu(name: string): Promise<boolean> {
    return loop((config) => {
      const profile = config.profiles.find((entry) => entry.name === name);
      if (profile === undefined) return undefined;
      const params = { profile: name, company: profile.company };
      return {
        title: 'config.profileTitle',
        params,
        actions: profileActions(profile),
        leave: 'config.back',
      };
    });
  }

  /** The main menu's actions: one per profile, add a profile, the audit log switch. */
  function mainActions(config: Config): Action[] {
    return [
      ...config.profiles.map(({ name, company }) => ({
        label: text('config.profileItem', { profile: name, company }),
        run: () => profileMenu(name),
      })),
      { label: text('config.add'), run: () => runSetup(locale, io) },
      {
        label: text(config.audit ? 'config.auditTurnOff' : 'config.auditTurnOn'),
        run: () =>
          change(
            () => {
              setAudit(!config.audit);
            },
            config.audit ? 'config.auditNowOff' : 'config.auditNowOn',
          ),
      },
    ];
  }

  return {
    /**
     * Shows the overview and the main menu until the user leaves. Resolves to whether every action
     * went well and the config file stayed valid.
     */
    run: () =>
      loop((config) => {
        overview(config);
        return {
          title: 'config.mainTitle',
          params: {},
          actions: mainActions(config),
          leave: 'config.quit',
        };
      }),
  };
}

/**
 * Runs `config` in `locale` through `io` (issue #46): an overview of the profiles and the installed
 * MCP clients, and a menu to toggle a profile's read-only flag, set or reset its download directory,
 * register or unregister it in the clients, check its connection, remove it, add a profile (the
 * `setup` dialogue) and toggle the audit log. Resolves to true when the user leaves and every action
 * went well; otherwise it has reported why on `io.fail`.
 */
export function runConfig(locale: Locale, io: SetupIO): Promise<boolean> {
  return menu(locale, io).run();
}
