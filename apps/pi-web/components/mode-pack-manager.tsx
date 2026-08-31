'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

interface ModePackDefinition {
  id: string;
  revision: number;
  title: string;
  description: string;
  retired: boolean;
  provenance: {
    source: 'builtin' | 'user';
    createdAt: string;
    parentContentHash?: string;
  };
  [key: string]: unknown;
}

interface CatalogEntry {
  definition: ModePackDefinition;
  contentHash: string;
  builtin: boolean;
}

interface CatalogResponse {
  modePacks: CatalogEntry[];
  template: ModePackDefinition;
  error?: { code: string; message: string };
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function errorMessage(value: unknown): string {
  if (value && typeof value === 'object') {
    const candidate = value as { error?: { code?: unknown; message?: unknown } };
    if (candidate.error && typeof candidate.error.message === 'string') {
      const code = typeof candidate.error.code === 'string' ? `${candidate.error.code}: ` : '';
      return `${code}${candidate.error.message}`;
    }
  }
  return 'Mode Pack 请求失败。';
}

export function ModePackManager() {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [selectedId, setSelectedId] = useState('education-tutor');
  const [editor, setEditor] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState('');

  const selected = useMemo(
    () => catalog.find((entry) => entry.definition.id === selectedId) ?? null,
    [catalog, selectedId],
  );

  const loadCatalog = useCallback(async (template = 'education-tutor') => {
    const response = await fetch(`/api/mode-packs?template=${encodeURIComponent(template)}`, {
      cache: 'no-store',
    });
    const body = (await response.json()) as CatalogResponse;
    if (!response.ok || body.error) throw new Error(errorMessage(body));
    setCatalog(body.modePacks);
    setEditor((current) => current || pretty(body.template));
  }, []);

  useEffect(() => {
    void loadCatalog().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, [loadCatalog]);

  async function call(operation: 'validate' | 'preview' | 'publish'): Promise<unknown> {
    let definition: unknown;
    try {
      definition = JSON.parse(editor);
    } catch {
      throw new Error('编辑框不是有效 JSON。');
    }
    const response = await fetch('/api/mode-packs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, definition }),
    });
    const body = (await response.json()) as { result?: unknown; error?: { code: string; message: string } };
    if (!response.ok || body.error) throw new Error(errorMessage(body));
    return body.result;
  }

  async function run(operation: 'validate' | 'preview' | 'publish') {
    setBusy(true);
    setNotice('');
    setPreview('');
    try {
      const result = await call(operation);
      if (operation === 'preview') {
        setPreview(pretty(result));
        setNotice('预览通过。这里显示的是声明资源解析结果，不是 Runtime 激活回执。');
      } else if (operation === 'validate') {
        setNotice('合同校验通过；尚未发布，也尚未激活。');
      } else {
        setNotice('已发布不可变的新版本。');
        await loadCatalog(selectedId);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function cloneSelected() {
    if (!selected) return;
    const now = new Date().toISOString();
    const clone: ModePackDefinition = {
      ...structuredClone(selected.definition),
      id: selected.builtin ? `my-${selected.definition.id}` : selected.definition.id,
      revision: selected.builtin ? 1 : selected.definition.revision + 1,
      title: selected.builtin ? `My ${selected.definition.title}` : selected.definition.title,
      description: selected.definition.description,
      aliases: [],
      provenance: selected.builtin
        ? { source: 'user', createdAt: now }
        : {
            source: 'user',
            createdAt: now,
            parentContentHash: selected.contentHash,
          },
      retired: false,
    };
    setEditor(pretty(clone));
    setPreview('');
    setNotice(
      selected.builtin
        ? '已复制内置模式。请修改 id、标题、提示词与资源，再校验发布。'
        : '已创建下一修订版草稿；旧版本不会被覆盖。',
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Mode Pack</h1>
        <p className="max-w-4xl text-sm text-muted-foreground">
          一个 Mode Pack 同时声明提示词、Skill、插件或包、工具、Workflow、上下文与界面能力。发布是版本化写入；激活还需要 Pi
          Runtime 对实际加载结果签发匹配回执。
        </p>
      </header>

      <section className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <aside className="rounded-xl border bg-card p-4">
          <label className="mb-2 block text-sm font-medium" htmlFor="mode-pack-select">
            选择底稿
          </label>
          <select
            id="mode-pack-select"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {catalog.map((entry) => (
              <option key={`${entry.definition.id}:${entry.definition.revision}`} value={entry.definition.id}>
                {entry.definition.title} · r{entry.definition.revision}
                {entry.builtin ? ' · 内置' : ' · 自定义'}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="mt-3 w-full rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
            disabled={!selected || busy}
            onClick={() => void cloneSelected()}
          >
            {selected?.builtin ? '复制为自定义 Mode Pack' : '编辑为下一版本'}
          </button>

          {selected ? (
            <dl className="mt-4 space-y-2 break-words text-xs text-muted-foreground">
              <div>
                <dt className="font-medium text-foreground">ID</dt>
                <dd>{selected.definition.id}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">内容 Hash</dt>
                <dd>{selected.contentHash}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">用途</dt>
                <dd>{selected.definition.description}</dd>
              </div>
            </dl>
          ) : null}
        </aside>

        <section className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-medium">版本化 JSON 定义</h2>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                disabled={busy || !editor}
                onClick={() => void run('validate')}
              >
                只校验
              </button>
              <button
                type="button"
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                disabled={busy || !editor}
                onClick={() => void run('preview')}
              >
                资源预览
              </button>
              <button
                type="button"
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
                disabled={busy || !editor}
                onClick={() => void run('publish')}
              >
                发布新版本
              </button>
            </div>
          </div>

          <textarea
            aria-label="Mode Pack JSON"
            spellCheck={false}
            className="min-h-[38rem] w-full resize-y rounded-md border bg-background p-3 font-mono text-xs leading-5"
            value={editor}
            onChange={(event) => setEditor(event.target.value)}
          />

          {notice ? (
            <p role="status" className="rounded-md border bg-muted/40 p-3 text-sm">
              {notice}
            </p>
          ) : null}
        </section>
      </section>

      {preview ? (
        <section className="rounded-xl border bg-card p-4">
          <h2 className="mb-3 font-medium">声明资源解析预览</h2>
          <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-xs">
            {preview}
          </pre>
        </section>
      ) : null}
    </main>
  );
}
