/**
 * The shared shell of every script: load the environment, check for a
 * database, parse the options strictly, run, and exit with the right code.
 *
 * Options are parsed by `node:util`'s `parseArgs` in strict mode, so a typo
 * or a missing value is an error rather than an option quietly ignored, and
 * an `integer` option must actually be one.
 *
 * `main` receives the parsed options and should import anything that reads
 * the environment (the database above all) dynamically, after it is loaded.
 */
import { loadEnvConfig } from '@next/env';
import { parseArgs } from 'node:util';

type OptionSpec =
  | { type: 'boolean'; short?: string }
  | { type: 'string'; multiple?: false; default?: string }
  | { type: 'string'; multiple: true }
  | { type: 'integer'; default?: number; min?: number };

type OptionValue<S extends OptionSpec> = S extends { type: 'boolean' }
  ? boolean
  : S extends { type: 'string'; multiple: true }
    ? string[]
    : S extends { type: 'integer'; default: number }
      ? number
      : S extends { type: 'integer' }
        ? number | undefined
        : S extends { type: 'string'; default: string }
          ? string
          : string | undefined;

export type ScriptArgs<O extends Record<string, OptionSpec>> = {
  options: { [K in keyof O]: OptionValue<O[K]> };
  positionals: string[];
};

/** A mistake in how the script was called: printed without a stack. */
export class UsageError extends Error {}

export function parseScriptArgs<O extends Record<string, OptionSpec>>(
  specs: O,
  argv: string[],
  allowPositionals: boolean,
): ScriptArgs<O> {
  const config = Object.fromEntries(
    Object.entries(specs).map(([name, spec]) => [
      name,
      spec.type === 'boolean'
        ? { type: 'boolean' as const, ...(spec.short ? { short: spec.short } : {}) }
        : { type: 'string' as const, multiple: spec.type === 'string' && spec.multiple === true },
    ]),
  );
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: config, strict: true, allowPositionals });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const options: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const raw = parsed.values[name];
    if (spec.type === 'boolean') options[name] = raw === true;
    else if (spec.type === 'string') options[name] = raw ?? (spec.multiple ? [] : spec.default);
    else if (raw === undefined) options[name] = spec.default;
    else {
      const value = Number(raw);
      const min = spec.min ?? 0;
      if (!/^-?\d+$/.test(String(raw)) || !Number.isSafeInteger(value) || value < min) {
        throw new UsageError(`--${name} must be an integer of at least ${min}, not "${raw}"`);
      }
      options[name] = value;
    }
  }
  return { options: options as ScriptArgs<O>['options'], positionals: parsed.positionals };
}

/** Write everything already printed before the process exits. */
const flush = (stream: NodeJS.WriteStream) =>
  new Promise<void>((resolve) => stream.write('', () => resolve()));

/**
 * Run a script. `main` returns its exit code, or nothing for success.
 *
 * The process is ended explicitly once `main` settles: an open database
 * connection or a gateway timer would otherwise keep it alive.
 */
export function defineScript<O extends Record<string, OptionSpec>>(
  config: {
    options: O;
    /** Accept arguments that are not options (a subcommand, a code). */
    positionals?: boolean;
    /** Whether the script needs TURSO_DATABASE_URL; true unless said otherwise. */
    database?: boolean;
  },
  main: (args: ScriptArgs<O>) => Promise<number | void>,
): void {
  const run = async () => {
    const args = parseScriptArgs(
      config.options,
      process.argv.slice(2),
      config.positionals ?? false,
    );
    loadEnvConfig(process.cwd());
    if (config.database !== false && !process.env.TURSO_DATABASE_URL) {
      throw new UsageError('TURSO_DATABASE_URL is required (put it in .env.local or export it)');
    }
    return (await main(args)) ?? 0;
  };
  run()
    .catch((error) => {
      console.error(
        error instanceof UsageError ? error.message : error instanceof Error ? error.stack : error,
      );
      return 1;
    })
    .then(async (code) => {
      await Promise.all([flush(process.stdout), flush(process.stderr)]);
      process.exit(code);
    });
}
