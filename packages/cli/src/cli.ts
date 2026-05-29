import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import pc from 'picocolors';
import open from 'open';
import {
  scan,
  groupByName,
  shortenPath,
  distinctRealPaths,
  isRealConflict,
  analyzeMerge,
  enableSkill,
  disableSkill,
  removeSkill,
  snapshotSkill,
  getHistory,
  rollbackSkill,
  type AgentId,
  type MergeCandidate,
  type MergePlanItem,
  type Scope,
  type Skill,
} from '@ai-skillboard/core';
import { buildServer } from '@ai-skillboard/server';
import { resolveSkill } from './resolve.js';

// Read the published version straight from package.json so `--version` can't
// drift from the package. Works both in the monorepo (src/) and the published
// layout, where package.json sits one level above src/.
const { version: pkgVersion } = createRequire(import.meta.url)('../package.json') as { version: string };

const VALID_AGENTS: AgentId[] = ['agents', 'claude-code', 'cursor', 'openclaw', 'codex'];
const VALID_SCOPES: Scope[] = ['user', 'project', 'workspace', 'system'];

const program = new Command();

program
  .name('ai-skillboard')
  .description('Unified skill manager across Claude Code, Cursor, openclaw, and Codex')
  .version(pkgVersion);

program
  .command('ls')
  .description('List skills installed on this machine')
  .option('-a, --agent <agent>', `filter by agent (${VALID_AGENTS.join('|')})`)
  .option('-s, --scope <scope>', `filter by scope (${VALID_SCOPES.join('|')})`)
  .option('--include-disabled', 'include skills that have been disabled', false)
  .option('--json', 'emit raw JSON instead of a table', false)
  .action(async (opts) => {
    const agent = parseAgent(opts.agent);
    const scope = parseScope(opts.scope);
    const result = await scan({ agents: agent ? [agent] : undefined });
    const home = homedir();

    let skills = result.skills;
    if (scope) skills = skills.filter((s) => s.scope === scope);
    if (!opts.includeDisabled) skills = skills.filter((s) => !s.disabled);

    if (opts.json) {
      process.stdout.write(JSON.stringify(skills, null, 2) + '\n');
      return;
    }

    renderTable(skills, home);
    renderSummary(result.skills, result.scopes.length, result.warnings);
  });

program
  .command('groups')
  .description('Show skills grouped by name — surfaces duplicates/conflicts across scopes')
  .option('--only-conflicts', 'show only names with 2+ distinct physical paths (symlinks are deduped)', false)
  .action(async (opts) => {
    const result = await scan();
    const home = homedir();
    let groups = groupByName(result.skills);
    if (opts.onlyConflicts) groups = groups.filter(isRealConflict);

    for (const group of groups) {
      const realCount = distinctRealPaths(group);
      const conflicting = realCount >= 2;
      const header = conflicting
        ? pc.yellow(pc.bold(group.name)) +
          pc.dim(` (${group.members.length} entries, ${realCount} distinct files)`)
        : pc.bold(group.name) +
          (group.members.length > 1
            ? pc.dim(` (${group.members.length} entries — all linked to one file)`)
            : '');
      process.stdout.write(header + '\n');
      for (const m of group.members) {
        const linked = m.realPath !== m.path;
        const flags = [
          m.readOnly ? pc.dim('read-only') : null,
          m.disabled ? pc.red('disabled') : null,
          linked ? pc.dim('→') + ' ' + pc.dim(shortenPath(m.realPath, home)) : null,
        ]
          .filter(Boolean)
          .join(' ');
        process.stdout.write(
          `  ${pc.cyan(m.scopeLabel.padEnd(38))} ${pc.dim(shortenPath(m.path, home))}${
            flags ? '  ' + flags : ''
          }\n`,
        );
      }
    }
  });

program
  .command('disable <skill>')
  .description('Disable a skill by moving it under <scope>/.disabled/')
  .option('-a, --agent <agent>', 'disambiguate by agent')
  .option('-s, --scope <scope>', 'disambiguate by scope')
  .action(async (skillInput, opts) => {
    const skill = await resolveSkill(skillInput, { agent: opts.agent, scope: opts.scope });
    const res = await disableSkill(skill);
    process.stdout.write(
      pc.green('✓ disabled ') + pc.cyan(res.skill.id) + pc.dim(`  → ${res.toPath}\n`),
    );
  });

