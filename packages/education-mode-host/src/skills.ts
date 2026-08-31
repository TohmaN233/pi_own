import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModeResourceSet } from '../../profile-resource-host/src/mode-packs.ts';
import { EducationModeError, EDUCATION_SKILLS } from './index.ts';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
const SKILL_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface LoadedEducationSkill {
  id: string;
  title: string;
  description: string;
  body: string;
  filePath: string;
  contentHash: string;
}

export interface EducationSkillLoadResult {
  required: LoadedEducationSkill[];
  optional: LoadedEducationSkill[];
  degradedOptional: string[];
  promptBlock: string;
  receipt: EducationSkillLoadReceipt;
}

export interface EducationSkillLoadReceipt {
  version: 1;
  required: Array<{ id: string; contentHash: string }>;
  optional: Array<{ id: string; contentHash: string }>;
  degradedOptional: string[];
  promptHash: string;
  loadedAt: string;
}

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function parseQuotedValue(line: string, key: string): string {
  const prefix = `${key}:`;
  if (!line.startsWith(prefix)) throw new EducationModeError('INVALID_SKILL_FRONTMATTER', key);
  const raw = line.slice(prefix.length).trim();
  if (!raw) throw new EducationModeError('INVALID_SKILL_FRONTMATTER', key);
  if (raw.startsWith('"')) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'string' || !parsed.trim()) throw new Error('empty');
      return parsed;
    } catch {
      throw new EducationModeError('INVALID_SKILL_FRONTMATTER', key);
    }
  }
  if (/^[A-Za-z0-9._ -]+$/.test(raw)) return raw;
  throw new EducationModeError('INVALID_SKILL_FRONTMATTER', key);
}

function parseSkillFile(id: string, filePath: string, source: string): LoadedEducationSkill {
  const normalized = source.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) throw new EducationModeError('INVALID_SKILL_FRONTMATTER', id);
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) throw new EducationModeError('INVALID_SKILL_FRONTMATTER', id);
  const frontmatterLines = normalized.slice(4, end).split('\n').filter(Boolean);
  if (frontmatterLines.length !== 3) throw new EducationModeError('INVALID_SKILL_FRONTMATTER', id);
  const parsedName = parseQuotedValue(frontmatterLines[0], 'name');
  const title = parseQuotedValue(frontmatterLines[1], 'title');
  const description = parseQuotedValue(frontmatterLines[2], 'description');
  if (parsedName !== id) throw new EducationModeError('SKILL_ID_MISMATCH', `${id}:${parsedName}`);
  const body = normalized.slice(end + 5).trim();
  if (!body) throw new EducationModeError('EMPTY_SKILL', id);
  return {
    id,
    title,
    description,
    body,
    filePath,
    contentHash: hash(normalized),
  };
}

export function loadEducationSkill(id: string): LoadedEducationSkill {
  if (!SKILL_ID.test(id) || !EDUCATION_SKILLS[id]) throw new EducationModeError('UNKNOWN_EDUCATION_SKILL', id);
  const expectedDirectory = resolve(SKILL_ROOT, id);
  const filePath = join(expectedDirectory, 'SKILL.md');
  let realFilePath: string;
  try {
    realFilePath = realpathSync(filePath);
  } catch {
    throw new EducationModeError('EDUCATION_SKILL_MISSING', id);
  }
  const rel = relative(SKILL_ROOT, realFilePath);
  if (!rel || rel.startsWith('..') || resolve(SKILL_ROOT, rel) !== realFilePath) {
    throw new EducationModeError('EDUCATION_SKILL_PATH_ESCAPE', id);
  }
  return parseSkillFile(id, realFilePath, readFileSync(realFilePath, 'utf8'));
}

function formatPrompt(required: readonly LoadedEducationSkill[], optional: readonly LoadedEducationSkill[]): string {
  return [...required, ...optional]
    .map(
      (skill) =>
        `## Loaded education Skill: ${skill.id}\n\n${skill.body}\n\n[Skill content hash: ${skill.contentHash}]`,
    )
    .join('\n\n---\n\n');
}

export function loadEducationSkillSet(
  resources: ModeResourceSet,
  options: { loadedAt?: string } = {},
): EducationSkillLoadResult {
  const required = resources.required.map(loadEducationSkill);
  const optional: LoadedEducationSkill[] = [];
  const degradedOptional: string[] = [];
  for (const id of resources.optional) {
    try {
      optional.push(loadEducationSkill(id));
    } catch (error) {
      if (error instanceof EducationModeError && error.code === 'EDUCATION_SKILL_MISSING') {
        degradedOptional.push(id);
        continue;
      }
      throw error;
    }
  }
  const promptBlock = formatPrompt(required, optional);
  const loadedAt = options.loadedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(loadedAt))) throw new EducationModeError('INVALID_TIMESTAMP', loadedAt);
  return {
    required,
    optional,
    degradedOptional,
    promptBlock,
    receipt: {
      version: 1,
      required: required.map((skill) => ({ id: skill.id, contentHash: skill.contentHash })),
      optional: optional.map((skill) => ({ id: skill.id, contentHash: skill.contentHash })),
      degradedOptional,
      promptHash: hash(promptBlock),
      loadedAt,
    },
  };
}

export function verifyEducationSkillLoadReceipt(
  resources: ModeResourceSet,
  receipt: EducationSkillLoadReceipt,
): void {
  const current = loadEducationSkillSet(resources, { loadedAt: receipt.loadedAt });
  if (JSON.stringify(current.receipt) !== JSON.stringify(receipt)) {
    throw new EducationModeError('SKILL_LOAD_RECEIPT_MISMATCH', 'Education Skill set changed or was not fully loaded.');
  }
}
