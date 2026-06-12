// API base resolution, in order of precedence:
//   1. NEXT_PUBLIC_API_BASE — explicit override (e.g. "https://api.example.com").
//   2. In the browser: same host as the page, port 8000 (so a remote user opening
//      http://10.0.0.5:3000 will call http://10.0.0.5:8000 instead of localhost).
//   3. SSR fallback: localhost:8000 (only used at build time).
function resolveBase(): string {
  const env = process.env.NEXT_PUBLIC_API_BASE
  if (env && env.trim()) return env.trim().replace(/\/$/, '')
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:8000`
  }
  return 'http://localhost:8000'
}

const BASE = resolveBase()

// ─── Auth token (localStorage bearer) ──────────────────────────────────────────
const TOKEN_KEY = 'np_auth_token'

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null
  try { return window.localStorage.getItem(TOKEN_KEY) } catch { return null }
}

export function setAuthToken(token: string): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(TOKEN_KEY, token) } catch {}
}

export function clearAuthToken(): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(TOKEN_KEY) } catch {}
}

// Resolve a possibly-relative media URL (e.g. /media/telegram/x.jpg from the API)
// to an absolute URL against the backend, so <img> tags load from the API host.
export function resolveMediaUrl(url?: string | null): string | undefined {
  if (!url) return undefined
  if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url
  if (url.startsWith('/')) return `${BASE}${url}`
  return url
}

function redirectToSignin(): void {
  if (typeof window === 'undefined') return
  if (window.location.pathname !== '/signin') {
    window.location.href = '/signin'
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken()
  const headers = new Headers(options?.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(`${BASE}${path}`, { ...options, headers })
  if (!res.ok) {
    // Session expired / invalid → clear token and bounce to the sign-in page
    // (but never for the login call itself, which legitimately 401s on bad creds).
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      clearAuthToken()
      redirectToSignin()
    }
    const text = await res.text()
    // FastAPI wraps errors in {"detail": "..."} (or an array). Unwrap for cleaner messages.
    let msg = text || `HTTP ${res.status}`
    try {
      const json = JSON.parse(text)
      if (typeof json?.detail === 'string') msg = json.detail
      else if (Array.isArray(json?.detail)) msg = json.detail.map((d: { msg?: string }) => d.msg || JSON.stringify(d)).join('; ')
    } catch {}
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: number
  username: string
  is_admin: boolean
  is_active: boolean
  created_at?: string
  last_login_at?: string
}

export interface LoginResponse {
  access_token: string
  token_type: string
  expires_in: number
  user: AuthUser
}

export const authApi = {
  login(username: string, password: string) {
    return request<LoginResponse>('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
  },
  me() {
    return request<AuthUser>('/auth/me')
  },
  changePassword(current_password: string, new_password: string) {
    return request<{ changed: boolean }>('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password, new_password }),
    })
  },
  listUsers() {
    return request<AuthUser[]>('/auth/users')
  },
  createUser(username: string, password: string, is_admin: boolean) {
    return request<AuthUser>('/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, is_admin }),
    })
  },
  updateUser(id: number, patch: { username?: string; is_active?: boolean; is_admin?: boolean }) {
    return request<AuthUser>(`/auth/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  },
  resetUserPassword(id: number, new_password: string) {
    return request<AuthUser>(`/auth/users/${id}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_password }),
    })
  },
  deleteUser(id: number) {
    return request<{ deleted: boolean; id: number }>(`/auth/users/${id}`, { method: 'DELETE' })
  },
}

export interface Article {
  id: number
  url: string
  title: string
  source?: string
  category?: string
  published_at?: string
  fetched_at: string
  content?: string
  summary?: string
  author?: string
  image_url?: string
  is_analyzed: boolean
  tags?: string[]
  media_urls?: string[]
}

export type ImpactType = 'highly_positive' | 'positive' | 'neutral' | 'negative' | 'highly_negative'

export interface Analysis {
  id: number
  article_id?: number
  created_at: string
  focus?: string
  model_used?: string
  summary?: string
  impact_type?: ImpactType
  economic_impact?: string
  market_analysis?: string
  geopolitical_factors?: string
  risk_assessment?: string
  opportunities?: string
  prognosis_short?: string
  prognosis_long?: string
  key_indicators: string[]
  affected_sectors: string[]
  affected_regions: string[]
  categories: Record<string, string[]>
  confidence_score?: number
}

export interface DirectedReportRequest {
  focus: string
  category?: string
  tag?: string
  include_web?: boolean
  include_web_search?: boolean
  time_window_hours?: number
  max_web_results?: number
  fetch_web_content?: boolean
  language?: string
}

export interface DirectedReportRef {
  kind: 'db' | 'web' | 'article'
  id?: number
  title?: string
  url?: string
  source?: string
  published_at?: string
  snippet?: string
}

export interface ChatResponse {
  response: string
  needs_web?: boolean
  web_query?: string
  used_web?: boolean
  references?: DirectedReportRef[]
  suggested_web_query?: string
}

export interface DirectedReportListItem {
  id: number
  focus: string
  created_at?: string
  headline?: string
  impact_type?: ImpactType
  db_article_count: number
  web_result_count: number
}

export interface DirectedReport {
  id: number
  focus: string
  created_at: string
  model_used?: string
  headline?: string
  executive_summary?: string
  key_developments: string[]
  economic_impact?: string
  market_impact?: string
  geopolitical_impact?: string
  sector_impact: Record<string, string>
  risk_assessment?: string
  opportunities?: string
  contrarian_views?: string
  prognosis_short?: string
  prognosis_long?: string
  signals_to_watch: string[]
  confidence_score?: number
  impact_type?: ImpactType
  references: DirectedReportRef[]
  db_article_count: number
  web_result_count: number
}

export interface StockSearchResult {
  ticker: string
  name: string
  exchange?: string
  type?: string
}

export interface StockPricePoint {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface StockAnalysis {
  id: number
  ticker: string
  company_name?: string
  created_at: string
  price?: number
  change_pct?: number
  market_cap?: number
  sector?: string
  summary?: string
  technical_summary?: string
  news_impact?: string
  prognosis_short?: string
  prognosis_long?: string
  impact_type?: string
  risk_level?: string
  confidence_score?: number
  key_levels: Record<string, number>
  catalysts: string[]
  price_history: StockPricePoint[]
  quote_snapshot: Record<string, unknown>
  references?: { title?: string; url?: string; source?: string; snippet?: string }[]
}

export interface KeyStatus {
  has_key: boolean
  provider?: string
}

export interface AppSettingsOut {
  default_ai_provider: string
  default_ai_model: string
  anthropic_api_key: KeyStatus
  openai_api_key: KeyStatus
  gemini_api_key: KeyStatus
  deepseek_api_key: KeyStatus
  custom_ai_api_key: KeyStatus
  fred_api_key: KeyStatus
  alpha_vantage_api_key: KeyStatus
  polygon_api_key: KeyStatus
  google_search_api_key: KeyStatus
  google_search_cx: KeyStatus
  bing_search_api_key: KeyStatus
  news_api_key: KeyStatus
  telegram_api_id: KeyStatus
  telegram_api_hash: KeyStatus
  telegram_phone: KeyStatus
  custom_ai_endpoint?: string
  custom_ai_model?: string
  chat_system_prompt: string
  ask_system_prompt: string
  directed_report_system_prompt: string
  summary_system_prompt: string
  chat_system_prompt_default: string
  ask_system_prompt_default: string
  directed_report_system_prompt_default: string
  summary_system_prompt_default: string
  chat_system_prompt_customized: boolean
  ask_system_prompt_customized: boolean
  directed_report_system_prompt_customized: boolean
  summary_system_prompt_customized: boolean
  article_summarize_prompt: string
  article_summarize_prompt_default: string
  article_summarize_prompt_customized: boolean
  stock_system_prompt: string
  stock_system_prompt_default: string
  stock_system_prompt_customized: boolean
  image_analysis_prompt: string
  image_analysis_prompt_default: string
  image_analysis_prompt_customized: boolean
  link_analysis_prompt: string
  link_analysis_prompt_default: string
  link_analysis_prompt_customized: boolean
  auto_analyze_enabled: boolean
  fetch_interval_minutes: number
  auto_tag_interval_minutes: number
  chat_chunk_size: number
  entertainment_keywords: string
  entertainment_keywords_default: string
  entertainment_keywords_customized: boolean
}

export interface SettingsUpdate {
  default_ai_provider?: string
  default_ai_model?: string
  anthropic_api_key?: string
  openai_api_key?: string
  gemini_api_key?: string
  deepseek_api_key?: string
  custom_ai_api_key?: string
  custom_ai_endpoint?: string
  custom_ai_model?: string
  fred_api_key?: string
  alpha_vantage_api_key?: string
  polygon_api_key?: string
  google_search_api_key?: string
  google_search_cx?: string
  bing_search_api_key?: string
  telegram_api_id?: string
  telegram_api_hash?: string
  telegram_phone?: string
  news_api_key?: string
  chat_system_prompt?: string
  ask_system_prompt?: string
  directed_report_system_prompt?: string
  summary_system_prompt?: string
  article_summarize_prompt?: string
  stock_system_prompt?: string
  image_analysis_prompt?: string
  link_analysis_prompt?: string
  auto_analyze_enabled?: boolean
  fetch_interval_minutes?: number
  auto_tag_interval_minutes?: number
  chat_chunk_size?: number
  entertainment_keywords?: string
}

export interface SummaryRequest {
  filter_type?: 'tag' | 'category' | 'keyword'
  filter_value?: string
  time_window_hours?: number
  max_articles?: number   // 0 = All (up to 5000)
  custom_prompt?: string  // extra instructions appended to system prompt
  language?: string       // "" / "English" → no change; other values → respond in that language
  article_ids?: number[]  // if set, summarize exactly these articles (ignores filters/window)
}

export interface SummarySourceRef {
  title?: string
  url: string
  source?: string
  published_at?: string
}

export interface SummaryResponse {
  summary: string
  key_themes: string[]
  notable_sources: string[]
  time_span: string
  article_count: number
  sources: SummarySourceRef[]
  filter_type: string
  filter_value: string
}

export interface TimelineBucket {
  start: string
  count: number
  tension: number
  escalation: number
  sentiment: number
}

export interface TimelineRow {
  label: string
  kind: 'country' | 'topic'
  total: number
}

export interface TimelineResponse {
  total: number
  buckets: TimelineBucket[]
  rows: TimelineRow[]
  matrix: number[][]
  max_count: number
  max_tension: number
  max_cell: number
  max_sentiment: number
  top_terms: { term: string; count: number }[]
  granularity: string
  bucket_seconds: number
  start: string | null
  end: string | null
  all_countries: string[]
  all_topics: string[]
}

export interface TimelineRequest {
  filter_type?: 'tag' | 'category' | 'keyword'
  filter_value?: string
  time_window_hours?: number
  max_articles?: number
  granularity?: string   // auto|15min|30min|hour|3hour|6hour|day|week
  country?: string | null
  topic?: string | null
  q?: string | null
}

export interface TimelineArticle {
  id: number
  title: string | null
  source: string | null
  url: string | null
  category: string | null
  published_at: string | null
  tension: number
  terms: string[]
}

export interface MindMapNode {
  kind: string
  explanation: string
  items: string[]
}

export interface MindMapAspect {
  summary: string
  reasoning: string
  whyItMatters: string
  categories: MindMapNode[]
}

export interface MindMapData {
  subject: string
  summary: string
  reasoning: string
  whyItMatters: string
  outcome: string
  prognosis: { shortTerm: string; longTerm: string }
  aspects: Record<string, MindMapAspect>
}

export interface MindMapOut {
  id: number
  subject: string
  created_at: string
  aspects: string[]
  model_used?: string
  map_data: MindMapData
}

// ─── Articles ─────────────────────────────────────────────────────────────────

export interface ArticleIn {
  title?: string
  content: string
  url?: string
  category?: string       // defaults to "post" on the server
  source?: string
  author?: string
  summary?: string
  published_at?: string
  is_html?: boolean
}

export const articlesApi = {
  /** Create an article manually. Category defaults to "post" when omitted. */
  create(body: ArticleIn) {
    return request<Article>('/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  list(params?: { skip?: number; limit?: number; category?: string; q?: string; tag?: string; untagged?: boolean; hours?: number }) {
    const qp = new URLSearchParams()
    if (params?.skip !== undefined) qp.set('skip', String(params.skip))
    if (params?.limit !== undefined) qp.set('limit', String(params.limit))
    if (params?.category) qp.set('category', params.category)
    if (params?.q) qp.set('q', params.q)
    if (params?.tag) qp.set('tag', params.tag)
    if (params?.untagged) qp.set('untagged', 'true')
    if (params?.hours) qp.set('hours', String(params.hours))
    const qs = qp.toString()
    return request<Article[]>(`/articles${qs ? '?' + qs : ''}`)
  },

  categories() {
    return request<string[]>('/articles/categories')
  },

  tags() {
    return request<string[]>('/articles/tags')
  },

  count(params?: { category?: string; q?: string; tag?: string; untagged?: boolean; hours?: number }) {
    const qp = new URLSearchParams()
    if (params?.category) qp.set('category', params.category)
    if (params?.q) qp.set('q', params.q)
    if (params?.tag) qp.set('tag', params.tag)
    if (params?.untagged) qp.set('untagged', 'true')
    if (params?.hours) qp.set('hours', String(params.hours))
    const qs = qp.toString()
    return request<{ count: number }>(`/articles/count${qs ? '?' + qs : ''}`)
  },

  fetchAll() {
    return request<{ fetched: number; new_article_ids: number[] }>('/articles/fetch-all', { method: 'POST' })
  },

  get(id: number) {
    return request<Article>(`/articles/${id}`)
  },

  delete(id: number) {
    return request<void>(`/articles/${id}`, { method: 'DELETE' })
  },

  fetchFeed(body: { url: string; category?: string }) {
    return request<Article[]>('/articles/fetch-feed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  addManual(body: {
    title?: string
    content: string
    summary?: string
    source?: string
    category?: string
    url?: string
    author?: string
    published_at?: string
    is_html?: boolean
  }) {
    return request<Article>('/articles/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  addFromUrl(body: { url: string; category?: string }) {
    return request<Article>('/articles/from-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  addFromDocument(file: File, opts?: { title?: string; category?: string; source?: string }) {
    const fd = new FormData()
    fd.append('file', file)
    if (opts?.title) fd.append('title', opts.title)
    if (opts?.category) fd.append('category', opts.category)
    if (opts?.source) fd.append('source', opts.source)
    return request<Article>('/articles/from-document', {
      method: 'POST',
      body: fd,
    })
  },

  importUrls(urls: string[], category = 'web_search') {
    return request<{ results: Array<{ url: string; status: string; article_id?: number; reason?: string }> }>(
      '/articles/import',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, category }),
      },
    )
  },

  trendingTopics(params?: { limit?: number; hours?: number }) {
    const qp = new URLSearchParams()
    if (params?.limit !== undefined) qp.set('limit', String(params.limit))
    if (params?.hours !== undefined) qp.set('hours', String(params.hours))
    const qs = qp.toString()
    return request<{ topics: string[] }>(`/articles/trending-topics${qs ? '?' + qs : ''}`)
  },

  setTags(id: number, tags: string[]) {
    return request<{ id: number; tags: string[] }>(`/articles/${id}/tags`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    })
  },

  autoTag(id: number) {
    return request<{ id: number; tags: string[] }>(`/articles/${id}/auto-tag`, { method: 'POST' })
  },

  bulkAutoTag(limit = 50, categories?: string[]) {
    const params = new URLSearchParams({ limit: String(limit) })
    if (categories && categories.length > 0) params.set('categories', categories.join(','))
    return request<{ tagged: number; skipped?: number; errors: number; total: number; error_detail?: string }>(
      `/articles/bulk-auto-tag?${params}`,
      { method: 'POST' },
    )
  },

  autoTagByIds(ids: number[]) {
    return request<{ tagged: number; errors: number; total: number }>(
      '/articles/auto-tag-by-ids',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      },
    )
  },

  deleteByIds(ids: number[]) {
    return request<{ deleted: number; total: number }>(
      '/articles/bulk-delete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      },
    )
  },
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

export const analysisApi = {
  list(params?: { skip?: number; limit?: number }) {
    const q = new URLSearchParams()
    if (params?.skip !== undefined) q.set('skip', String(params.skip))
    if (params?.limit !== undefined) q.set('limit', String(params.limit))
    const qs = q.toString()
    return request<Analysis[]>(`/analysis${qs ? '?' + qs : ''}`)
  },

  get(id: number) {
    return request<Analysis>(`/analysis/${id}`)
  },

  analyzeArticle(articleId: number, focus?: string) {
    const qs = focus ? `?focus=${encodeURIComponent(focus)}` : ''
    return request<Analysis>(`/analysis/article/${articleId}${qs}`, { method: 'POST' })
  },

  askAboutArticle(articleId: number, question: string, history: { role: string; content: string }[] = []) {
    return request<{ response: string }>(`/analysis/article/${articleId}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history }),
    })
  },

  factCheckArticle(articleId: number, language?: string) {
    return request<{ response: string; references: unknown[]; used_web: boolean }>(
      `/analysis/article/${articleId}/factcheck`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: language ?? '' }),
      },
    )
  },

  analyzeAttachment(articleId: number, kind: 'image' | 'link', url?: string, language?: string) {
    return request<{ response: string; kind: string; url?: string }>(
      `/analysis/article/${articleId}/analyze-attachment`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, url, language }),
      },
    )
  },

  listForArticle(articleId: number) {
    return request<Analysis[]>(`/analysis?article_id=${articleId}`)
  },

  previewDirected(focus: string, time_window_hours: number, category?: string, tag?: string) {
    const qs = new URLSearchParams({ focus, time_window_hours: String(time_window_hours) })
    if (category) qs.set('category', category)
    if (tag) qs.set('tag', tag)
    return request<{ db_article_count: number }>(`/analysis/directed/preview?${qs}`)
  },

  // Directed synthesis report — see DirectedReport interface
  runDirectedReport(req: DirectedReportRequest) {
    return request<DirectedReport>('/analysis/directed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
  },

  listReports() {
    return request<DirectedReportListItem[]>('/analysis/reports')
  },

  getReport(id: number) {
    return request<DirectedReport>(`/analysis/reports/${id}`)
  },

  deleteReport(id: number) {
    return request<void>(`/analysis/reports/${id}`, { method: 'DELETE' })
  },

  askReport(id: number, question: string, history: Array<{ role: string; content: string }>) {
    return request<{ response: string }>(`/analysis/reports/${id}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history }),
    })
  },

  chat(req: { message: string; history?: { role: string; content: string }[]; use_web?: boolean; web_query?: string }) {
    return request<ChatResponse>('/analysis/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
  },

  summarize(req: SummaryRequest) {
    return request<SummaryResponse>('/analysis/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
  },

  summarizeAsk(req: { summary: string; question: string; history: Array<{ role: string; content: string }> }) {
    return request<{ response: string }>('/analysis/summary/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
  },

  timeline(req: TimelineRequest) {
    return request<TimelineResponse>('/analysis/summary/timeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
  },

  timelineArticles(req: {
    filter_type?: 'tag' | 'category' | 'keyword'
    filter_value?: string
    start: string
    end: string
    country?: string | null
    topic?: string | null
    q?: string | null
    limit?: number
  }) {
    return request<{ articles: TimelineArticle[]; count: number }>('/analysis/summary/timeline/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
  },

  delete(id: number) {
    return request<void>(`/analysis/${id}`, { method: 'DELETE' })
  },
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export const settingsApi = {
  get() {
    return request<AppSettingsOut>('/settings')
  },

  update(data: SettingsUpdate) {
    return request<{ updated: string[]; count: number }>('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  },

  models(provider: string) {
    return request<{ models: string[] }>(`/settings/models?provider=${encodeURIComponent(provider)}`)
  },

  resetKey(key: string) {
    return request<{ reset: string; existed: boolean }>(`/settings/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    })
  },

  getAutoTagCategories() {
    return request<{ categories: string[] }>('/settings/auto-tag-categories')
  },

  getQuickTickers() {
    return request<{ tickers: string[] }>('/settings/quick-tickers')
  },

  getSummaryPresets() {
    return request<{ presets: string[] }>('/settings/summary-presets')
  },

  setSummaryPresets(presets: string[]) {
    return request<{ presets: string[] }>('/settings/summary-presets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presets }),
    })
  },

  getAnalysisFocusPresets() {
    return request<{ presets: string[] }>('/settings/analysis-focus-presets')
  },

  setAnalysisFocusPresets(presets: string[]) {
    return request<{ presets: string[] }>('/settings/analysis-focus-presets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presets }),
    })
  },

  setQuickTickers(tickers: string[]) {
    return request<{ tickers: string[] }>('/settings/quick-tickers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers }),
    })
  },

  setAutoTagCategories(categories: string[]) {
    return request<{ categories: string[] }>('/settings/auto-tag-categories', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories }),
    })
  },
}