program
  .command('enable <skill>')
  .description('Re-enable a previously disabled skill')
  .option('-a, --agent <agent>', 'disambiguate by agent')
  .option('-s, --scope <scope>', 'disambiguate by scope')
  .action(async (skillInput, opts) => {
    const skill = await resolveSkill(skillInput, {
      agent: opts.agent,
      scope: opts.scope,
      includeDisabled: true,
    });
    const res = await enableSkill(skill);
    process.stdout.write(
      pc.green('✓ enabled ') + pc.cyan(res.skill.id) + pc.dim(`  → ${res.toPath}\n`),
    );
  });

program
  .command('remove <skill>')
  .description('Remove a skill (moved to ~/.skillboard/trash, can be restored)')
  .option('-a, --agent <agent>', 'disambiguate by agent')
  .option('-s, --scope <scope>', 'disambiguate by scope')
  .action(async (skillInput, opts) => {
    const skill = await resolveSkill(skillInput, {
      agent: opts.agent,
      scope: opts.scope,
      includeDisabled: true,
    });
    const res = await removeSkill(skill);
    process.stdout.write(
      pc.yellow('✓ removed ') + pc.cyan(res.skill.id) + pc.dim(`  → trash:${res.trash.trashPath}\n`),
    );
  });

program
  .command('snapshot <skill>')
  .description('Manually capture the skill\'s current state into version history')
  .option('-a, --agent <agent>', 'disambiguate by agent')
  .option('-s, --scope <scope>', 'disambiguate by scope')
  .option('-m, --message <note>', 'attach a note to this snapshot')
  .action(async (skillInput, opts) => {
    const skill = await resolveSkill(skillInput, {
      agent: opts.agent,
      scope: opts.scope,
      includeDisabled: true,
    });
    const res = await snapshotSkill(skill, { trigger: 'manual-snapshot', userNote: opts.message });
    if (res.changed) {
      process.stdout.write(
        pc.green('✓ snapshot ') + pc.cyan(skill.id) + pc.dim(`  → ${res.commit?.slice(0, 12)}\n`),
      );
    } else {
      process.stdout.write(
        pc.dim('· no changes since last snapshot — logged only\n'),
      );
    }
  });

program
  .command('history <skill>')
  .description('Show version history for a skill (works even after removal)')
  .option('-a, --agent <agent>', 'disambiguate by agent')
  .option('-s, --scope <scope>', 'disambiguate by scope')
  .option('-n, --limit <count>', 'limit number of entries shown', '30')
  .action(async (skillInput, opts) => {
    // History is available even after a skill is removed — the versions repo persists.
    // Accept a raw `agent:scope:name` id directly to support that case.
    const skillId =
      skillInput.split(':').length === 3
        ? skillInput
        : (
            await resolveSkill(skillInput, {
              agent: opts.agent,
              scope: opts.scope,
              includeDisabled: true,
            })
          ).id;
    const history = await getHistory(skillId);
    if (history.length === 0) {
      process.stdout.write(pc.dim('(no history yet — run `ai-skillboard snapshot` first)\n'));
      return;
    }
    const limit = Math.max(1, Number.parseInt(opts.limit, 10) || 30);
    for (const entry of history.slice(0, limit)) {
      const trigger = (entry.meta as { trigger?: string } | null)?.trigger ?? '';
      const note = (entry.meta as { userNote?: string } | null)?.userNote ?? '';
      process.stdout.write(
        pc.yellow(entry.commit.slice(0, 12)) +
          '  ' +
          pc.dim(entry.timestamp) +
          '  ' +
          pc.cyan(trigger.padEnd(16)) +
          '  ' +
          entry.subject +
          (note ? pc.dim(`  — ${note}`) : '') +
          '\n',
      );
    }
  });

program
  .command('rollback <skill> <commit>')
  .description('Restore a skill to an earlier commit from its history')
  .option('-a, --agent <agent>', 'disambiguate by agent')
  .option('-s, --scope <scope>', 'disambiguate by scope')
  .action(async (skillInput, commit, opts) => {
    const skill = await resolveSkill(skillInput, {
      agent: opts.agent,
      scope: opts.scope,
      includeDisabled: true,
    });
    const res = await rollbackSkill(skill, commit);
    process.stdout.write(
      pc.green('✓ rolled back ') + pc.cyan(skill.id) +
        pc.dim(`  → new commit ${res.commit.slice(0, 12)}\n`),
    );
  });

