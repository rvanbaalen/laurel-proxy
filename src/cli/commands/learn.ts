import type { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves to the packaged skill file relative to this compiled file's own
 * location (dist/cli/commands/learn.js) rather than process.cwd() — so it
 * resolves correctly no matter where laurel-proxy is invoked from: a global
 * npm install, `npx`, or a local checkout. dist/cli/commands is three levels
 * below the package root, and skills/laurel-proxy/SKILL.md is packaged
 * alongside dist (see the `files` field in package.json — it must list
 * `skills`, or a global install has nothing here to read).
 */
export const SKILL_PATH = path.join(__dirname, '../../../skills/laurel-proxy/SKILL.md');

/** Output formats accepted by `learn`, matching the project-wide convention (see throttle.ts). */
export const VALID_LEARN_FORMATS = ['json', 'table', 'agent'] as const;

/**
 * Reports a failure respecting --format, matching the convention established
 * in commands/throttle.ts and commands/messages.ts: plain text on stderr for
 * humans, a JSON object on stdout for --format json/agent, so a script or AI
 * agent always gets parseable output on a failure path too.
 */
function reportError(message: string, format: string): void {
  if (format === 'json' || format === 'agent') {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(message);
  }
}

/**
 * Reads the skill markdown from disk. Takes the path as a parameter (rather
 * than closing over SKILL_PATH) so tests can point it at a fixture without
 * depending on the compiled dist layout existing.
 *
 * Throws instead of returning empty/undefined when the file is missing, so
 * a broken package (e.g. `files` not listing `skills`) fails loudly with a
 * clear message rather than the command silently printing nothing and
 * exiting 0 — this project's standard is to never report unknown/partial
 * state as success.
 */
export function readSkillMarkdown(skillPath: string): string {
  if (!existsSync(skillPath)) {
    throw new Error(
      `Skill file not found at ${skillPath}. If this is an installed package, it may be missing the "skills" directory (packaging bug) — please report it.`,
    );
  }
  return readFileSync(skillPath, 'utf8');
}

/**
 * Formats skill content for output. Raw markdown for `table`/`agent` (and
 * the default) — the payload *is* the content, there's no tabular data to
 * render, and an agent reading instructions wants the text itself, not a
 * JSON envelope around it. `json` wraps it in an object so a programmatic
 * caller gets something parseable instead of a bare markdown blob mixed
 * into whatever else it's consuming.
 */
export function formatLearnOutput(content: string, format: string): string {
  if (format === 'json') {
    return JSON.stringify({ content });
  }
  return content;
}

export function registerLearn(program: Command): void {
  program
    .command('learn')
    .description('Print the Laurel Proxy skill documentation, for an AI agent (or human) to learn how to drive this tool')
    .option('--format <format>', 'Output format (json|table|agent)', 'table')
    .action((opts) => {
      if (!(VALID_LEARN_FORMATS as readonly string[]).includes(opts.format)) {
        console.error(`Invalid format "${opts.format}". Valid formats: ${VALID_LEARN_FORMATS.join(', ')}`);
        process.exit(1);
        return;
      }

      try {
        const content = readSkillMarkdown(SKILL_PATH);
        console.log(formatLearnOutput(content, opts.format));
      } catch (err) {
        reportError((err as Error).message, opts.format);
        process.exit(1);
      }
    });
}
