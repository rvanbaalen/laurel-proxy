import type { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the packaged skill file relative to this compiled file's own
 * location, not process.cwd(), so it works under a global npm install,
 * `npx`, or a local checkout alike.
 */
export const SKILL_PATH = path.join(__dirname, '../../../skills/laurel-proxy/SKILL.md');

/** Output formats accepted by `learn`, matching the project-wide convention (see throttle.ts). */
export const VALID_LEARN_FORMATS = ['json', 'table', 'agent'] as const;

/**
 * Reports a failure respecting --format: plain text on stderr for humans,
 * a JSON object on stdout for --format json/agent, matching commands/
 * throttle.ts and commands/messages.ts.
 */
function reportError(message: string, format: string): void {
  if (format === 'json' || format === 'agent') {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(message);
  }
}

/**
 * Reads the skill markdown from disk. Takes the path as a parameter rather
 * than closing over SKILL_PATH so tests can point it at a fixture, and
 * throws on a missing file instead of returning empty.
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
 * Formats skill content for output: raw markdown for `table`/`agent`,
 * since the payload is the content itself; `json` wraps it in an
 * object for a programmatic caller.
 */
export function formatLearnOutput(content: string, format: string): string {
  if (format === 'json') {
    return JSON.stringify({ content });
  }
  return content;
}

/** Registers the `learn` command on the CLI program. */
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