program
  .command('merge-plan')
  .description('Dry-run: report how each conflict would resolve under each merge strategy (no writes)')
  .option(
    '--canonical <path>',
    'canonical root directory used by the "canonical-root" strategy',
    join(homedir(), '.agents', 'skills'),
  )
  .option('--name <name>', 'restrict analysis to a single skill name')
  .option('--json', 'emit raw JSON instead of a formatted report', false)
  .action(async (opts) => {
    const result = await scan();
    const home = homedir();
    process.stdout.write(
      pc.dim(`scanning ${result.skills.length} skills, canonical-root=${shortenPath(opts.canonical, home)}\n\n`),
    );
    let plans = await analyzeMerge(result.skills, opts.canonical);
    if (opts.name) plans = plans.filter((p) => p.name === opts.name);
    if (opts.json) {
      process.stdout.write(JSON.stringify(plans, null, 2) + '\n');
      return;
    }
    renderMergePlan(plans, opts.canonical, home);
  });

program
  .command('serve')
  .description('Start the local web dashboard and open it in a browser')
  .option('-p, --port <port>', 'port to bind on 127.0.0.1', '7300')
  .option('--no-open', "don't auto-launch the default browser")
  .action(async (opts) => {
    const port = Number.parseInt(opts.port, 10) || 7300;
    const app = await buildServer({ cwd: process.cwd() });
    await app.listen({ host: '127.0.0.1', port });
    const url = `http://127.0.0.1:${port}`;
    process.stdout.write(pc.green(`✓ skillboard dashboard at ${url}\n`));
    if (opts.open !== false) {
      open(url).catch(() => {
        process.stdout.write(pc.dim(`(could not auto-open browser; visit ${url} manually)\n`));
      });
    }
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(pc.red(`✗ ${(err as Error).message}\n`));
  process.exit(1);
});

function parseAgent(input: string | undefined): AgentId | null {
  if (!input) return null;
  if (!VALID_AGENTS.includes(input as AgentId)) {
    throw new Error(`unknown agent: ${input} (expected one of ${VALID_AGENTS.join(', ')})`);
  }
  return input as AgentId;
}

function parseScope(input: string | undefined): Scope | null {
  if (!input) return null;
  if (!VALID_SCOPES.includes(input as Scope)) {
    throw new Error(`unknown scope: ${input} (expected one of ${VALID_SCOPES.join(', ')})`);
  }
  return input as Scope;
}

function renderTable(skills: Skill[], home: string) {
  if (skills.length === 0) {
    process.stdout.write(pc.dim('(no skills found)\n'));
    return;
  }

  const rows = skills.map((s) => ({
    name: s.name,
    scope: s.scopeLabel,
    version: typeof s.frontmatter.version === 'string' ? s.frontmatter.version : '',
    sha: s.contentSha ?? '',
    flags: [s.disabled ? 'disabled' : '', s.readOnly ? 'read-only' : ''].filter(Boolean).join(','),
    path: shortenPath(s.path, home),
  }));

  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    scope: Math.max(5, ...rows.map((r) => r.scope.length)),
    version: Math.max(3, ...rows.map((r) => r.version.length)),
    sha: 12,
    flags: Math.max(0, ...rows.map((r) => r.flags.length)),
  };

  const header = [
    pad('NAME', widths.name),
    pad('SCOPE', widths.scope),
    pad('VERSION', widths.version),
    pad('SHA', widths.sha),
    widths.flags > 0 ? pad('FLAGS', widths.flags) : '',
    'PATH',
  ]
    .filter(Boolean)
    .join('  ');
  process.stdout.write(pc.bold(header) + '\n');

  rows.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));

  for (const r of rows) {
    const line = [
      pc.cyan(pad(r.name, widths.name)),
      pad(r.scope, widths.scope),
      pad(r.version, widths.version),
      pc.dim(pad(r.sha, widths.sha)),
      widths.flags > 0 ? (r.flags ? pc.red(pad(r.flags, widths.flags)) : pad('', widths.flags)) : '',
      pc.dim(r.path),
    ]
      .filter(Boolean)
      .join('  ');
    process.stdout.write(line + '\n');
  }
}

