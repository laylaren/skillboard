import { useEffect, useMemo, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from './api.js';
import type {
  FileNode,
  HistoryEntry,
  MergeCandidate,
  MergeDiff,
  MergePlanItem,
  MergePlanResponse,
  ProjectCandidate,
  ProjectEntry,
  ProjectsPayload,
  ScanResult,
  Skill,
} from './types.js';
import { useT, useLocale, type Locale } from './i18n/hooks.js';

type DetailTab = 'readme' | 'files' | 'history';

/**
 * Strip a leading YAML frontmatter block from a markdown string. The metadata
 * is already shown as a table above the rendered body, so leaving the raw
 * `---\nname: ...\n---` at the top would just duplicate it.
 */
function stripFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md;
  // Match `---\n<anything>\n---\n?` at the very start, including the trailing
  // newline so we don't leave a stray blank line.
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return md;
  return md.slice(m[0].length);
}

interface Toast {
  kind: 'success' | 'error';
  msg: string;
}

export function App() {
  const t = useT();
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [mergePlan, setMergePlan] = useState<MergePlanResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conflictName, setConflictName] = useState<string | null>(null);
  const [safeMergePreviewOpen, setSafeMergePreviewOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [showDisabled, setShowDisabled] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [projectsPayload, setProjectsPayload] = useState<ProjectsPayload | null>(null);
  const [candidatesModalOpen, setCandidatesModalOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [projectRemoveConfirm, setProjectRemoveConfirm] = useState<ProjectEntry | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, mp] = await Promise.all([api.scan(), api.mergePlan()]);
      setScanResult(r);
      setMergePlan(mp);
    } catch (err) {
      setToast({ kind: 'error', msg: t('toast.scanFailed', { msg: (err as Error).message }) });
    }
  }, [t]);

  const refreshProjects = useCallback(async () => {
    try {
      const p = await api.getProjects();
      setProjectsPayload(p);
    } catch (err) {
      setToast({ kind: 'error', msg: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    refresh();
    // Initial-load only: also pop the candidates modal if there are unseen
    // project candidates. Later refreshes (after user actions) call
    // `refreshProjects()` without auto-opening so a freshly-closed modal stays
    // closed.
    void (async () => {
      try {
        const p = await api.getProjects();
        setProjectsPayload(p);
        if (p.candidates.length > 0) setCandidatesModalOpen(true);
      } catch (err) {
        setToast({ kind: 'error', msg: (err as Error).message });
      }
    })();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  const skills = scanResult?.skills ?? [];

  // Conflict = a name owns 2+ distinct physical paths. Symlinks pointing at
  // the same source dir are deduped — those are the *same* skill exposed to
  // multiple agents, not a real divergence.
  const conflictNames = useMemo(() => {
    const realsByName = new Map<string, Set<string>>();
    for (const s of skills) {
      const set = realsByName.get(s.name) ?? new Set<string>();
      set.add(s.realPath);
      realsByName.set(s.name, set);
    }
    return new Set([...realsByName.entries()].filter(([, set]) => set.size >= 2).map(([n]) => n));
  }, [skills]);

  const safeMergeCount = useMemo(
    () => (mergePlan?.plans ?? []).filter((p) => p.safeHybridAction === 'silent-merge').length,
    [mergePlan],
  );

  const safeMergePlans = useMemo(
    () => (mergePlan?.plans ?? []).filter((p) => p.safeHybridAction === 'silent-merge'),
    [mergePlan],
  );

  const executeSafeMerge = async () => {
    setSafeMergePreviewOpen(false);
    try {
      const res = await api.mergeSafeAll();
      setToast({
        kind: 'success',
        msg: t('toast.mergedOk', {
          n: res.merged.length,
          replaced: res.merged.reduce((a, m) => a + m.replaced, 0),
        }),
      });
      await refresh();
    } catch (err) {
      setToast({ kind: 'error', msg: t('toast.mergeFailed', { msg: (err as Error).message }) });
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills
      .filter((s) => (agentFilter ? s.agent === agentFilter : true))
      .filter((s) => (scopeFilter ? s.scope === scopeFilter : true))
      .filter((s) => (projectFilter ? s.projectLabel === projectFilter : true))
      .filter((s) => (showDisabled ? true : !s.disabled))
      .filter((s) => {
        if (!q) return true;
        if (s.name.toLowerCase().includes(q)) return true;
        const desc = typeof s.frontmatter.description === 'string' ? s.frontmatter.description : '';
        return desc.toLowerCase().includes(q);
      })
      .sort((a, b) => a.scopeLabel.localeCompare(b.scopeLabel) || a.name.localeCompare(b.name));
  }, [skills, query, agentFilter, scopeFilter, projectFilter, showDisabled]);

  const selected = filtered.find((s) => s.id === selectedId) ?? skills.find((s) => s.id === selectedId) ?? null;

  // Counts for sidebar facets.
  const counts = useMemo(() => {
    const byAgent = new Map<string, number>();
    const byScope = new Map<string, number>();
    const byProject = new Map<string, number>();
    for (const s of skills) {
      if (!showDisabled && s.disabled) continue;
      byAgent.set(s.agent, (byAgent.get(s.agent) ?? 0) + 1);
      byScope.set(s.scope, (byScope.get(s.scope) ?? 0) + 1);
      if (s.projectLabel) {
        byProject.set(s.projectLabel, (byProject.get(s.projectLabel) ?? 0) + 1);
      }
    }
    return { byAgent, byScope, byProject };
  }, [skills, showDisabled]);

  // Scopes that exist for the currently-selected agent, ordered by scan
  // appearance and counted. Empty when no agent is selected — that's the
  // "show the scope chip bar" gate (also keeps the bar from showing every
  // possible scope in 'all' mode).
  const agentScopes = useMemo(() => {
    if (!agentFilter) return [] as { scope: string; count: number }[];
    const counts = new Map<string, number>();
    for (const s of skills) {
      if (s.agent !== agentFilter) continue;
      if (!showDisabled && s.disabled) continue;
      counts.set(s.scope, (counts.get(s.scope) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([scope, count]) => ({ scope, count }));
  }, [skills, agentFilter, showDisabled]);

  // If the currently-selected scope is no longer valid for the active agent
  // (e.g. user switched from openclaw → claude-code), drop it. Otherwise the
  // list would silently filter to zero results.
  useEffect(() => {
    if (!scopeFilter) return;
    const valid = agentScopes.some((s) => s.scope === scopeFilter);
    if (!valid) setScopeFilter(null);
  }, [agentScopes, scopeFilter]);

  const runAction = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      setToast({ kind: 'success', msg: t('toast.actionOk', { label }) });
      await refresh();
    } catch (err) {
      setToast({ kind: 'error', msg: t('toast.actionFailed', { label, msg: (err as Error).message }) });
    }
  };

  return (
    <div className="app">
      <Sidebar
        counts={counts}
        agentFilter={agentFilter}
        projectFilter={projectFilter}
        showDisabled={showDisabled}
        onAgent={setAgentFilter}
        onProject={setProjectFilter}
        onToggleDisabled={() => setShowDisabled((v) => !v)}
        projects={projectsPayload?.projects ?? []}
        candidateCount={projectsPayload?.candidates.length ?? 0}
        onAddProject={() => setAddProjectOpen(true)}
        onOpenCandidates={() => setCandidatesModalOpen(true)}
        onRemoveProject={(entry) => setProjectRemoveConfirm(entry)}
        total={skills.length}
      />
      <SkillList
        skills={filtered}
        query={query}
        onQuery={setQuery}
        selectedId={selectedId}
        onSelect={setSelectedId}
        conflictNames={conflictNames}
        onResolveConflict={(name) => setConflictName(name)}
        safeMergeCount={safeMergeCount}
        onMergeSafeAll={() => setSafeMergePreviewOpen(true)}
        agentFilter={agentFilter}
        scopeFilter={scopeFilter}
        onScope={setScopeFilter}
        agentScopes={agentScopes}
      />
      <Detail
        skill={selected}
        onAction={runAction}
        onRefresh={refresh}
      />
      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
      {candidatesModalOpen && projectsPayload && (
        <CandidatesModal
          candidates={projectsPayload.candidates}
          onClose={() => setCandidatesModalOpen(false)}
          onAdded={async () => {
            await Promise.all([refresh(), refreshProjects()]);
          }}
          onError={(msg) => setToast({ kind: 'error', msg })}
        />
      )}
      {addProjectOpen && (
        <AddProjectModal
          onClose={() => setAddProjectOpen(false)}
          onAdded={async () => {
            setAddProjectOpen(false);
            await Promise.all([refresh(), refreshProjects()]);
          }}
          onError={(msg) => setToast({ kind: 'error', msg })}
        />
      )}
      {projectRemoveConfirm && (
        <ConfirmModal
          title={t('projects.removeTitle')}
          body={t('projects.removeConfirm', { label: projectRemoveConfirm.label })}
          confirmLabel={t('projects.remove')}
          cancelLabel={t('projects.cancel')}
          onCancel={() => setProjectRemoveConfirm(null)}
          onConfirm={async () => {
            const entry = projectRemoveConfirm;
            setProjectRemoveConfirm(null);
            try {
              await api.removeProject(entry.path);
              if (projectFilter === entry.label) setProjectFilter(null);
              await Promise.all([refresh(), refreshProjects()]);
            } catch (err) {
              setToast({ kind: 'error', msg: (err as Error).message });
            }
          }}
        />
      )}
      {safeMergePreviewOpen && (
        <SafeMergePreviewModal
          plans={safeMergePlans}
          canonicalRoot={mergePlan?.canonicalRoot ?? '~/.agents/skills'}
          onCancel={() => setSafeMergePreviewOpen(false)}
          onConfirm={executeSafeMerge}
        />
      )}
      {conflictName && (
        <ConflictModal
          name={conflictName}
          plan={mergePlan?.plans.find((p) => p.name === conflictName) ?? null}
          onClose={() => setConflictName(null)}
          onMerged={async () => {
            setConflictName(null);
            await refresh();
            setToast({ kind: 'success', msg: 'merged' });
          }}
          onError={(msg) => setToast({ kind: 'error', msg })}
        />
      )}
    </div>
  );
}

interface SidebarProps {
  counts: {
    byAgent: Map<string, number>;
    byScope: Map<string, number>;
    byProject: Map<string, number>;
  };
  agentFilter: string | null;
  projectFilter: string | null;
  showDisabled: boolean;
  onAgent: (a: string | null) => void;
  onProject: (p: string | null) => void;
  onToggleDisabled: () => void;
  projects: ProjectEntry[];
  candidateCount: number;
  onAddProject: () => void;
  onOpenCandidates: () => void;
  onRemoveProject: (entry: ProjectEntry) => void;
  total: number;
}

function Sidebar({
  counts,
  agentFilter,
  projectFilter,
  showDisabled,
  onAgent,
  onProject,
  onToggleDisabled,
  projects,
  candidateCount,
  onAddProject,
  onOpenCandidates,
  onRemoveProject,
  total,
}: SidebarProps) {
  const t = useT();
  const agents: string[] = ['agents', 'claude-code', 'cursor', 'openclaw', 'codex'];

  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        <div className="brand">
          {t('brand')} <span>· {t('brand.skillCount', { n: total })}</span>
        </div>

        <h2>{t('sidebar.agents')}</h2>
        <div className={`item${agentFilter === null ? ' active' : ''}`} onClick={() => onAgent(null)}>
          <span>{t('sidebar.all')}</span>
          <span className="count">{total}</span>
        </div>
        {agents.map((a) => {
          const n = counts.byAgent.get(a) ?? 0;
          if (n === 0) return null;
          return (
            <div
              key={a}
              className={`item${agentFilter === a ? ' active' : ''}`}
              onClick={() => onAgent(a)}
            >
              <span>{a}</span>
              <span className="count">{n}</span>
            </div>
          );
        })}

        <h2>
          {t('sidebar.projects')}
          {candidateCount > 0 && (
            <span
              className="badge"
              title={t('projects.candidatesTitle', { n: candidateCount })}
              onClick={onOpenCandidates}
              style={{ cursor: 'pointer' }}
            >
              {candidateCount}
            </span>
          )}
        </h2>
        {projects.length === 0 && (
          <div className="item" style={{ color: 'var(--fg-3)', cursor: 'default' }}>
            {t('sidebar.noProjects')}
          </div>
        )}
        {projects.map((p) => {
          const n = counts.byProject.get(p.label) ?? 0;
          return (
            <div
              key={p.label}
              className={`item${projectFilter === p.label ? ' active' : ''}`}
              onClick={() => onProject(projectFilter === p.label ? null : p.label)}
              title={p.path}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.label}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="count">{n}</span>
                <span
                  className="remove-x"
                  title={t('sidebar.removeProjectTitle')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveProject(p);
                  }}
                >
                  ×
                </span>
              </span>
            </div>
          );
        })}
        <div
          className="item add-project"
          onClick={onAddProject}
          style={{ color: 'var(--accent)' }}
        >
          <span>{t('sidebar.addProject')}</span>
        </div>

        <h2>{t('sidebar.view')}</h2>
        <div className={`item${showDisabled ? ' active' : ''}`} onClick={onToggleDisabled}>
          <span>{t('sidebar.showDisabled')}</span>
          <span className="count">{showDisabled ? t('sidebar.on') : t('sidebar.off')}</span>
        </div>
      </div>

      <div className="footer">
        <LangButton />
      </div>
    </aside>
  );
}

function LangButton() {
  const { locale, setLocale } = useLocale();
  const t = useT();
  const next: Locale = locale === 'zh' ? 'en' : 'zh';
  return (
    <button
      className="icon-btn"
      title={t('sidebar.langToggleTitle')}
      onClick={() => setLocale(next)}
      aria-label={t('sidebar.langToggleTitle')}
    >
      {locale === 'zh' ? '中' : 'EN'}
    </button>
  );
}

interface SkillListProps {
  skills: Skill[];
  query: string;
  onQuery: (q: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  conflictNames: Set<string>;
  onResolveConflict: (name: string) => void;
  safeMergeCount: number;
  onMergeSafeAll: () => void;
  agentFilter: string | null;
  scopeFilter: string | null;
  onScope: (s: string | null) => void;
  /** Available scopes for the currently-selected agent, with their counts. */
  agentScopes: { scope: string; count: number }[];
}

function SkillList({
  skills,
  query,
  onQuery,
  selectedId,
  onSelect,
  conflictNames,
  onResolveConflict,
  safeMergeCount,
  onMergeSafeAll,
  agentFilter,
  scopeFilter,
  onScope,
  agentScopes,
}: SkillListProps) {
  const t = useT();
  // Show the scope bar only when an agent is picked AND that agent has at
  // least one scope to filter by. Without an agent the chips would be
  // ambiguous (a user-scope in claude-code ≠ a user-scope in codex).
  const showScopeBar = agentFilter !== null && agentScopes.length > 0;
  return (
    <div className="list">
      <div className="search">
        <input
          type="text"
          placeholder={t('list.searchPlaceholder')}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <label>{t('list.nShown', { n: skills.length })}</label>
      </div>
      {showScopeBar && (
        <div className="scope-bar">
          <span className="scope-bar-label">{t('sidebar.scope')}</span>
          <button
            type="button"
            className={`scope-chip${scopeFilter === null ? ' active' : ''}`}
            onClick={() => onScope(null)}
          >
            {t('sidebar.all')}
          </button>
          {agentScopes.map(({ scope, count }) => (
            <button
              key={scope}
              type="button"
              className={`scope-chip${scopeFilter === scope ? ' active' : ''}`}
              onClick={() => onScope(scopeFilter === scope ? null : scope)}
              title={`${scope} · ${count}`}
            >
              {scope}
              <span className="scope-chip-count">{count}</span>
            </button>
          ))}
        </div>
      )}
      {safeMergeCount > 0 && (
        <div className="merge-banner">
          <span>
            {t('list.mergeBanner', {
              n: safeMergeCount,
              plural:
                safeMergeCount === 1
                  ? t('list.mergeBanner.conflict')
                  : t('list.mergeBanner.conflicts'),
            })}
          </span>
          <button onClick={onMergeSafeAll}>{t('list.mergeBannerCta')}</button>
        </div>
      )}
      <div className="rows">
        {skills.map((s) => {
          const desc = typeof s.frontmatter.description === 'string' ? s.frontmatter.description : '';
          const isConflict = conflictNames.has(s.name);
          return (
            <div
              key={s.id}
              className={`row${selectedId === s.id ? ' selected' : ''}`}
              onClick={() => onSelect(s.id)}
            >
              <div className="top">
                <div>
                  <span className="name">{s.name}</span>
                  <span className="tag">{s.scopeLabel}</span>
                  {s.loaded ? (
                    <span className="tag loaded" title={t('tag.loadedTitle', { agent: s.agent })}>
                      {t('tag.loaded')}
                    </span>
                  ) : (
                    !s.disabled && (
                      <span
                        className="tag shadowed"
                        title={t('tag.shadowedTitle', { agent: s.agent })}
                      >
                        {t('tag.shadowed')}
                      </span>
                    )
                  )}
                  {s.disabled && <span className="tag disabled">{t('tag.disabled')}</span>}
                  {s.readOnly && <span className="tag readonly">{t('tag.readonly')}</span>}
                  {s.realPath !== s.path && (
                    <span className="tag" title={t('tag.linkedTitle', { path: s.realPath })}>
                      {t('tag.linked')}
                    </span>
                  )}
                  {isConflict && (
                    <span
                      className="tag conflict"
                      style={{ cursor: 'pointer' }}
                      title={t('tag.conflictTitle')}
                      onClick={(e) => {
                        e.stopPropagation();
                        onResolveConflict(s.name);
                      }}
                    >
                      {t('tag.conflict')}
                    </span>
                  )}
                </div>
              </div>
              {desc && <div className="desc">{desc}</div>}
            </div>
          );
        })}
        {skills.length === 0 && (
          <div style={{ padding: 16, color: 'var(--fg-3)' }}>{t('list.noMatch')}</div>
        )}
      </div>
    </div>
  );
}

interface DetailProps {
  skill: Skill | null;
  onAction: (label: string, fn: () => Promise<unknown>) => void;
  onRefresh: () => void;
}

function Detail({ skill, onAction, onRefresh }: DetailProps) {
  const t = useT();
  const [tab, setTab] = useState<DetailTab>('readme');
  const [readme, setReadme] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [snapshotPromptOpen, setSnapshotPromptOpen] = useState(false);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [rollbackConfirmCommit, setRollbackConfirmCommit] = useState<string | null>(null);

  useEffect(() => {
    if (!skill) return;
    setTab('readme');
    setReadme(null);
    setHistory([]);
    setSnapshotPromptOpen(false);
    setRemoveConfirmOpen(false);
    setRollbackConfirmCommit(null);
    api.detail(skill.id).then((r) => setReadme(r.skillFileContent ?? ''));
    api.history(skill.id).then((r) => setHistory(r.history));
  }, [skill?.id]);

  if (!skill) {
    return (
      <div className="detail">
        <div className="empty">{t('detail.empty')}</div>
      </div>
    );
  }

  const desc = typeof skill.frontmatter.description === 'string' ? skill.frontmatter.description : '';

  return (
    <div className="detail">
      <div className="head">
        <h1>{skill.name}</h1>
        <div className="meta">{skill.id} · {skill.path}</div>
        {skill.realPath !== skill.path && (
          <div className="meta" style={{ marginTop: 4 }}>
            {t('detail.symlinkTo', { path: skill.realPath })}
          </div>
        )}
        {desc && (
          <div className="meta" style={{ color: 'var(--fg-2)', marginTop: 8 }}>{desc}</div>
        )}
      </div>

      <div className="actions">
        {skill.readOnly ? (
          <button disabled title={t('detail.readOnlyTitle')}>{t('detail.readOnly')}</button>
        ) : skill.disabled ? (
          <button
            className="primary"
            onClick={() => onAction(t('detail.enable'), () => api.enable(skill.id))}
          >
            {t('detail.enable')}
          </button>
        ) : (
          <button onClick={() => onAction(t('detail.disable'), () => api.disable(skill.id))}>
            {t('detail.disable')}
          </button>
        )}
        <button
          onClick={() => setSnapshotPromptOpen(true)}
          disabled={skill.readOnly}
        >
          {t('detail.snapshot')}
        </button>
        <button
          className="danger"
          disabled={skill.readOnly}
          onClick={() => setRemoveConfirmOpen(true)}
        >
          {t('detail.remove')}
        </button>
        <button
          title={
            skill.realPath !== skill.path
              ? t('detail.openFinderTitle', { path: skill.realPath })
              : t('detail.openFinderTitleSimple')
          }
          onClick={() => onAction(t('detail.openFinder'), () => api.reveal(skill.id, 'real'))}
        >
          {t('detail.openFinder')}
        </button>
        {skill.realPath !== skill.path && (
          <button
            title={t('detail.openEntryTitle', { path: skill.path })}
            onClick={() => onAction(t('detail.openEntry'), () => api.reveal(skill.id, 'entry'))}
          >
            {t('detail.openEntry')}
          </button>
        )}
        <button onClick={onRefresh}>{t('detail.refresh')}</button>
      </div>

      <div className="tabs">
        {(['readme', 'files', 'history'] as DetailTab[]).map((tabKey) => (
          <div
            key={tabKey}
            className={`tab${tab === tabKey ? ' active' : ''}`}
            onClick={() => setTab(tabKey)}
          >
            {tabKey === 'readme'
              ? t('tabs.readme')
              : tabKey === 'files'
                ? t('tabs.files')
                : t('tabs.history', { n: history.length })}
          </div>
        ))}
      </div>

      <div className="body">
        {tab === 'readme' &&
          (readme === null ? (
            <div style={{ color: 'var(--fg-3)' }}>{t('readme.loading')}</div>
          ) : (
            <>
              <FrontmatterView fm={skill.frontmatter} />
              {readme === '' ? (
                <div style={{ color: 'var(--fg-3)', marginTop: 12 }}>{t('readme.empty')}</div>
              ) : (
                <div className="md" style={{ marginTop: 12 }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(readme)}</ReactMarkdown>
                </div>
              )}
            </>
          ))}

        {tab === 'files' && <FilesView skillId={skill.id} />}

        {tab === 'history' && (
          <div className="history">
            {history.length === 0 && (
              <div style={{ color: 'var(--fg-3)' }}>{t('history.empty')}</div>
            )}
            {history.map((h, idx) => {
              const trigger = (h.meta as { trigger?: string } | null)?.trigger ?? '';
              const note = (h.meta as { userNote?: string } | null)?.userNote ?? '';
              const isLatest = idx === 0;
              return (
                <div key={h.commit} className="history-row">
                  <span className={`trigger-dot trigger-${trigger || 'unknown'}`} aria-hidden="true" />
                  <div className="history-main">
                    <div className="history-line1">
                      <span className="trigger-label">{trigger || '—'}</span>
                      {isLatest && <span className="tag loaded">{t('history.latest')}</span>}
                      <span className="subject">{h.subject || '—'}</span>
                      {note && <span className="note">· {note}</span>}
                    </div>
                    <div className="history-line2">
                      <code className="hash" title={h.commit}>
                        {h.commit.slice(0, 7)}
                      </code>
                      <span className="when">{new Date(h.timestamp).toLocaleString()}</span>
                    </div>
                  </div>
                  <button
                    className="restore"
                    disabled={skill.readOnly || isLatest}
                    title={isLatest ? t('history.restoreLatestTitle') : undefined}
                    onClick={() => setRollbackConfirmCommit(h.commit)}
                  >
                    {t('history.restore')}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {snapshotPromptOpen && (
        <PromptModal
          title={t('detail.snapshot')}
          intro={t('detail.snapshotIntro')}
          fieldLabel={t('detail.snapshotPrompt')}
          placeholder={t('detail.snapshotPlaceholder')}
          confirmLabel={t('detail.snapshotSave')}
          cancelLabel={t('projects.cancel')}
          onCancel={() => setSnapshotPromptOpen(false)}
          onConfirm={async (note) => {
            setSnapshotPromptOpen(false);
            await onAction(t('detail.snapshot'), async () => {
              await api.snapshot(skill.id, note.trim() || undefined);
              const r = await api.history(skill.id);
              setHistory(r.history);
            });
          }}
        />
      )}
      {removeConfirmOpen && (
        <ConfirmModal
          title={t('detail.removeTitle')}
          body={t('detail.removeConfirm', { id: skill.id })}
          confirmLabel={t('detail.remove')}
          cancelLabel={t('projects.cancel')}
          danger
          onCancel={() => setRemoveConfirmOpen(false)}
          onConfirm={async () => {
            setRemoveConfirmOpen(false);
            await onAction(t('detail.remove'), () => api.remove(skill.id));
          }}
        />
      )}
      {rollbackConfirmCommit && (
        <ConfirmModal
          title={t('detail.rollbackTitle')}
          body={t('detail.rollbackConfirm', {
            name: skill.name,
            sha: rollbackConfirmCommit.slice(0, 7),
          })}
          confirmLabel={t('history.restore')}
          cancelLabel={t('projects.cancel')}
          onCancel={() => setRollbackConfirmCommit(null)}
          onConfirm={async () => {
            const commit = rollbackConfirmCommit;
            setRollbackConfirmCommit(null);
            await onAction(t('history.restore'), async () => {
              await api.rollback(skill.id, commit);
              const r = await api.history(skill.id);
              setHistory(r.history);
            });
          }}
        />
      )}
    </div>
  );
}

interface ConfirmModalProps {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Render the confirm button as filled-red instead of filled-blue. */
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Drop-in replacement for `window.confirm`. Same modal frame as PromptModal
 * but without an input — just title + body + Cancel/Confirm.
 */
function ConfirmModal({
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={busy ? undefined : onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
      tabIndex={-1}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <span className="x" onClick={onCancel}>×</span>
        </div>
        <div className="modal-body">
          <p className="modal-intro" style={{ marginBottom: 0 }}>{body}</p>
        </div>
        <div className="modal-actions">
          <button onClick={onCancel} disabled={busy} autoFocus>{cancelLabel}</button>
          <button
            className={danger ? 'danger-primary' : 'primary'}
            onClick={submit}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PromptModalProps {
  title: string;
  intro?: string;
  fieldLabel?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: (value: string) => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Drop-in replacement for `window.prompt` that matches the rest of the modal
 * suite: same shadow, same header, same intro + label + input + actions rhythm.
 */
function PromptModal({
  title,
  intro,
  fieldLabel,
  placeholder,
  initialValue = '',
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: PromptModalProps) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await onConfirm(value);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <span className="x" onClick={onCancel}>×</span>
        </div>
        <div className="modal-body">
          {intro && <p className="modal-intro">{intro}</p>}
          <div className="modal-field">
            {fieldLabel && <label className="modal-field-label">{fieldLabel}</label>}
            <input
              type="text"
              className="modal-input"
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
                if (e.key === 'Escape') onCancel();
              }}
              autoFocus
            />
          </div>
        </div>
        <div className="modal-actions">
          <button onClick={onCancel} disabled={busy}>{cancelLabel}</button>
          <button className="primary" onClick={submit} disabled={busy}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

interface SafeMergePreviewProps {
  plans: MergePlanItem[];
  canonicalRoot: string;
  onCancel: () => void;
  onConfirm: () => void;
}

function homeShort(p: string): string {
  // Best-effort: replace the user's home prefix with ~ for readability. Server
  // already returns absolute paths; we just guess the home prefix by matching
  // a common "/Users/<name>/" or "/home/<name>/" segment.
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function SafeMergePreviewModal({ plans, canonicalRoot, onCancel, onConfirm }: SafeMergePreviewProps) {
  const t = useT();
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t('safeMerge.title', { n: plans.length })}</h2>
          <span className="tag" style={{ borderColor: 'var(--good)', color: 'var(--good)' }}>
            {t('safeMerge.tag')}
          </span>
          <span className="x" onClick={onCancel}>
            ×
          </span>
        </div>

        <div className="modal-body">
          <p className="modal-intro">{t('safeMerge.body', { root: homeShort(canonicalRoot) })}</p>

          {plans.map((p) => {
            const winner = p.canonicalWinner ?? p.candidates[0]!;
            const losers = p.candidates.filter((c) => c.realPath !== winner.realPath);
            return (
              <div key={p.name} className="candidate-card canonical" style={{ marginBottom: 10 }}>
                <div className="title">
                  <span style={{ fontFamily: 'inherit', fontWeight: 700, fontSize: 14 }}>{p.name}</span>
                </div>

                <div className="stats" style={{ marginTop: 6 }}>
                  <span style={{ color: 'var(--good)' }}>{t('safeMerge.keep')}</span>{' '}
                  <code>{homeShort(winner.realPath)}</code>{' '}
                  <span style={{ color: 'var(--fg-3)' }}>{t('safeMerge.canonicalUntouched')}</span>
                </div>
                {winner.members.length > 0 && (
                  <div className="stats" style={{ marginTop: 2, paddingLeft: 56 }}>
                    <span style={{ color: 'var(--fg-3)' }}>{t('safeMerge.alreadyLinked')}</span>{' '}
                    {winner.members.map((m, i) => (
                      <span key={m.id}>
                        {i > 0 ? ', ' : ''}
                        <code>{homeShort(m.path)}</code>{' '}
                        <span style={{ color: 'var(--fg-3)' }}>({m.scopeLabel})</span>
                      </span>
                    ))}
                  </div>
                )}

                {losers.map((l) => {
                  const symMembers = l.members.filter((m) => m.path !== m.realPath);
                  const directMembers = l.members.filter((m) => m.path === m.realPath);
                  return (
                    <div key={l.realPath} style={{ marginTop: 8 }}>
                      {symMembers.map((m) => (
                        <div key={m.id} className="stats" style={{ marginTop: 2 }}>
                          <span style={{ color: 'var(--warn)' }}>{t('safeMerge.retargetSymlink')}</span>{' '}
                          <code>{homeShort(m.path)}</code>{' '}
                          <span style={{ color: 'var(--fg-3)' }}>({m.scopeLabel})</span>
                          <div style={{ paddingLeft: 56, color: 'var(--fg-3)' }}>
                            {t('safeMerge.target', {
                              from: homeShort(l.realPath),
                              to: homeShort(winner.realPath),
                            })}
                          </div>
                        </div>
                      ))}
                      {directMembers.map((m) => (
                        <div key={m.id} className="stats" style={{ marginTop: 2 }}>
                          <span style={{ color: 'var(--warn)' }}>{t('safeMerge.replaceWithSymlink')}</span>{' '}
                          <code>{homeShort(m.path)}</code>{' '}
                          <span style={{ color: 'var(--fg-3)' }}>({m.scopeLabel})</span>
                          <div style={{ paddingLeft: 56, color: 'var(--fg-3)' }}>
                            {t('safeMerge.replaceDetail', { path: homeShort(winner.realPath) })}
                          </div>
                        </div>
                      ))}
                      <div className="stats" style={{ marginTop: 2 }}>
                        <span style={{ color: 'var(--danger)' }}>{t('safeMerge.trash')}</span>{' '}
                        <code>{homeShort(l.realPath)}</code>{' '}
                        <span style={{ color: 'var(--fg-3)' }}>{t('safeMerge.trashHint')}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="modal-actions">
          <button onClick={onCancel}>{t('safeMerge.cancel')}</button>
          <button className="primary" onClick={onConfirm}>
            {t('safeMerge.confirm', {
              n: plans.length,
              plural: plans.length === 1 ? t('safeMerge.skill') : t('safeMerge.skills'),
            })}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ConflictModalProps {
  name: string;
  plan: MergePlanItem | null;
  onClose: () => void;
  onMerged: () => void | Promise<void>;
  onError: (msg: string) => void;
}

function humanSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function ConflictModal({ name, plan, onClose, onMerged, onError }: ConflictModalProps) {
  const t = useT();
  const [diff, setDiff] = useState<MergeDiff | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setDiff(null);
    api.mergeDiff(name).then(setDiff).catch((err) => onError((err as Error).message));
  }, [name]);

  const candidates = plan?.candidates ?? [];

  const doMerge = async (winnerRealPath?: string) => {
    setLoading(true);
    try {
      await api.merge(name, winnerRealPath);
      await onMerged();
    } catch (err) {
      onError(`merge failed: ${(err as Error).message}`);
      setLoading(false);
    }
  };

  // Converge into `.agents`: relocate the winning content into the canonical
  // root and symlink every existing copy at it. Only offered when no candidate
  // already lives in `.agents` — otherwise "Use (canonical)" already does this.
  const doConverge = async (winnerRealPath?: string) => {
    setLoading(true);
    try {
      await api.mergeToCanonical(name, winnerRealPath);
      await onMerged();
    } catch (err) {
      onError(`converge failed: ${(err as Error).message}`);
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t('conflictModal.title', { name })}</h2>
          {plan && (
            <span className="tag">
              {t('conflictModal.summary', {
                n: plan.candidates.length,
                state: plan.contentsIdentical ? t('conflictModal.identical') : t('conflictModal.differ'),
              })}
            </span>
          )}
          <span className="x" onClick={onClose}>
            ×
          </span>
        </div>

        <div className="modal-body">
          {candidates.map((c, idx) => (
            <CandidateCard key={c.realPath} candidate={c} letter={String.fromCharCode(65 + idx)} />
          ))}

          {plan && !plan.contentsIdentical && diff && (
            <div>
              <div className="diff-summary">
                <span>{t('conflictModal.summary.same', { n: diff.summary.same })}</span>
                <span className="changed">{t('conflictModal.summary.changed', { n: diff.summary.changed })}</span>
                <span className="removed">{t('conflictModal.summary.onlyInA', { n: diff.summary.onlyInA })}</span>
                <span className="added">{t('conflictModal.summary.onlyInB', { n: diff.summary.onlyInB })}</span>
              </div>
              {diff.files
                .filter((f) => f.status !== 'same')
                .map((f) => (
                  <FileDiffView key={f.path} entry={f} />
                ))}
              {diff.files.every((f) => f.status === 'same') && (
                <div style={{ color: 'var(--fg-3)' }}>{t('conflictModal.allSame')}</div>
              )}
            </div>
          )}
          {plan && plan.contentsIdentical && (
            <div style={{ color: 'var(--good)', marginTop: 8 }}>
              {t('conflictModal.contentsIdentical')}
            </div>
          )}
          {!diff && <div style={{ color: 'var(--fg-3)' }}>{t('conflictModal.loadingDiff')}</div>}
        </div>

        <div className="modal-actions">
          <button onClick={onClose} disabled={loading}>
            {t('conflictModal.cancel')}
          </button>
          {plan?.canonicalWinner && plan.contentsIdentical && (
            <button className="primary" disabled={loading} onClick={() => doMerge()}>
              {t('conflictModal.autoMerge')}
            </button>
          )}
          {candidates.map((c, idx) => (
            <button
              key={c.realPath}
              disabled={loading}
              className={c.inCanonicalRoot ? 'primary' : ''}
              onClick={() => doMerge(c.realPath)}
            >
              {t('conflictModal.useCandidate', {
                letter: String.fromCharCode(65 + idx),
                label: c.inCanonicalRoot ? t('conflictModal.canonical') : t('conflictModal.nonCanonical'),
              })}
            </button>
          ))}
          {plan && !plan.hasCanonicalCandidate &&
            (plan.contentsIdentical ? (
              <button className="primary" disabled={loading} onClick={() => doConverge()}>
                {t('conflictModal.convergeToAgents')}
              </button>
            ) : (
              candidates.map((c, idx) => (
                <button
                  key={`converge-${c.realPath}`}
                  disabled={loading}
                  onClick={() => doConverge(c.realPath)}
                >
                  {t('conflictModal.convergeCandidate', { letter: String.fromCharCode(65 + idx) })}
                </button>
              ))
            ))}
        </div>
      </div>
    </div>
  );
}

function CandidateCard({ candidate, letter }: { candidate: MergeCandidate; letter: string }) {
  const t = useT();
  return (
    <div className={`candidate-card${candidate.inCanonicalRoot ? ' canonical' : ''}`}>
      <div className="title">
        <span>{letter}</span>
        <code style={{ background: 'var(--bg-2)', padding: '1px 6px', borderRadius: 4 }}>
          {candidate.realPath}
        </code>
        {candidate.inCanonicalRoot && (
          <span className="tag" style={{ borderColor: 'var(--good)', color: 'var(--good)' }}>
            {t('candidateCard.canonical')}
          </span>
        )}
      </div>
      <div className="stats">
        {humanSize(candidate.sizeBytes)} · {candidate.fileCount} files · mtime{' '}
        {new Date(candidate.mtime).toLocaleString()} · dir-sha {candidate.dirSha.slice(0, 12)}
      </div>
      <div className="members">
        {t('candidateCard.referencedBy')}{' '}
        {candidate.members.map((m, i) => (
          <span key={m.id}>
            {i > 0 ? ', ' : ''}
            <code>{m.scopeLabel}</code>
          </span>
        ))}
      </div>
    </div>
  );
}

function FileDiffView({ entry }: { entry: { path: string; status: string; unifiedDiff?: string; binary?: boolean } }) {
  return (
    <details className="file-diff" open={entry.status === 'changed' && !!entry.unifiedDiff}>
      <summary>
        <span className={`status-tag ${entry.status}`}>{entry.status}</span>
        {entry.path}
        {entry.binary ? <span style={{ color: 'var(--fg-3)' }}> (binary)</span> : null}
      </summary>
      {entry.unifiedDiff && (
        <pre>
          {entry.unifiedDiff.split('\n').map((line, i) => {
            let cls = '';
            if (line.startsWith('@@')) cls = 'line-hunk';
            else if (line.startsWith('+') && !line.startsWith('+++')) cls = 'line-add';
            else if (line.startsWith('-') && !line.startsWith('---')) cls = 'line-del';
            return (
              <span key={i} className={cls}>
                {line}
                {'\n'}
              </span>
            );
          })}
        </pre>
      )}
    </details>
  );
}

function humanFileSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function FilesView({ skillId }: { skillId: string }) {
  const t = useT();
  const [files, setFiles] = useState<FileNode[] | null>(null);

  useEffect(() => {
    let alive = true;
    setFiles(null);
    api.files(skillId)
      .then((r) => {
        if (alive) setFiles(r.files);
      })
      .catch(() => {
        if (alive) setFiles([]);
      });
    return () => {
      alive = false;
    };
  }, [skillId]);

  const onReveal = (relPath: string) => {
    api.revealFile(skillId, relPath).catch(() => { /* swallow — UI doesn't need to surface this */ });
  };

  if (files === null) return <div style={{ color: 'var(--fg-3)' }}>{t('files.loading')}</div>;
  if (files.length === 0) return <div style={{ color: 'var(--fg-3)' }}>{t('files.empty')}</div>;

  return (
    <div className="files-tree">
      {files.map((node) => (
        <FileTreeNode key={node.relPath} node={node} depth={0} onReveal={onReveal} revealTitle={t('files.revealTitle')} />
      ))}
    </div>
  );
}

function FileTreeNode({
  node,
  depth,
  onReveal,
  revealTitle,
}: {
  node: FileNode;
  depth: number;
  onReveal: (relPath: string) => void;
  revealTitle: string;
}) {
  const [open, setOpen] = useState(depth < 1); // top-level dirs open by default
  const indent = { paddingLeft: 12 + depth * 16 };
  if (node.type === 'dir') {
    return (
      <>
        <div
          className="file-row dir"
          style={indent}
          onClick={() => setOpen((v) => !v)}
          title={revealTitle}
          onContextMenu={(e) => {
            e.preventDefault();
            onReveal(node.relPath);
          }}
        >
          <span className="file-twisty">{open ? '▾' : '▸'}</span>
          <span className="file-icon">📁</span>
          <span className="file-name">{node.name}</span>
          <span
            className="file-reveal"
            title={revealTitle}
            onClick={(e) => {
              e.stopPropagation();
              onReveal(node.relPath);
            }}
          >
            ↗
          </span>
        </div>
        {open && node.children && node.children.length > 0 && (
          <div className="file-children">
            {node.children.map((child) => (
              <FileTreeNode
                key={child.relPath}
                node={child}
                depth={depth + 1}
                onReveal={onReveal}
                revealTitle={revealTitle}
              />
            ))}
          </div>
        )}
      </>
    );
  }
  return (
    <div
      className="file-row file"
      style={indent}
      onClick={() => onReveal(node.relPath)}
      title={revealTitle}
    >
      <span className="file-twisty" />
      <span className="file-icon">📄</span>
      <span className="file-name">{node.name}</span>
      {typeof node.size === 'number' && (
        <span className="file-size">{humanFileSize(node.size)}</span>
      )}
    </div>
  );
}

function FrontmatterView({ fm }: { fm: Record<string, unknown> }) {
  const keys = Object.keys(fm);
  if (keys.length === 0) return null;
  return (
    <table className="kv-table">
      <tbody>
        {keys.map((k) => {
          const v = fm[k];
          const isString = typeof v === 'string';
          const display = isString ? (v as string) : JSON.stringify(v, null, 2);
          return (
            <tr key={k}>
              <td className="k">{k}</td>
              <td className="v">
                {isString ? display : <pre style={{ margin: 0 }}>{display}</pre>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface CandidatesModalProps {
  candidates: ProjectCandidate[];
  onClose: () => void;
  onAdded: () => void | Promise<void>;
  onError: (msg: string) => void;
}

function CandidatesModal({ candidates, onClose, onAdded, onError }: CandidatesModalProps) {
  const t = useT();
  // Default: every candidate is checked. The user un-ticks ones they don't want.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(candidates.map((c) => c.path)));
  const [busy, setBusy] = useState(false);

  const toggle = (path: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectedCount = selected.size;
  const unselected = candidates.filter((c) => !selected.has(c.path)).map((c) => c.path);

  const addSelected = async () => {
    setBusy(true);
    try {
      for (const c of candidates) {
        if (selected.has(c.path)) await api.addProject({ path: c.path });
      }
      // Anything left un-ticked gets dismissed so the user isn't prompted again.
      if (unselected.length > 0) await api.dismissProjects(unselected);
      await onAdded();
      onClose();
    } catch (err) {
      onError((err as Error).message);
      setBusy(false);
    }
  };

  const dismissAll = async () => {
    setBusy(true);
    try {
      await api.dismissProjects(candidates.map((c) => c.path));
      await onAdded();
      onClose();
    } catch (err) {
      onError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-medium" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t('projects.candidatesTitle', { n: candidates.length })}</h2>
          <span className="x" onClick={onClose}>×</span>
        </div>
        <div className="modal-body">
          <p className="modal-intro">{t('projects.candidatesBody')}</p>
          {candidates.map((c) => (
            <label key={c.path} className="candidate-row">
              <input
                type="checkbox"
                checked={selected.has(c.path)}
                onChange={() => toggle(c.path)}
              />
              <div className="row-main">
                <div className="row-title">{c.basename}</div>
                <div className="row-path">{c.path}</div>
              </div>
              <div className="row-tags">
                {c.hasClaudeCode && <span className="tag">claude-code</span>}
                {c.hasCursor && <span className="tag">cursor</span>}
                {c.hasCodex && <span className="tag">codex</span>}
              </div>
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>{t('projects.skip')}</button>
          <button onClick={dismissAll} disabled={busy}>{t('projects.dismissAll')}</button>
          <button className="primary" onClick={addSelected} disabled={busy || selectedCount === 0}>
            {t('projects.addSelected', { n: selectedCount })}
          </button>
        </div>
      </div>
    </div>
  );
}

interface AddProjectModalProps {
  onClose: () => void;
  onAdded: () => void | Promise<void>;
  onError: (msg: string) => void;
}

function AddProjectModal({ onClose, onAdded, onError }: AddProjectModalProps) {
  const t = useT();
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = path.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await api.addProject({ path: trimmed, label: label.trim() || undefined });
      await onAdded();
    } catch (err) {
      onError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{t('projects.addManualTitle')}</h2>
          <span className="x" onClick={onClose}>×</span>
        </div>
        <div className="modal-body">
          <p className="modal-intro">{t('projects.addManualBody')}</p>
          <div className="modal-field">
            <label className="modal-field-label">{t('projects.path')}</label>
            <input
              type="text"
              className="modal-input"
              value={path}
              placeholder={t('projects.pathPlaceholder')}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              autoFocus
            />
          </div>
          <div className="modal-field">
            <label className="modal-field-label">{t('projects.label')}</label>
            <input
              type="text"
              className="modal-input"
              value={label}
              placeholder={t('projects.labelPlaceholder')}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
        </div>
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>{t('projects.cancel')}</button>
          <button className="primary" onClick={submit} disabled={busy || !path.trim()}>
            {t('projects.add')}
          </button>
        </div>
      </div>
    </div>
  );
}
