import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import type { SkillFrontmatter } from './types.js';

export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter;
  contentSha: string;
}

/**
 * Read SKILL.md, parse its YAML frontmatter, and compute a short content hash.
 * If parsing fails we return an empty frontmatter and still hash the raw bytes —
 * a broken frontmatter shouldn't drop the skill from the listing.
 */
export async function parseSkillFile(filePath: string): Promise<ParsedSkillFile> {
  const raw = await readFile(filePath, 'utf8');
  const contentSha = createHash('sha256').update(raw).digest('hex').slice(0, 12);

  try {
    const parsed = matter(raw);
    return {
      frontmatter: (parsed.data ?? {}) as SkillFrontmatter,
      contentSha,
    };
  } catch {
    return { frontmatter: {}, contentSha };
  }
}