// ─── Sources ──────────────────────────────────────────────────────────────────

export interface RssSource {
  id: number
  url: string
  category: string
  name?: string
  enabled: boolean
  created_at?: string
  last_fetched_at?: string
  last_status?: string
  last_error?: string
}

export const sourcesApi = {
  list(params?: { category?: string; enabled?: boolean }) {
    const qp = new URLSearchParams()
    if (params?.category) qp.set('category', params.category)
    if (params?.enabled !== undefined) qp.set('enabled', String(params.enabled))
    const qs = qp.toString()
    return request<RssSource[]>(`/sources${qs ? '?' + qs : ''}`)
  },

  create(body: { url: string; category: string; name?: string; enabled?: boolean }) {
    return request<RssSource>('/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  update(id: number, body: Partial<{ url: string; category: string; name: string; enabled: boolean }>) {
    return request<RssSource>(`/sources/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  delete(id: number) {
    return request<void>(`/sources/${id}`, { method: 'DELETE' })
  },

  reseed() {
    return request<{ added: number }>('/sources/reseed', { method: 'POST' })
  },

  bulkCreate(body: { urls: string[]; category: string; enabled?: boolean }) {
    return request<{ added: number; duplicates: number; invalid: number; errors: string[] }>(
      '/sources/bulk',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
  },

  categoryAction(body: { category: string; enabled?: boolean; rename_to?: string }) {
    return request<{ category: string; rows: number; updated: number }>(
      '/sources/category-action',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
  },

  deleteCategory(category: string) {
    return request<{ deleted: number; category: string }>(
      `/sources/category/${encodeURIComponent(category)}`,
      { method: 'DELETE' },
    )
  },

  bulkDelete(ids: number[]) {
    return request<{ deleted: number }>('/sources/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
  },

  bulkFetch(ids: number[]) {
    return request<{ sources_fetched: number; new_articles: number; errors: number }>(
      '/sources/bulk-fetch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      },
    )
  },

  status() {
    return request<{
      total: number
      enabled: number
      ok: number
      empty: number
      error: number
      last_fetch_at?: string | null
      next_fetch_at?: string | null
      fetch_interval_minutes: number
    }>('/sources/status')
  },

  setNextRun(utcIso: string) {
    return request<{ next_run_at: string; ok: boolean }>('/sources/set-next-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ next_run_at: utcIso }),
    })
  },
}

// ─── Telegram ────────────────────────────────────────────────────────────────

export interface TelegramSource {
  id: number
  channel_id: string
  name?: string
  enabled: boolean
  lookback_hours: number
  created_at?: string
  last_fetched_at?: string
  last_status?: string
  last_error?: string
  message_count: number
}

export interface TelegramUnreadChannel {
  channel_id: string
  name: string
  unread_count: number
  is_group: boolean
  is_channel: boolean
  already_added: boolean
}

export const telegramApi = {
  authStatus() {
    return request<{ authorized: boolean; reason?: string }>('/telegram/auth/status')
  },

  requestCode(phone: string) {
    return request<{ sent: boolean; phone: string }>('/telegram/auth/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    })
  },

  signIn(code: string, password?: string) {
    return request<{ authorized: boolean }>('/telegram/auth/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, password: password ?? '' }),
    })
  },

  list() {
    return request<TelegramSource[]>('/telegram')
  },

  create(body: { channel_id: string; name?: string; enabled?: boolean; lookback_hours?: number }) {
    return request<TelegramSource>('/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  update(id: number, body: Partial<{ channel_id: string; name: string; enabled: boolean; lookback_hours: number }>) {
    return request<TelegramSource>(`/telegram/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  delete(id: number) {
    return request<void>(`/telegram/${id}`, { method: 'DELETE' })
  },

  fetchAll() {
    return request<{ sources_fetched: number; new_articles: number }>('/telegram/fetch', { method: 'POST' })
  },

  fetchOne(id: number) {
    return request<{ new_articles: number; ids: number[] }>(`/telegram/${id}/fetch`, { method: 'POST' })
  },

  backfillImages() {
    return request<{ updated: number }>('/telegram/backfill-images', { method: 'POST' })
  },

  listUnread() {
    return request<TelegramUnreadChannel[]>('/telegram/unread')
  },
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

export interface WhatsAppStatus {
  ready: boolean
  authenticated: boolean
  connecting?: boolean
  qr?: string | null
  error?: string
}

export interface WhatsAppChat {
  id: string
  name?: string
  isGroup: boolean
  unreadCount: number
  timestamp?: number | null
  already_added: boolean
}

export interface WhatsAppSource {
  id: number
  chat_id: string
  name?: string
  is_group: boolean
  enabled: boolean
  lookback_hours: number
  created_at?: string
  last_fetched_at?: string
  last_status?: string
  last_error?: string
  message_count: number
}

export const whatsappApi = {
  authStatus() {
    return request<WhatsAppStatus>('/whatsapp/auth/status')
  },
  connect() {
    return request<{ ok: boolean; connecting?: boolean; ready?: boolean }>('/whatsapp/auth/connect', { method: 'POST' })
  },
  disconnect() {
    return request<{ ok: boolean }>('/whatsapp/auth/disconnect', { method: 'POST' })
  },
  listChats() {
    return request<WhatsAppChat[]>('/whatsapp/chats')
  },
  list() {
    return request<WhatsAppSource[]>('/whatsapp')
  },
  create(body: { chat_id: string; name?: string; is_group?: boolean; lookback_hours?: number; enabled?: boolean }) {
    return request<WhatsAppSource>('/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },
  update(id: number, patch: { name?: string; enabled?: boolean; lookback_hours?: number }) {
    return request<WhatsAppSource>(`/whatsapp/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  },
  remove(id: number) {
    return request<{ deleted: boolean; id: number }>(`/whatsapp/${id}`, { method: 'DELETE' })
  },
  fetchAll() {
    return request<{ sources_fetched: number; new_articles: number }>('/whatsapp/fetch', { method: 'POST' })
  },
  fetchOne(id: number) {
    return request<{ new_articles: number; ids: number[] }>(`/whatsapp/${id}/fetch`, { method: 'POST' })
  },
}

// ─── Twitter / X ──────────────────────────────────────────────────────────────

export interface TwitterStatus {
  authenticated: boolean
  error?: string
}

export interface TwitterSource {
  id: number
  handle: string
  kind: 'user' | 'list' | 'search' | string
  name?: string
  enabled: boolean
  lookback_hours: number
  created_at?: string
  last_fetched_at?: string
  last_status?: string
  last_error?: string
  message_count: number
}

export const twitterApi = {
  authStatus() {
    return request<TwitterStatus>('/twitter/auth/status')
  },
  login(body: { username: string; email?: string; password: string; totp_secret?: string }) {
    return request<{ authenticated: boolean }>('/twitter/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },
  loginWithCookies(auth_token: string, ct0: string) {
    return request<{ authenticated: boolean; verified?: boolean; warning?: string }>('/twitter/auth/cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_token, ct0 }),
    })
  },
  logout() {
    return request<{ authenticated: boolean }>('/twitter/auth/logout', { method: 'POST' })
  },
  list() {
    return request<TwitterSource[]>('/twitter')
  },
  create(body: { handle: string; kind?: string; name?: string; lookback_hours?: number; enabled?: boolean }) {
    return request<TwitterSource>('/twitter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },
  update(id: number, patch: { name?: string; enabled?: boolean; lookback_hours?: number }) {
    return request<TwitterSource>(`/twitter/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  },
  remove(id: number) {
    return request<{ deleted: boolean; id: number }>(`/twitter/${id}`, { method: 'DELETE' })
  },
  fetchAll() {
    return request<{ sources_fetched: number; new_articles: number }>('/twitter/fetch', { method: 'POST' })
  },
  fetchOne(id: number) {
    return request<{ new_articles: number; ids: number[] }>(`/twitter/${id}/fetch`, { method: 'POST' })
  },
  getAutofetch() {
    return request<{ enabled: boolean; interval_minutes: number }>('/twitter/autofetch')
  },
  setAutofetch(enabled: boolean, interval_minutes: number) {
    return request<{ enabled: boolean; interval_minutes: number }>('/twitter/autofetch', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, interval_minutes }),
    })
  },
}

// ─── Stocks ───────────────────────────────────────────────────────────────────

export const stocksApi = {
  search(q: string) {
    return request<StockSearchResult[]>(`/stocks/search?q=${encodeURIComponent(q)}`)
  },

  getQuote(ticker: string) {
    return request<Record<string, unknown>>(`/stocks/${encodeURIComponent(ticker)}/quote`)
  },

  getHistory(ticker: string) {
    return request<StockPricePoint[]>(`/stocks/${encodeURIComponent(ticker)}/history`)
  },

  analyze(ticker: string, opts?: { include_web?: boolean; include_web_search?: boolean; language?: string }) {
    const qp = new URLSearchParams()
    if (opts?.include_web) qp.set('include_web', 'true')
    if (opts?.include_web_search) qp.set('include_web_search', 'true')
    if (opts?.language) qp.set('language', opts.language)
    const qs = qp.toString()
    return request<StockAnalysis>(`/stocks/${encodeURIComponent(ticker)}/analyze${qs ? '?' + qs : ''}`, {
      method: 'POST',
    })
  },

  getAnalyses() {
    return request<StockAnalysis[]>('/stocks/analyses')
  },

  getLatest(ticker: string) {
    return request<StockAnalysis>(`/stocks/${encodeURIComponent(ticker)}/latest`)
  },

  ask(ticker: string, question: string, history: Array<{ role: string; content: string }>) {
    return request<{ response: string }>(`/stocks/${encodeURIComponent(ticker)}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history }),
    })
  },
}

// ─── Web Search ──────────────────────────────────────────────────────────────

export interface WebSearchResult {
  title: string
  url: string
  snippet?: string
  source?: string
  published_at?: string
  engine: 'duckduckgo' | 'bing' | 'google' | 'google_cse' | 'yahoo' | 'startpage' | string
}

export interface WebSearchResponse {
  results: WebSearchResult[]
  total: number
  engines: { duckduckgo: number; bing: number; google: number; yahoo: number; startpage: number }
  per_engine?: { duckduckgo: WebSearchResult[]; bing: WebSearchResult[]; google: WebSearchResult[]; yahoo: WebSearchResult[]; startpage: WebSearchResult[] }
  error?: string
}

export const searchApi = {
  search(q: string, num = 100) {
    return request<WebSearchResponse>(`/search?q=${encodeURIComponent(q)}&num=${num}`)
  },

  summarize(req: { query?: string; results: WebSearchResult[]; language?: string }) {
    return request<{ summary: string; count: number; truncated: boolean }>('/search/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: req.query,
        language: req.language,
        results: req.results.map(r => ({
          title: r.title, url: r.url, snippet: r.snippet, source: r.source, published_at: r.published_at,
        })),
      }),
    })
  },
}

// ─── Logs ────────────────────────────────────────────────────────────────────

export interface LogListResponse {
  source: 'app' | 'client'
  path: string
  count: number
  size_bytes: number
  lines: string[]
}

export interface LogFileInfo {
  name: string
  size_bytes: number
  modified_at: string
}

export interface LogSettings {
  log_retention_hours: number
  log_level: string
}

export const logsApi = {
  list(params?: { source?: 'app' | 'client'; limit?: number; level?: string; q?: string }) {
    const qp = new URLSearchParams()
    if (params?.source) qp.set('source', params.source)
    if (params?.limit) qp.set('limit', String(params.limit))
    if (params?.level) qp.set('level', params.level)
    if (params?.q) qp.set('q', params.q)
    return request<LogListResponse>(`/logs?${qp.toString()}`)
  },

  files() {
    return request<{ dir: string; files: LogFileInfo[] }>('/logs/files')
  },

  getSettings() {
    return request<LogSettings>('/logs/settings')
  },

  updateSettings(body: Partial<LogSettings>) {
    return request<LogSettings>('/logs/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  },

  clear(source: 'app' | 'client' | 'all') {
    return request<{ cleared: string[] }>(`/logs?source=${source}`, { method: 'DELETE' })
  },
}

// ─── MindMap ──────────────────────────────────────────────────────────────────

export const mindmapApi = {
  list() {
    return request<MindMapOut[]>('/mindmap')
  },

  generate(
    subject: string,
    aspects: string[],
    grounding?: {
      category?: string
      tag?: string
      keyword?: string
      time_window_hours?: number
      include_web?: boolean
      include_web_search?: boolean
    },
  ) {
    return request<MindMapOut>('/mindmap/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, aspects, ...grounding }),
    })
  },

  get(id: number) {
    return request<MindMapOut>(`/mindmap/${id}`)
  },

  delete(id: number) {
    return request<void>(`/mindmap/${id}`, { method: 'DELETE' })
  },
}