function renderSummary(allSkills: Skill[], scopeCount: number, warnings: string[]) {
  const byAgent = new Map<string, number>();
  for (const s of allSkills) byAgent.set(s.agent, (byAgent.get(s.agent) ?? 0) + 1);
  const summary = [...byAgent.entries()]
    .map(([a, n]) => `${a}=${n}`)
    .join(' ');
  process.stdout.write(
    '\n' + pc.dim(`${allSkills.length} skills across ${scopeCount} scopes (${summary})`) + '\n',
  );
  for (const w of warnings) process.stderr.write(pc.yellow(`! ${w}\n`));
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatMtime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

function actionDescription(action: MergePlanItem['safeHybridAction']): string {
  switch (action) {
    case 'silent-merge':
      return 'auto: contents identical, canonical wins — replace others with symlinks';
    case 'diff-then-pick':
      return 'manual: contents differ — show diff, ask user which becomes canonical';
    case 'no-canonical':
      return 'manual: no candidate lives in canonical root — ask user to pick winner';
    case 'ambiguous-canonical':
      return 'manual: multiple candidates already in canonical root — ask user to pick';
  }
}

function actionColor(action: MergePlanItem['safeHybridAction']): (s: string) => string {
  switch (action) {
    case 'silent-merge':
      return pc.green;
    case 'diff-then-pick':
      return pc.yellow;
    case 'no-canonical':
    case 'ambiguous-canonical':
      return pc.cyan;
  }
}

function renderMergePlan(plans: MergePlanItem[], canonicalRoot: string, home: string) {
  if (plans.length === 0) {
    process.stdout.write(pc.green('✓ no real conflicts — every conflicting name resolves to a single physical file\n'));
    return;
  }

  for (const plan of plans) {
    const totalEntries = plan.candidates.reduce((acc, c) => acc + c.members.length, 0);
    const header =
      pc.yellow(pc.bold(plan.name)) +
      pc.dim(
        `  ·  ${totalEntries} entries → ${plan.candidates.length} distinct files  ·  contents: ${
          plan.contentsIdentical ? pc.green('IDENTICAL') : pc.red('DIFFER')
        }`,
      );
    process.stdout.write(header + '\n');

    for (let i = 0; i < plan.candidates.length; i++) {
      const c = plan.candidates[i]!;
      const tag = String.fromCharCode(65 + i); // A, B, C, ...
      const canonicalTag = c.inCanonicalRoot ? pc.green(' [canonical]') : '';
      const newestTag = plan.newestWinner === c ? pc.cyan(' [newest]') : '';
      process.stdout.write(
        `  ${pc.bold(tag)}  ${pc.dim(shortenPath(c.realPath, home))}${canonicalTag}${newestTag}\n`,
      );
      process.stdout.write(
        pc.dim(
          `      mtime ${formatMtime(c.mtime)}  ·  ${humanSize(c.sizeBytes)}  ·  ${c.fileCount} files  ·  dir-sha ${c.dirSha.slice(0, 12)}\n`,
        ),
      );
      for (const m of c.members) {
        process.stdout.write(pc.dim(`      ↳ referenced by `) + pc.cyan(m.scopeLabel) + '\n');
      }
    }

    const labelLine = (label: string, winner: MergeCandidate | null, note?: string): string => {
      const tagIndex = winner ? plan.candidates.indexOf(winner) : -1;
      const value =
        tagIndex >= 0
          ? `${String.fromCharCode(65 + tagIndex)} wins (${shortenPath(winner!.realPath, home)})`
          : note ?? '—';
      return `      ${pc.dim(label.padEnd(22))} ${value}`;
    };

    process.stdout.write('    ' + pc.bold('strategies') + '\n');
    process.stdout.write(labelLine('newest-mtime', plan.newestWinner) + '\n');
    process.stdout.write(
      labelLine(
        'canonical-root',
        plan.canonicalWinner,
        plan.hasCanonicalCandidate
          ? pc.red(`${plan.candidates.filter((c) => c.inCanonicalRoot).length} candidates already in canonical — ambiguous`)
          : pc.red(`no candidate in ${shortenPath(canonicalRoot, home)}`),
      ) + '\n',
    );
    process.stdout.write(
      `      ${pc.dim('safe-hybrid'.padEnd(22))} ${actionColor(plan.safeHybridAction)(plan.safeHybridAction)}  ${pc.dim(actionDescription(plan.safeHybridAction))}\n`,
    );

    process.stdout.write('\n');
  }

  // --- Summary ---
  const counts: Record<MergePlanItem['safeHybridAction'], number> = {
    'silent-merge': 0,
    'diff-then-pick': 0,
    'no-canonical': 0,
    'ambiguous-canonical': 0,
  };
  for (const p of plans) counts[p.safeHybridAction] += 1;

  process.stdout.write(pc.bold('summary (safe-hybrid strategy)\n'));
  process.stdout.write(
    `  ${pc.green(`auto-mergeable           ${counts['silent-merge']}`)}\n`,
  );
  process.stdout.write(
    `  ${pc.yellow(`needs diff + manual pick ${counts['diff-then-pick']}`)}\n`,
  );
  process.stdout.write(
    `  ${pc.cyan(`no canonical candidate   ${counts['no-canonical']}`)}\n`,
  );
  process.stdout.write(
    `  ${pc.cyan(`canonical is ambiguous   ${counts['ambiguous-canonical']}`)}\n`,
  );
  process.stdout.write(
    pc.dim(`\n  total real conflicts: ${plans.length}\n  this was a dry run — no files were changed.\n`),
  );
}
