'use client'
import { useState, useRef } from 'react'
import { X, Link2, Type, Code, Upload, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react'
import clsx from 'clsx'
import { articlesApi, type Article } from '@/lib/api'

type Tab = 'url' | 'text' | 'rich' | 'document'

interface Props {
  onClose: () => void
  onAdded: (article: Article) => void
  categories?: string[]
}

const TABS: { id: Tab; label: string; icon: typeof Link2 }[] = [
  { id: 'url', label: 'From URL', icon: Link2 },
  { id: 'text', label: 'Plain text', icon: Type },
  { id: 'rich', label: 'Rich text / HTML', icon: Code },
  { id: 'document', label: 'Document', icon: Upload },
]

export default function AddArticleModal({ onClose, onAdded, categories = [] }: Props) {
  const [tab, setTab] = useState<Tab>('url')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')

  // URL tab
  const [url, setUrl] = useState('')

  // Text / Rich tabs
  const [title, setTitle] = useState('')
  const [source, setSource] = useState('')
  const [content, setContent] = useState('')

  // Document tab
  const [file, setFile] = useState<File | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // Shared
  const [category, setCategory] = useState('manual')

  async function submit() {
    setBusy(true)
    setErr('')
    setOk('')
    try {
      let article: Article
      if (tab === 'url') {
        if (!url.trim()) throw new Error('URL is required')
        article = await articlesApi.addFromUrl({ url: url.trim(), category })
      } else if (tab === 'text') {
        if (!content.trim()) throw new Error('Content is required')
        article = await articlesApi.addManual({
          title: title.trim() || undefined,
          content,
          source: source.trim() || undefined,
          category,
          is_html: false,
        })
      } else if (tab === 'rich') {
        if (!content.trim()) throw new Error('Content is required')
        article = await articlesApi.addManual({
          title: title.trim() || undefined,
          content,
          source: source.trim() || undefined,
          category,
          is_html: true,
        })
      } else {
        if (!file) throw new Error('Pick a file (.pdf, .docx, .txt, .md, .html)')
        article = await articlesApi.addFromDocument(file, {
          title: title.trim() || undefined,
          source: source.trim() || undefined,
          category,
        })
      }
      setOk(`Added: ${article.title || article.id}`)
      onAdded(article)
      // Reset minimal state after success
      setUrl(''); setTitle(''); setSource(''); setContent(''); setFile(null)
      setTimeout(() => { setOk(''); onClose() }, 900)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-[#0d1117] border border-[#1e2433] rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1e2433]">
          <h2 className="text-lg font-bold text-white">Add Article</h2>
          <button onClick={onClose} className="p-1.5 text-slate-500 hover:text-white hover:bg-white/10 rounded transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[#1e2433] px-2 pt-2 gap-1 overflow-x-auto">
          {TABS.map(t => {
            const Icon = t.icon
            const active = tab === t.id
            return (
              <button
                key={t.id}
                onClick={() => { setTab(t.id); setErr(''); setOk('') }}
                className={clsx(
                  'flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-colors whitespace-nowrap',
                  active
                    ? 'bg-[#0a0f1e] text-indigo-300 border-t border-x border-[#1e2433] -mb-px'
                    : 'text-slate-500 hover:text-slate-300'
                )}
              >
                <Icon size={12} /> {t.label}
              </button>
            )
          })}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {tab === 'url' && (
            <Field label="URL">
              <input
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !busy && submit()}
                placeholder="https://example.com/article"
                className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[10px] text-slate-600 mt-1">
                We&apos;ll fetch the page, extract the title, author, image, and main text.
              </p>
            </Field>
          )}

          {(tab === 'text' || tab === 'rich') && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Title (optional)">
                  <input
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="Headline…"
                    className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                  />
                </Field>
                <Field label="Source (optional)">
                  <input
                    value={source}
                    onChange={e => setSource(e.target.value)}
                    placeholder="e.g. Internal memo, Bloomberg…"
                    className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                  />
                </Field>
              </div>
              <Field label={tab === 'rich' ? 'HTML / Markdown content' : 'Content'}>
                <textarea
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  rows={12}
                  placeholder={tab === 'rich'
                    ? 'Paste HTML or markdown here. Tags will be stripped before saving.'
                    : 'Paste the article text here…'
                  }
                  className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 font-mono resize-y"
                />
              </Field>
            </>
          )}

          {tab === 'document' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Title (optional)">
                  <input
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="Defaults to filename / first line"
                    className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                  />
                </Field>
                <Field label="Source (optional)">
                  <input
                    value={source}
                    onChange={e => setSource(e.target.value)}
                    placeholder="Where this document came from"
                    className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                  />
                </Field>
              </div>
              <Field label="File">
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="w-full bg-[#0a0f1e] border border-dashed border-[#2d3148] hover:border-indigo-500/60 rounded-lg p-6 text-center transition-colors"
                >
                  <Upload size={20} className="mx-auto text-slate-500 mb-2" />
                  {file ? (
                    <span className="text-sm text-white">{file.name} <span className="text-slate-500">({(file.size / 1024).toFixed(1)} KB)</span></span>
                  ) : (
                    <>
                      <span className="block text-sm text-slate-300">Click to choose a file</span>
                      <span className="block text-[10px] text-slate-600 mt-1">.pdf, .docx, .txt, .md, .html — full document stored</span>
                    </>
                  )}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".pdf,.docx,.txt,.md,.html,.htm"
                  onChange={e => setFile(e.target.files?.[0] ?? null)}
                  className="hidden"
                />
              </Field>
            </>
          )}

          <Field label="Category">
            <input
              value={category}
              onChange={e => setCategory(e.target.value)}
              list="add-article-categories"
              className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            />
            <datalist id="add-article-categories">
              {categories.map(c => <option key={c} value={c} />)}
              <option value="manual" />
            </datalist>
          </Field>

          {err && (
            <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{err}</span>
            </div>
          )}
          {ok && (
            <div className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-emerald-400 text-sm">
              <CheckCircle2 size={14} /> {ok}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-[#1e2433]">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm text-white font-semibold transition-colors"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            {busy ? 'Adding…' : 'Add Article'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">{label}</span>
      {children}
    </label>
  )
}
