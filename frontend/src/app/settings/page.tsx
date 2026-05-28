'use client'

import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { settingsApi, sourcesApi, articlesApi, type AppSettingsOut, type SettingsUpdate, type RssSource } from '@/lib/api'
import { CheckCircle, AlertCircle, Eye, EyeOff, Save, RefreshCw, Trash2, Plus, Loader2, Rss, Cpu, MessageSquare, Database, Newspaper, RotateCcw, Search, ChevronDown, ChevronRight, Edit2, X, Check, Upload, Tag, Power, Square, CheckSquare, Clock, Sparkles } from 'lucide-react'

const AI_PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI (GPT)' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'custom', label: 'Custom (OpenAI-compatible)' },
]

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-flash',
  deepseek: 'deepseek-chat',
  custom: '',
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettingsOut | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)
  const [form, setForm] = useState<SettingsUpdate>({})
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [nextFetchAt, setNextFetchAt] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [autoTagCategories, setAutoTagCategories] = useState<string[]>([])
  const [allCategories, setAllCategories] = useState<string[]>([])
  const [savingAutoTag, setSavingAutoTag] = useState(false)

  const ALL_SECTIONS = ['ai', 'prompts', 'datasources', 'news'] as const
  type SectionId = typeof ALL_SECTIONS[number]
  const [collapsedSections, setCollapsedSections] = useState<Set<SectionId>>(
    () => new Set<SectionId>(ALL_SECTIONS)
  )
  const allCollapsed = ALL_SECTIONS.every(s => collapsedSections.has(s))

  function toggleSection(id: SectionId) {
    setCollapsedSections(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function expandAll() { setCollapsedSections(new Set()) }
  function collapseAll() { setCollapsedSections(new Set<SectionId>(ALL_SECTIONS)) }

  useEffect(() => {
    settingsApi.get().then(s => {
      setSettings(s)
      setForm({
        default_ai_provider: s.default_ai_provider,
        default_ai_model: s.default_ai_model,
        chat_system_prompt: s.chat_system_prompt_customized ? s.chat_system_prompt : '',
        ask_system_prompt: s.ask_system_prompt_customized ? s.ask_system_prompt : '',
        directed_report_system_prompt: s.directed_report_system_prompt_customized ? s.directed_report_system_prompt : '',
        fetch_interval_minutes: s.fetch_interval_minutes,
      })
    }).catch((e: unknown) => {
      setLoadError(e instanceof Error ? e.message : 'Could not reach backend')
    }).finally(() => setLoading(false))
    sourcesApi.status().then(s => setNextFetchAt(s.next_fetch_at ?? null)).catch(() => {})
    settingsApi.getAutoTagCategories().then(r => setAutoTagCategories(r.categories)).catch(() => {})
    articlesApi.categories().then(cats => setAllCategories(cats)).catch(() => {})
  }, [])

  async function toggleAutoTagCategory(cat: string) {
    const next = autoTagCategories.includes(cat)
      ? autoTagCategories.filter(c => c !== cat)
      : [...autoTagCategories, cat]
    setAutoTagCategories(next)
    setSavingAutoTag(true)
    try {
      await settingsApi.setAutoTagCategories(next)
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Save failed', 'error')
      // Revert on failure
      setAutoTagCategories(autoTagCategories)
    } finally {
      setSavingAutoTag(false)
    }
  }

  async function resetKey(key: string) {
    try {
      await settingsApi.resetKey(key)
      const fresh = await settingsApi.get()
      setSettings(fresh)
      setForm(prev => ({ ...prev, [key]: '' }))
      showToast(`Reset ${key} to default`, 'success')
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Reset failed', 'error')
    }
  }

  function set(key: keyof SettingsUpdate, value: string | boolean | number) {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  async function save() {
    setSaving(true)
    try {
      await settingsApi.update(form)
      const fresh = await settingsApi.get()
      setSettings(fresh)
      setForm(prev => ({ ...prev }))
      showToast('Settings saved.', 'success')
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  function showToast(msg: string, type: 'success' | 'error') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  function toggleShow(key: string) {
    setShowKeys(prev => ({ ...prev, [key]: !prev[key] }))
  }

  async function fetchModels() {
    const provider = form.default_ai_provider || settings?.default_ai_provider
    if (!provider) return
    setLoadingModels(true)
    setModelsError('')
    setAvailableModels([])
    try {
      const res = await settingsApi.models(provider)
      setAvailableModels(res.models)
      if (res.models.length === 0) setModelsError('Provider returned no models')
    } catch (e: unknown) {
      setModelsError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingModels(false)
    }
  }

  if (loading) return <div className="text-slate-500 text-sm p-4">Loading settings…</div>
  if (loadError) return (
    <div className="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm max-w-lg">
      <AlertCircle size={16} className="flex-shrink-0" />
      <div>
        <p className="font-semibold">Could not load settings</p>
        <p className="text-red-400/70 text-xs mt-0.5">{loadError} — is the backend running on port 8000?</p>
      </div>
      <button onClick={() => { setLoadError(''); setLoading(true); settingsApi.get().then(s => { setSettings(s); setForm({ default_ai_provider: s.default_ai_provider, default_ai_model: s.default_ai_model, chat_system_prompt: s.chat_system_prompt_customized ? s.chat_system_prompt : '', ask_system_prompt: s.ask_system_prompt_customized ? s.ask_system_prompt : '', directed_report_system_prompt: s.directed_report_system_prompt_customized ? s.directed_report_system_prompt : '', fetch_interval_minutes: s.fetch_interval_minutes }) }).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Failed')).finally(() => setLoading(false)) }} className="ml-auto flex-shrink-0 p-1.5 hover:bg-red-500/20 rounded transition-colors"><RefreshCw size={14} /></button>
    </div>
  )

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Settings</h1>
          <p className="text-slate-500 text-sm mt-1">Configure AI providers, API keys, and data sources</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={allCollapsed ? expandAll : collapseAll}
            className="flex items-center gap-1.5 px-3 py-2 text-xs text-slate-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
            title={allCollapsed ? 'Expand all sections' : 'Collapse all sections'}
          >
            {allCollapsed
              ? <><ChevronDown size={13} />Expand all</>
              : <><ChevronRight size={13} />Collapse all</>
            }
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg text-sm text-white font-medium transition-colors"
          >
            <Save size={14} />
            {saving ? 'Saving…' : 'Save All'}
          </button>
        </div>
      </div>

      {toast && (
        <div className={`mb-4 flex items-center gap-2 p-3 rounded-lg border text-sm ${
          toast.type === 'success'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          {toast.type === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          {toast.msg}
        </div>
      )}

      <div className="space-y-3">
        {/* ─────────  AI & PROVIDERS  ───────── */}
        <CollapsibleSection
          icon={Cpu}
          label="AI & Providers"
          description="Choose your default model and configure provider credentials"
          collapsed={collapsedSections.has('ai')}
          onToggle={() => toggleSection('ai')}
        >
          {/* AI Provider */}
          <Card title="AI Provider">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Default Provider">
                <select
                  value={form.default_ai_provider || ''}
                  onChange={e => {
                    set('default_ai_provider', e.target.value)
                    if (!form.default_ai_model) set('default_ai_model', DEFAULT_MODELS[e.target.value] || '')
                  }}
                  className="input"
                >
                  {AI_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </Field>
              <Field label="Default Model">
                <div className="flex gap-2">
                  <input
                    value={form.default_ai_model || ''}
                    onChange={e => set('default_ai_model', e.target.value)}
                    placeholder="e.g. claude-sonnet-4-6"
                    className="input"
                    list="available-models-list"
                  />
                  <datalist id="available-models-list">
                    {availableModels.map(m => <option key={m} value={m} />)}
                  </datalist>
                  <button
                    type="button"
                    onClick={fetchModels}
                    disabled={loadingModels}
                    title="Fetch available models from the provider"
                    className="px-3 py-2 bg-[#1e2433] hover:bg-[#2d3148] disabled:opacity-50 rounded-lg text-xs text-slate-300 hover:text-white transition-colors flex items-center gap-1.5 whitespace-nowrap"
                  >
                    {loadingModels ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    {availableModels.length > 0 ? `${availableModels.length} models` : 'Fetch'}
                  </button>
                </div>
                {modelsError && <p className="text-[10px] text-red-400 mt-1">{modelsError}</p>}
                {availableModels.length > 0 && (
                  <select
                    value=""
                    onChange={e => e.target.value && set('default_ai_model', e.target.value)}
                    className="input mt-2 text-xs"
                  >
                    <option value="">— pick from list —</option>
                    {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                )}
              </Field>
            </div>
          </Card>

          {/* API Keys */}
          <Card title="API Keys">
            <div className="space-y-3">
              <KeyRow label="Anthropic" field="anthropic_api_key" hasKey={settings?.anthropic_api_key?.has_key} form={form} set={set} showKeys={showKeys} toggleShow={toggleShow} />
              <KeyRow label="OpenAI" field="openai_api_key" hasKey={settings?.openai_api_key?.has_key} form={form} set={set} showKeys={showKeys} toggleShow={toggleShow} />
              <KeyRow label="Google Gemini" field="gemini_api_key" hasKey={settings?.gemini_api_key?.has_key} form={form} set={set} showKeys={showKeys} toggleShow={toggleShow} />
              <KeyRow label="DeepSeek" field="deepseek_api_key" hasKey={settings?.deepseek_api_key?.has_key} form={form} set={set} showKeys={showKeys} toggleShow={toggleShow} />
            </div>
          </Card>

          {/* Custom AI */}
          <Card title="Custom AI (OpenAI-compatible)">
            <div className="space-y-3">
              <Field label="Endpoint URL">
                <input value={form.custom_ai_endpoint || ''} onChange={e => set('custom_ai_endpoint', e.target.value)} placeholder="https://your-endpoint/v1" className="input" />
              </Field>
              <Field label="Model ID">
                <input value={form.custom_ai_model || ''} onChange={e => set('custom_ai_model', e.target.value)} placeholder="model-name" className="input" />
              </Field>
              <KeyRow label="API Key" field="custom_ai_api_key" hasKey={settings?.custom_ai_api_key?.has_key} form={form} set={set} showKeys={showKeys} toggleShow={toggleShow} />
            </div>
          </Card>
        </CollapsibleSection>

        {/* ─────────  AI CHAT & PROMPTS  ───────── */}
        <CollapsibleSection
          icon={MessageSquare}
          label="AI Chat & Prompts"
          description="Customize the system prompts used by the chat panel and per-article ask feature"
          collapsed={collapsedSections.has('prompts')}
          onToggle={() => toggleSection('prompts')}
        >
          <Card title="System Prompts">
            <p className="text-xs text-slate-500 mb-4">
              Override how the AI behaves. Save an empty value (or click Reset) to fall back to the built-in default.
            </p>
            <div className="space-y-5">
              <PromptField
                label="AI Chat panel (general)"
                hint="Used by the floating chat panel; receives recent analyses as context."
                fieldKey="chat_system_prompt"
                form={form}
                set={set}
                defaultValue={settings?.chat_system_prompt_default || ''}
                customized={settings?.chat_system_prompt_customized || false}
                onReset={() => resetKey('chat_system_prompt')}
              />
              <PromptField
                label="Ask about an article"
                hint="Used by the per-article Ask feature on the News page; receives the article text + prior analyses."
                fieldKey="ask_system_prompt"
                form={form}
                set={set}
                defaultValue={settings?.ask_system_prompt_default || ''}
                customized={settings?.ask_system_prompt_customized || false}
                onReset={() => resetKey('ask_system_prompt')}
              />
              <PromptField
                label="Analysis & Prognosis report"
                hint="System prompt for the directed report synthesiser (Analysis page). Defines the analyst persona and output constraints."
                fieldKey="directed_report_system_prompt"
                form={form}
                set={set}
                defaultValue={settings?.directed_report_system_prompt_default || ''}
                customized={settings?.directed_report_system_prompt_customized || false}
                onReset={() => resetKey('directed_report_system_prompt')}
              />
            </div>
          </Card>
        </CollapsibleSection>

        {/* ─────────  DATA SOURCES & APIs  ───────── */}
        <CollapsibleSection
          icon={Database}
          label="Data Sources & APIs"
          description="External API keys for news, market data, and search"
          collapsed={collapsedSections.has('datasources')}
          onToggle={() => toggleSection('datasources')}
        >
          {/* News / Market Data */}
          <Card title="News / Market Data">
            <p className="text-xs text-slate-500 mb-3">NewsAPI key enables hourly headline fetch alongside RSS. Get one at newsapi.org.</p>
            <div className="space-y-3">
              <KeyRow label="NewsAPI" field="news_api_key" hasKey={settings?.news_api_key?.has_key} form={form} set={set} showKeys={showKeys} toggleShow={toggleShow} />
              <KeyRow label="FRED (Federal Reserve)" field="fred_api_key" hasKey={settings?.fred_api_key?.has_key} form={form} set={set} showKeys={showKeys} toggleShow={toggleShow} />
              <KeyRow label="Alpha Vantage" field="alpha_vantage_api_key" hasKey={settings?.alpha_vantage_api_key?.has_key} form={form} set={set} showKeys={showKeys} toggleShow={toggleShow} />
              <KeyRow label="Polygon.io" field="polygon_api_key" hasKey={settings?.polygon_api_key?.has_key} form={form} set={set} showKeys={showKeys} toggleShow={toggleShow} />
            </div>
          </Card>

          {/* Web Search APIs */}
          <Card title="Web Search APIs">
            <p className="text-xs text-slate-500 mb-3">
              Used for the Web Search page and as a fallback when AI grounding returns no results.
              DuckDuckGo and Bing HTML are tried automatically at no cost — add keys below to unlock
              higher-quality or higher-volume search.
            </p>
            <div className="space-y-4">
              <div>
                <p className="text-[10px] text-indigo-400 font-semibold uppercase tracking-wider mb-2">Google Custom Search</p>
                <p className="text-[10px] text-slate-600 mb-2">Get keys at console.cloud.google.com and programmablesearchengine.google.com</p>
                <div className="space-y-3">
                  <KeyRow label="Google API Key" field="google_search_api_key" hasKey={settings?.google_search_api_key?.has_key} form={form} set={set} showKeys={showKeys} toggleShow={toggleShow} />
                  <KeyRow label="Search Engine CX ID" field="google_search_cx" hasKey={settings?.google_search_cx?.has_key} form={form} set={set} showKeys={showKeys} toggleShow={toggleShow} />
                </div>
              </div>
              <div className="border-t border-[#1e2433] pt-3">
                <p className="text-[10px] text-indigo-400 font-semibold uppercase tracking-wider mb-2">Bing Web Search</p>
                <p className="text-[10px] text-slate-600 mb-2">Optional — get a free-tier key at portal.azure.com → Bing Search v7. Without a key, Bing HTML scraping is used as a fallback.</p>
                <KeyRow label="Bing Search API Key" field="bing_search_api_key" hasKey={settings?.bing_search_api_key?.has_key} form={form} set={set} showKeys={showKeys} toggleShow={toggleShow} />
              </div>
            </div>
          </Card>

          {/* Telegram */}
          <Card title="Telegram">
            <p className="text-xs text-slate-500 mb-3">
              Used to fetch messages from Telegram channels and groups on the same schedule as RSS feeds.
              Get your credentials at <a href="https://my.telegram.org/apps" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">my.telegram.org/apps</a>.
            </p>
            <div className="space-y-2">
              <KeyRow label="API ID" field="telegram_api_id" hasKey={settings?.telegram_api_id?.has_key} form={form} set={set} showKeys={showKeys} toggleShow={toggleShow} />
              <KeyRow label="API Hash" field="telegram_api_hash" hasKey={settings?.telegram_api_hash?.has_key} form={form} set={set} showKeys={showKeys} toggleShow={toggleShow} />
              <KeyRow label="Phone Number" field="telegram_phone" hasKey={settings?.telegram_phone?.has_key} form={form} set={set} showKeys={showKeys} toggleShow={toggleShow} />
            </div>
            <p className="text-[10px] text-slate-600 mt-3">
              After saving credentials, go to <a href="/telegram" className="text-blue-400 hover:underline">Telegram Channels</a> to authorise the session and add channels.
            </p>
          </Card>
        </CollapsibleSection>

        {/* ─────────  NEWS SOURCES (RSS)  ───────── */}
        <CollapsibleSection
          icon={Newspaper}
          label="News Sources"
          description="Manage RSS feeds the scheduler polls and configure automation"
          collapsed={collapsedSections.has('news')}
          onToggle={() => toggleSection('news')}
        >

        <Card title="Automation">
          <div className="space-y-5">
            <Toggle
              on={(form.auto_analyze_enabled ?? settings?.auto_analyze_enabled) ?? true}
              onChange={v => set('auto_analyze_enabled', v)}
              label="Auto-analyze new articles"
              hint='When enabled, every article pulled by the scheduled fetch is sent through the AI for analysis (capped to prevent runaway token usage). Turn off to fetch news only — you can still analyze articles manually.'
            />

            <div className="border-t border-[#1e2433] pt-4">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles size={13} className="text-teal-400" />
                <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Auto-tag on fetch</p>
                {savingAutoTag && <Loader2 size={11} className="animate-spin text-teal-400 ml-auto" />}
              </div>
              <p className="text-[10px] text-slate-500 mb-3">
                When a new article is fetched in the selected categories, AI automatically extracts English topic tags from it — even if the article is in another language.
                Applies a cap of 20 articles per fetch cycle to control token usage.
              </p>
              {allCategories.length === 0 ? (
                <p className="text-[10px] text-slate-600 italic">No article categories found yet — add RSS feeds first.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {allCategories.map(cat => {
                    const on = autoTagCategories.includes(cat)
                    return (
                      <button
                        key={cat}
                        onClick={() => toggleAutoTagCategory(cat)}
                        disabled={savingAutoTag}
                        className={clsx(
                          'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors disabled:opacity-60',
                          on
                            ? 'bg-teal-500/15 border-teal-500/40 text-teal-300 hover:bg-teal-500/25'
                            : 'bg-[#0a0f1e] border-[#1e2433] text-slate-500 hover:border-[#2d3148] hover:text-slate-300',
                        )}
                      >
                        <Tag size={10} className={on ? 'text-teal-400' : 'text-slate-600'} />
                        {cat.replace(/_/g, ' ')}
                        {on && <span className="ml-0.5 w-1.5 h-1.5 rounded-full bg-teal-400 inline-block" />}
                      </button>
                    )
                  })}
                </div>
              )}
              {autoTagCategories.length > 0 && (
                <p className="text-[10px] text-teal-600 mt-2">
                  {autoTagCategories.length} categor{autoTagCategories.length === 1 ? 'y' : 'ies'} enabled
                </p>
              )}
            </div>

            <div className="border-t border-[#1e2433] pt-4">
              <div className="flex items-center gap-2 mb-3">
                <Clock size={13} className="text-indigo-400" />
                <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Fetch Schedule</p>
              </div>
              <div className="flex items-end gap-4 flex-wrap">
                <Field label="Fetch interval (minutes)">
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    value={form.fetch_interval_minutes ?? settings?.fetch_interval_minutes ?? 30}
                    onChange={e => {
                      const v = parseInt(e.target.value, 10)
                      if (!isNaN(v)) set('fetch_interval_minutes', Math.max(1, Math.min(1440, v)))
                    }}
                    className="input w-32"
                  />
                </Field>
                {nextFetchAt && (
                  <div className="pb-1.5">
                    <p className="text-[10px] text-slate-500 mb-0.5">Next scheduled fetch</p>
                    <p className="text-xs text-indigo-300 font-mono">{new Date(nextFetchAt.endsWith('Z') ? nextFetchAt : nextFetchAt + 'Z').toLocaleTimeString()}</p>
                  </div>
                )}
              </div>
              <p className="text-[10px] text-slate-600 mt-2">
                Changes take effect immediately — no server restart required. Min 1 min, max 1440 min (24 h).
              </p>
            </div>
          </div>
        </Card>

          <Card title="RSS Feeds">
            <SourcesManager />
          </Card>
        </CollapsibleSection>
      </div>
    </div>
  )
}

function CollapsibleSection({
  icon: Icon, label, description, collapsed, onToggle, children,
}: {
  icon: React.ComponentType<{ size?: number | string }>
  label: string
  description?: string
  collapsed: boolean
  onToggle: () => void
  children?: React.ReactNode
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 pt-3 pb-2 border-b border-[#1e2433] group text-left"
      >
        <div className="w-9 h-9 rounded-lg bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400 flex-shrink-0">
          <Icon size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-bold text-white">{label}</h2>
          {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
        </div>
        <ChevronRight
          size={16}
          className={clsx('text-slate-500 flex-shrink-0 transition-transform duration-200', !collapsed && 'rotate-90')}
        />
      </button>
      {!collapsed && (
        <div className="space-y-4 mt-4">
          {children}
        </div>
      )}
    </div>
  )
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        onClick={() => onChange(!on)}
        className={clsx(
          'relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5',
          on ? 'bg-indigo-600' : 'bg-[#2d3148]'
        )}
        aria-pressed={on}
      >
        <span
          className={clsx(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform',
            on ? 'translate-x-5' : 'translate-x-0.5'
          )}
        />
      </button>
      <div className="flex-1">
        <p className="text-sm font-medium text-white">{label}</p>
        {hint && <p className="text-xs text-slate-500 mt-0.5">{hint}</p>}
      </div>
    </div>
  )
}

function PromptField({
  label, hint, fieldKey, form, set, defaultValue, customized, onReset,
}: {
  label: string
  hint: string
  fieldKey: 'chat_system_prompt' | 'ask_system_prompt' | 'directed_report_system_prompt'
  form: SettingsUpdate
  set: (k: keyof SettingsUpdate, v: string | boolean | number) => void
  defaultValue: string
  customized: boolean
  onReset: () => void
}) {
  const value = (form[fieldKey] as string) ?? ''
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="block text-xs font-medium text-slate-300">
          {label}
          {customized && (
            <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded uppercase tracking-wider">Customized</span>
          )}
          {!customized && (
            <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-slate-700/30 text-slate-500 border border-slate-700/40 rounded uppercase tracking-wider">Default</span>
          )}
        </label>
        <button
          type="button"
          onClick={onReset}
          disabled={!customized}
          className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Restore default"
        >
          <RotateCcw size={10} /> Reset
        </button>
      </div>
      <p className="text-[10px] text-slate-500 mb-1.5">{hint}</p>
      <textarea
        value={value}
        onChange={e => set(fieldKey, e.target.value)}
        placeholder={defaultValue}
        rows={5}
        className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded-lg px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors font-mono leading-relaxed resize-y"
      />
      <p className="text-[10px] text-slate-600 mt-1">
        {value ? `${value.length} chars (override active)` : 'Empty — using built-in default (shown as placeholder)'}
      </p>
    </div>
  )
}

type StatusFilter = 'all' | 'ok' | 'empty' | 'error' | 'untested' | 'disabled'

function SourcesManager() {
  const [sources, setSources] = useState<RssSource[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState('')
  const [error, setError] = useState('')

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const [adding, setAdding] = useState(false)
  const [bulkAdding, setBulkAdding] = useState(false)

  // ── Selection ──────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<number>>(new Set())

  async function load() {
    setLoading(true)
    try { setSources(await sourcesApi.list()) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  function flash(msg: string, isError = false) {
    if (isError) { setError(msg); setTimeout(() => setError(''), 5000) }
    else { setInfo(msg); setTimeout(() => setInfo(''), 4000) }
  }

  async function toggle(s: RssSource) {
    try { await sourcesApi.update(s.id, { enabled: !s.enabled }); await load() }
    catch (e: unknown) { flash(e instanceof Error ? e.message : String(e), true) }
  }
  async function remove(s: RssSource) {
    if (!confirm(`Delete feed?\n${s.url}`)) return
    try { await sourcesApi.delete(s.id); await load() }
    catch (e: unknown) { flash(e instanceof Error ? e.message : String(e), true) }
  }
  async function reseed() {
    setBusy(true)
    try {
      const res = await sourcesApi.reseed()
      flash(`Added ${res.added} missing feed${res.added === 1 ? '' : 's'}`)
      await load()
    } catch (e: unknown) { flash(e instanceof Error ? e.message : String(e), true) }
    finally { setBusy(false) }
  }
  async function toggleCategory(cat: string, enabled: boolean) {
    setBusy(true)
    try {
      await sourcesApi.categoryAction({ category: cat, enabled })
      flash(`${enabled ? 'Enabled' : 'Disabled'} all "${cat}" feeds`)
      await load()
    } catch (e: unknown) { flash(e instanceof Error ? e.message : String(e), true) }
    finally { setBusy(false) }
  }
  async function renameCategory(oldCat: string) {
    const newCat = prompt(`Rename category "${oldCat}" to:`, oldCat)
    if (!newCat || newCat.trim() === oldCat) return
    setBusy(true)
    try {
      await sourcesApi.categoryAction({ category: oldCat, rename_to: newCat.trim() })
      flash(`Renamed "${oldCat}" → "${newCat.trim()}"`)
      await load()
    } catch (e: unknown) { flash(e instanceof Error ? e.message : String(e), true) }
    finally { setBusy(false) }
  }
  async function deleteCategory(cat: string) {
    const n = sources.filter(s => s.category === cat).length
    if (!confirm(`Delete ALL ${n} feeds in category "${cat}"?\nThis cannot be undone.`)) return
    setBusy(true)
    try {
      await sourcesApi.deleteCategory(cat)
      flash(`Deleted ${n} feed${n === 1 ? '' : 's'} from "${cat}"`)
      await load()
    } catch (e: unknown) { flash(e instanceof Error ? e.message : String(e), true) }
    finally { setBusy(false) }
  }

  async function bulkDeleteSelected() {
    const ids = Array.from(selected)
    if (!ids.length) return
    if (!confirm(`Delete ${ids.length} selected feed${ids.length === 1 ? '' : 's'}?\nThis cannot be undone.`)) return
    setBusy(true)
    try {
      const res = await sourcesApi.bulkDelete(ids)
      clearSelection()
      flash(`Deleted ${res.deleted} feed${res.deleted === 1 ? '' : 's'}`)
      await load()
    } catch (e: unknown) { flash(e instanceof Error ? e.message : String(e), true) }
    finally { setBusy(false) }
  }

  async function bulkFetchSelected() {
    const ids = Array.from(selected)
    if (!ids.length) return
    setBusy(true)
    flash(`Fetching ${ids.length} feed${ids.length === 1 ? '' : 's'}…`)
    try {
      const res = await sourcesApi.bulkFetch(ids)
      flash(`Fetched ${res.sources_fetched} feeds → ${res.new_articles} new article${res.new_articles === 1 ? '' : 's'}${res.errors ? ` (${res.errors} errors)` : ''}`)
      await load()
    } catch (e: unknown) { flash(e instanceof Error ? e.message : String(e), true) }
    finally { setBusy(false) }
  }

  function toggleCollapsed(cat: string) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat); else next.add(cat)
      return next
    })
  }

  // ── Selection helpers (need `filtered` below) ─────────────────────────────
  function toggleSelect(id: number) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function clearSelection() { setSelected(new Set()) }

  // Counts + grouping
  const counts = {
    total: sources.length,
    enabled: sources.filter(s => s.enabled).length,
    ok: sources.filter(s => s.last_status === 'ok').length,
    empty: sources.filter(s => s.last_status === 'empty').length,
    error: sources.filter(s => s.last_status === 'error').length,
    untested: sources.filter(s => !s.last_status).length,
  }

  const filtered = sources.filter(s => {
    if (statusFilter === 'disabled' && s.enabled) return false
    if (statusFilter === 'ok' && s.last_status !== 'ok') return false
    if (statusFilter === 'empty' && s.last_status !== 'empty') return false
    if (statusFilter === 'error' && s.last_status !== 'error') return false
    if (statusFilter === 'untested' && s.last_status) return false
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      if (!s.url.toLowerCase().includes(q)
        && !s.category.toLowerCase().includes(q)
        && !(s.name || '').toLowerCase().includes(q)) return false
    }
    return true
  })
  function selectAll() { setSelected(new Set(filtered.map(s => s.id))) }

  const grouped = new Map<string, RssSource[]>()
  for (const s of filtered) {
    if (!grouped.has(s.category)) grouped.set(s.category, [])
    grouped.get(s.category)!.push(s)
  }
  const sortedCats = Array.from(grouped.keys()).sort()
  const allCats = Array.from(new Set(sources.map(s => s.category))).sort()

  return (
    <div className="space-y-3">
      {/* Stat chips */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <Stat label="total" value={counts.total} accent="text-slate-300" />
        <Stat label="enabled" value={counts.enabled} accent="text-indigo-300" />
        <Stat label="ok" value={counts.ok} accent="text-emerald-400" onClick={() => setStatusFilter(statusFilter === 'ok' ? 'all' : 'ok')} active={statusFilter === 'ok'} />
        <Stat label="empty" value={counts.empty} accent="text-amber-400" onClick={() => setStatusFilter(statusFilter === 'empty' ? 'all' : 'empty')} active={statusFilter === 'empty'} />
        <Stat label="error" value={counts.error} accent="text-red-400" onClick={() => setStatusFilter(statusFilter === 'error' ? 'all' : 'error')} active={statusFilter === 'error'} />
        <Stat label="untested" value={counts.untested} accent="text-slate-500" onClick={() => setStatusFilter(statusFilter === 'untested' ? 'all' : 'untested')} active={statusFilter === 'untested'} />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search URL, category, or name…"
            className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded pl-7 pr-7 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white">
              <X size={11} />
            </button>
          )}
        </div>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as StatusFilter)}
          className="bg-[#0a0f1e] border border-[#1e2433] rounded px-2 py-1.5 text-xs text-slate-300"
        >
          <option value="all">All statuses</option>
          <option value="ok">Healthy only</option>
          <option value="empty">Empty</option>
          <option value="error">Errors</option>
          <option value="untested">Untested</option>
          <option value="disabled">Disabled</option>
        </select>
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 rounded text-xs text-white font-medium"
        >
          <Plus size={12} /> Add Feed
        </button>
        <button
          onClick={() => setBulkAdding(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1e2433] hover:bg-[#2d3148] rounded text-xs text-slate-300 hover:text-white"
        >
          <Upload size={12} /> Bulk Add
        </button>
        <button
          onClick={reseed}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1e2433] hover:bg-[#2d3148] disabled:opacity-50 rounded text-xs text-slate-300 hover:text-white"
          title="Add any default feeds that are missing from your list"
        >
          <RotateCcw size={12} /> Reseed
        </button>
      </div>

      {info && <p className="text-xs text-emerald-400">{info}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* ── Bulk-selection action bar ─────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 bg-indigo-600/10 border border-indigo-500/30 rounded-lg flex-wrap">
          <span className="text-xs font-semibold text-indigo-300 flex-shrink-0">
            {selected.size} selected
          </span>
          <button
            onClick={selectAll}
            className="text-xs text-slate-400 hover:text-white underline underline-offset-2 flex-shrink-0"
          >
            Select all visible ({filtered.length})
          </button>
          <button
            onClick={clearSelection}
            className="text-xs text-slate-500 hover:text-white flex-shrink-0"
          >
            Clear
          </button>
          <div className="flex-1" />
          <button
            onClick={bulkFetchSelected}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/40 disabled:opacity-50 border border-emerald-500/30 rounded text-xs text-emerald-300 font-medium transition-colors"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            Fetch Selected ({selected.size})
          </button>
          <button
            onClick={bulkDeleteSelected}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 disabled:opacity-50 border border-red-500/30 rounded text-xs text-red-300 font-medium transition-colors"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
            Delete Selected ({selected.size})
          </button>
        </div>
      )}

      {/* Grouped list */}
      {loading ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : sortedCats.length === 0 ? (
        <p className="text-xs text-slate-500 text-center py-6">
          No feeds match the current filters.
        </p>
      ) : (
        <div className="space-y-2">
          {sortedCats.map(cat => {
            const rows = grouped.get(cat)!
            const total = sources.filter(s => s.category === cat).length
            const enabled = sources.filter(s => s.category === cat && s.enabled).length
            const ok = sources.filter(s => s.category === cat && s.last_status === 'ok').length
            const isCollapsed = collapsed.has(cat)
            const allEnabled = enabled === total
            return (
              <div key={cat} className="border border-[#1e2433] rounded-lg overflow-hidden bg-[#0a0f1e]">
                <div className="flex items-center gap-2 px-3 py-2 bg-[#0d1117] hover:bg-[#11161f] transition-colors">
                  {/* Category-level select-all checkbox */}
                  {(() => {
                    const catIds = rows.map(s => s.id)
                    const allSel = catIds.every(id => selected.has(id))
                    const someSel = catIds.some(id => selected.has(id))
                    return (
                      <button
                        onClick={() => {
                          setSelected(prev => {
                            const n = new Set(prev)
                            if (allSel) catIds.forEach(id => n.delete(id))
                            else catIds.forEach(id => n.add(id))
                            return n
                          })
                        }}
                        className="flex-shrink-0 text-slate-500 hover:text-indigo-400 transition-colors"
                        title={allSel ? 'Deselect category' : 'Select all in category'}
                      >
                        {allSel ? <CheckSquare size={13} className="text-indigo-400" />
                          : someSel ? <CheckSquare size={13} className="text-indigo-300/50" />
                          : <Square size={13} />}
                      </button>
                    )
                  })()}
                  <button onClick={() => toggleCollapsed(cat)} className="text-slate-500 hover:text-white flex-shrink-0">
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                  <Tag size={11} className="text-indigo-400 flex-shrink-0" />
                  <span className="text-sm font-semibold text-white">{cat}</span>
                  <span className="text-[10px] text-slate-500">
                    {enabled}/{total} on · {ok} ok
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      onClick={() => toggleCategory(cat, !allEnabled)}
                      disabled={busy}
                      className="flex items-center gap-1 px-2 py-1 text-[10px] text-slate-400 hover:text-white hover:bg-white/5 rounded transition-colors"
                      title={allEnabled ? 'Disable all in category' : 'Enable all in category'}
                    >
                      <Power size={10} /> {allEnabled ? 'Disable all' : 'Enable all'}
                    </button>
                    <button
                      onClick={() => renameCategory(cat)}
                      disabled={busy}
                      className="p-1 text-slate-500 hover:text-indigo-400 rounded"
                      title="Rename category"
                    >
                      <Edit2 size={11} />
                    </button>
                    <button
                      onClick={() => deleteCategory(cat)}
                      disabled={busy}
                      className="p-1 text-slate-500 hover:text-red-400 rounded"
                      title={`Delete all ${total} feeds in this category`}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
                {!isCollapsed && (
                  <div className="divide-y divide-[#1e2433]">
                    {rows.map(s => (
                      <SourceRow
                        key={s.id}
                        source={s}
                        categories={allCats}
                        onChange={load}
                        onToggle={toggle}
                        onRemove={remove}
                        flash={flash}
                        selected={selected.has(s.id)}
                        onSelect={toggleSelect}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {adding && (
        <AddFeedDialog
          categories={allCats}
          onClose={() => setAdding(false)}
          onAdded={async () => { await load(); flash('Feed added') }}
        />
      )}
      {bulkAdding && (
        <BulkAddDialog
          categories={allCats}
          onClose={() => setBulkAdding(false)}
          onDone={async (r) => {
            await load()
            flash(`Added ${r.added}; ${r.duplicates} dup, ${r.invalid} invalid`)
          }}
        />
      )}
    </div>
  )
}

function Stat({ label, value, accent, onClick, active }: { label: string; value: number; accent: string; onClick?: () => void; active?: boolean }) {
  const cls = clsx(
    'text-[10px] px-2 py-0.5 rounded-full border flex items-center gap-1 transition-colors',
    onClick ? 'cursor-pointer' : 'cursor-default',
    active ? 'bg-indigo-500/20 border-indigo-500/40' : 'bg-[#0a0f1e] border-[#1e2433] hover:border-[#2d3148]',
  )
  return (
    <button onClick={onClick} className={cls} disabled={!onClick}>
      <span className={accent + ' font-semibold'}>{value}</span>
      <span className="text-slate-500">{label}</span>
    </button>
  )
}

function relTime(iso?: string | null): string {
  if (!iso) return 'never'
  const ms = iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? new Date(iso).getTime() : new Date(iso + 'Z').getTime()
  const diff = Date.now() - ms
  if (diff < 0) return 'in future'
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

function SourceRow({ source, categories, onChange, onToggle, onRemove, flash, selected, onSelect }: {
  source: RssSource
  categories: string[]
  onChange: () => Promise<void>
  onToggle: (s: RssSource) => Promise<void>
  onRemove: (s: RssSource) => Promise<void>
  flash: (m: string, err?: boolean) => void
  selected?: boolean
  onSelect?: (id: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState(source.url)
  const [name, setName] = useState(source.name || '')
  const [category, setCategory] = useState(source.category)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await sourcesApi.update(source.id, {
        url: url.trim(),
        name: name.trim(),
        category: category.trim(),
      })
      setEditing(false)
      await onChange()
    } catch (e: unknown) {
      flash(e instanceof Error ? e.message : String(e), true)
    } finally { setSaving(false) }
  }

  function cancel() {
    setUrl(source.url); setName(source.name || ''); setCategory(source.category)
    setEditing(false)
  }

  const statusColor = {
    ok: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
    empty: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
    error: 'text-red-400 bg-red-500/10 border-red-500/30',
  }[source.last_status || ''] || 'text-slate-500 bg-slate-500/5 border-slate-500/20'

  return (
    <div className={clsx(
      'px-3 py-1.5 transition-colors flex items-center gap-2 text-xs',
      selected ? 'bg-indigo-500/5 hover:bg-indigo-500/10' : 'hover:bg-white/5',
    )}>
      {/* Selection checkbox */}
      <button
        onClick={() => onSelect?.(source.id)}
        className={clsx(
          'flex-shrink-0 transition-colors',
          selected ? 'text-indigo-400' : 'text-slate-600 hover:text-slate-400',
        )}
        title={selected ? 'Deselect' : 'Select'}
      >
        {selected ? <CheckSquare size={13} /> : <Square size={13} />}
      </button>
      {/* Enable/disable checkbox */}
      <input
        type="checkbox"
        checked={source.enabled}
        onChange={() => onToggle(source)}
        className="cursor-pointer accent-indigo-500 flex-shrink-0"
        title={source.enabled ? 'Enabled' : 'Disabled'}
      />
      {editing ? (
        <>
          <input
            value={category}
            onChange={e => setCategory(e.target.value)}
            list="src-cat-list"
            className="bg-[#0d1117] border border-[#1e2433] rounded px-1.5 py-0.5 text-[11px] text-indigo-300 font-mono w-28 focus:outline-none focus:border-indigo-500"
          />
          <datalist id="src-cat-list">
            {categories.map(c => <option key={c} value={c} />)}
          </datalist>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            className="flex-1 bg-[#0d1117] border border-[#1e2433] rounded px-1.5 py-0.5 text-[11px] text-white font-mono focus:outline-none focus:border-indigo-500"
          />
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="display name"
            className="bg-[#0d1117] border border-[#1e2433] rounded px-1.5 py-0.5 text-[11px] text-slate-300 w-32 focus:outline-none focus:border-indigo-500"
          />
          <button onClick={save} disabled={saving} className="p-1 text-emerald-400 hover:bg-emerald-500/10 rounded">
            {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          </button>
          <button onClick={cancel} className="p-1 text-slate-500 hover:bg-white/5 rounded">
            <X size={11} />
          </button>
        </>
      ) : (
        <>
          <span className={clsx('text-[10px] px-1.5 py-0.5 rounded border font-mono', statusColor)}
                title={source.last_error || `last fetched: ${relTime(source.last_fetched_at)}`}>
            {source.last_status || '—'}
          </span>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 truncate text-slate-400 hover:text-indigo-300 font-mono"
            title={source.url}
          >
            {source.name ? <span className="text-white">{source.name}</span> : null}
            {source.name ? <span className="text-slate-600 ml-2">{source.url}</span> : source.url}
          </a>
          <span className="text-[10px] text-slate-600 flex-shrink-0">{relTime(source.last_fetched_at)}</span>
          <button
            onClick={() => setEditing(true)}
            className="p-1 text-slate-500 hover:text-indigo-400 hover:bg-white/5 rounded"
            title="Edit"
          >
            <Edit2 size={11} />
          </button>
          <button
            onClick={() => onRemove(source)}
            className="p-1 text-slate-500 hover:text-red-400 hover:bg-white/5 rounded"
            title="Delete"
          >
            <Trash2 size={11} />
          </button>
        </>
      )}
    </div>
  )
}

function AddFeedDialog({ categories, onClose, onAdded }: {
  categories: string[]
  onClose: () => void
  onAdded: () => Promise<void>
}) {
  const [url, setUrl] = useState('')
  const [category, setCategory] = useState(categories[0] || 'world_news')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit() {
    setBusy(true); setErr('')
    try {
      await sourcesApi.create({ url: url.trim(), category: category.trim() || 'general', name: name.trim() || undefined, enabled: true })
      await onAdded()
      onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <Modal title="Add RSS Feed" onClose={onClose}>
      <Field label="URL">
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !busy && submit()}
          placeholder="https://example.com/feed.xml"
          autoFocus
          className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Category">
          <input
            value={category}
            onChange={e => setCategory(e.target.value)}
            list="addfeed-cat-list"
            placeholder="world_news"
            className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
          />
          <datalist id="addfeed-cat-list">
            {categories.map(c => <option key={c} value={c} />)}
          </datalist>
        </Field>
        <Field label="Display name (optional)">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Reuters World"
            className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
          />
        </Field>
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-400 hover:text-white">Cancel</button>
        <button
          onClick={submit}
          disabled={busy || !url.trim()}
          className="flex items-center gap-2 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded text-sm text-white font-medium"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          Add
        </button>
      </div>
    </Modal>
  )
}

function BulkAddDialog({ categories, onClose, onDone }: {
  categories: string[]
  onClose: () => void
  onDone: (r: { added: number; duplicates: number; invalid: number; errors: string[] }) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [category, setCategory] = useState(categories[0] || 'world_news')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit() {
    const urls = text.split('\n').map(s => s.trim()).filter(Boolean)
    if (!urls.length) { setErr('Paste at least one URL'); return }
    setBusy(true); setErr('')
    try {
      const r = await sourcesApi.bulkCreate({ urls, category: category.trim() || 'general', enabled: true })
      await onDone(r)
      onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const urlCount = text.split('\n').map(s => s.trim()).filter(Boolean).length

  return (
    <Modal title="Bulk Add Feeds" onClose={onClose}>
      <Field label={`URLs — one per line (${urlCount} detected)`}>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={10}
          placeholder={'https://example.com/feed.xml\nhttps://another.com/rss\nhttps://third.org/atom.xml'}
          autoFocus
          className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-indigo-500 resize-y"
        />
      </Field>
      <Field label="Category for all">
        <input
          value={category}
          onChange={e => setCategory(e.target.value)}
          list="bulk-cat-list"
          className="w-full bg-[#0a0f1e] border border-[#1e2433] rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
        />
        <datalist id="bulk-cat-list">
          {categories.map(c => <option key={c} value={c} />)}
        </datalist>
      </Field>
      {err && <p className="text-xs text-red-400">{err}</p>}
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-400 hover:text-white">Cancel</button>
        <button
          onClick={submit}
          disabled={busy || !urlCount}
          className="flex items-center gap-2 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded text-sm text-white font-medium"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
          Add {urlCount || ''} feed{urlCount === 1 ? '' : 's'}
        </button>
      </div>
    </Modal>
  )
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-[#0d1117] border border-[#1e2433] rounded-2xl w-full max-w-xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1e2433]">
          <h3 className="text-base font-bold text-white">{title}</h3>
          <button onClick={onClose} className="p-1.5 text-slate-500 hover:text-white hover:bg-white/10 rounded">
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3">{children}</div>
      </div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#0d1117] border border-[#1e2433] rounded-xl p-5">
      <h2 className="text-sm font-bold text-white uppercase tracking-wider mb-4">{title}</h2>
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1.5">{label}</label>
      {children}
    </div>
  )
}

function KeyRow({
  label, field, hasKey, form, set, showKeys, toggleShow
}: {
  label: string
  field: keyof SettingsUpdate
  hasKey?: boolean
  form: SettingsUpdate
  set: (k: keyof SettingsUpdate, v: string | boolean | number) => void
  showKeys: Record<string, boolean>
  toggleShow: (k: string) => void
}) {
  const show = showKeys[field]
  const value = (form[field] as string) || ''
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs font-medium text-slate-500">{label}</label>
        {hasKey && !value && (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <CheckCircle size={11} /> Configured
          </span>
        )}
      </div>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => set(field, e.target.value)}
          placeholder={hasKey ? '••••••••••••••••' : 'Enter key…'}
          className="input pr-10"
        />
        <button
          type="button"
          onClick={() => toggleShow(field)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-600 hover:text-slate-300 transition-colors"
        >
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </div>
  )
}
