import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSkillMarkdown, formatLearnOutput, VALID_LEARN_FORMATS, SKILL_PATH } from './learn.js';

describe('readSkillMarkdown', () => {
  it('reads the content of an existing file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'laurel-learn-'));
    const file = path.join(dir, 'SKILL.md');
    writeFileSync(file, '# hello');
    try {
      expect(readSkillMarkdown(file)).toBe('# hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a descriptive error instead of returning empty/undefined when missing', () => {
    // Bug this guards against: a package published without the `skills`
    // directory (see `files` in package.json) would otherwise make `learn`
    // silently print nothing and exit 0, reporting an unknown/broken state
    // as success.
    const missing = path.join(tmpdir(), 'laurel-proxy-does-not-exist', 'SKILL.md');
    expect(() => readSkillMarkdown(missing)).toThrow(/Skill file not found/);
  });

  it('SKILL_PATH resolves to the real packaged skill file', () => {
    // Guards the dist/cli/commands -> package root path-math directly: this
    // runs against the compiled learn.js during `npm test` (vitest resolves
    // .js imports to the co-located .ts source), so if the relative path
    // math (../../../skills/...) were ever wrong, this is what would catch it.
    expect(() => readSkillMarkdown(SKILL_PATH)).not.toThrow();
    expect(readSkillMarkdown(SKILL_PATH)).toContain('# Laurel Proxy');
  });
});

describe('formatLearnOutput', () => {
  const content = '# Laurel Proxy\n\nSome docs.';

  it('returns raw markdown for the default/table format', () => {
    expect(formatLearnOutput(content, 'table')).toBe(content);
  });

  it('returns raw markdown for agent format too (an agent wants the text itself, not a JSON envelope)', () => {
    expect(formatLearnOutput(content, 'agent')).toBe(content);
  });

  it('wraps content in a JSON object for json format, for parseable programmatic output', () => {
    expect(formatLearnOutput(content, 'json')).toBe(JSON.stringify({ content }));
    expect(JSON.parse(formatLearnOutput(content, 'json'))).toEqual({ content });
  });
});

describe('VALID_LEARN_FORMATS', () => {
  it('accepts json, table, and agent, matching the project-wide convention', () => {
    expect(VALID_LEARN_FORMATS).toContain('json');
    expect(VALID_LEARN_FORMATS).toContain('table');
    expect(VALID_LEARN_FORMATS).toContain('agent');
    expect(VALID_LEARN_FORMATS).not.toContain('yaml');
  });
});
