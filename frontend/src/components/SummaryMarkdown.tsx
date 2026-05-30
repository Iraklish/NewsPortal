'use client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  content: string
  className?: string
}

/**
 * Markdown renderer tuned for the subject-tagged summary format:
 *
 *   **Subject 1**: overview, sources
 *     - point one
 *     - point two
 *
 * Visual contract:
 *   • Each paragraph (= subject header) gets a subtle indigo left-border accent,
 *     generous top spacing, and `strong` text rendered white-bold.
 *   • List items use a coloured ▸ bullet and are indented under their subject.
 *   • Heading-based formats (# H1 / ## H2 …) are also handled for flexibility.
 */
export default function SummaryMarkdown({ content, className = '' }: Props) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          /* ── Headings ─────────────────────────────────────────────────── */
          h1: props => (
            <h1
              {...props}
              className="text-base font-bold text-white border-b border-[#1e2433] pb-2
                         mt-7 mb-2 first:mt-0 leading-snug"
            />
          ),
          h2: props => (
            <h2
              {...props}
              className="text-sm font-bold text-white border-b border-[#1e2433] pb-1.5
                         mt-6 mb-2 first:mt-0 leading-snug"
            />
          ),
          h3: props => (
            <h3
              {...props}
              className="text-sm font-semibold text-slate-200 mt-4 mb-1.5 first:mt-0"
            />
          ),
          h4: props => (
            <h4
              {...props}
              className="text-xs font-semibold text-slate-300 uppercase tracking-wider
                         mt-3 mb-1 first:mt-0"
            />
          ),

          /* ── Paragraph — subject header in the subject-tagged format ─── */
          p: props => (
            <p
              {...props}
              className="text-sm text-slate-300 leading-relaxed
                         mt-5 mb-1.5 first:mt-0
                         border-l-2 border-indigo-500/30 pl-3"
            />
          ),

          /* ── Inline styles ────────────────────────────────────────────── */
          strong: props => (
            <strong {...props} className="text-white font-bold" />
          ),
          em: props => (
            <em {...props} className="text-slate-400 italic" />
          ),

          /* ── Lists ────────────────────────────────────────────────────── */
          ul: props => (
            <ul
              {...props}
              className="mt-0 mb-3 ml-3 space-y-1.5"
            />
          ),
          ol: props => (
            <ol
              {...props}
              className="list-decimal ml-8 mt-0 mb-3 space-y-1.5 text-sm text-slate-300"
            />
          ),
          li: ({ children }) => (
            <li className="flex gap-2 items-start text-sm text-slate-300 leading-relaxed">
              <span className="text-indigo-400 shrink-0 select-none mt-[0.3em] text-[10px]">
                ▸
              </span>
              <span className="flex-1">{children}</span>
            </li>
          ),

          /* ── Block elements ───────────────────────────────────────────── */
          hr: () => (
            <hr className="border-[#1e2433] my-6" />
          ),
          blockquote: props => (
            <blockquote
              {...props}
              className="border-l-2 border-indigo-500/50 pl-4 my-3
                         text-slate-400 italic text-sm"
            />
          ),

          /* ── Code ─────────────────────────────────────────────────────── */
          pre: ({ children }) => (
            <pre
              className="bg-[#161b22] border border-[#1e2433] rounded-lg
                         p-4 my-3 overflow-x-auto text-xs font-mono leading-relaxed"
            >
              {children}
            </pre>
          ),
          code: ({ className: cls, children }) =>
            cls?.startsWith('language-') ? (
              <code className={`${cls} font-mono text-slate-300 text-xs`}>{children}</code>
            ) : (
              <code
                className="px-1.5 py-0.5 bg-[#161b22] border border-[#1e2433] rounded
                           text-xs text-indigo-300 font-mono"
              >
                {children}
              </code>
            ),

          /* ── Links ────────────────────────────────────────────────────── */
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 hover:text-indigo-300 underline
                         underline-offset-2 transition-colors"
            >
              {children}
            </a>
          ),

          /* ── Tables (optional) ────────────────────────────────────────── */
          table: props => (
            <div className="overflow-x-auto my-4">
              <table {...props} className="w-full text-sm border-collapse" />
            </div>
          ),
          thead: props => <thead {...props} className="bg-[#161b22]" />,
          tr:    props => <tr    {...props} className="even:bg-[#161b22]/40" />,
          th: props => (
            <th
              {...props}
              className="border border-[#1e2433] px-3 py-2 text-left
                         text-xs font-semibold text-slate-400 uppercase tracking-wider"
            />
          ),
          td: props => (
            <td
              {...props}
              className="border border-[#1e2433] px-3 py-2 text-sm text-slate-300"
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
