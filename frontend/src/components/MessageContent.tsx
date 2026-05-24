'use client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'

// Allow a sensible subset of HTML tags + attributes inline. Extends the default
// rehype-sanitize schema rather than re-deriving it.
const schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames || []),
    'mark', 'kbd', 'sub', 'sup', 'details', 'summary',
  ],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] || []), 'className', 'style'],
    a: [...(defaultSchema.attributes?.a || []), ['target', 'href', 'rel']],
  },
}

export default function MessageContent({ content }: { content: string }) {
  return (
    <div className="markdown-body text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
        components={{
          a: props => (
            <a
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 underline hover:text-indigo-300"
            />
          ),
          code: ({ className, children, ...props }) => {
            const isBlock = (className || '').includes('language-')
            return isBlock ? (
              <code
                {...props}
                className={`${className || ''} block bg-[#0a0f1e] border border-[#1e2433] rounded-lg p-3 overflow-x-auto text-xs font-mono text-slate-200 my-2`}
              >
                {children}
              </code>
            ) : (
              <code
                {...props}
                className="bg-[#0a0f1e] border border-[#1e2433] rounded px-1 py-0.5 text-[0.85em] font-mono text-amber-300"
              >
                {children}
              </code>
            )
          },
          pre: ({ children }) => <pre className="my-2">{children}</pre>,
          ul: props => <ul {...props} className="list-disc pl-5 my-1.5 space-y-0.5" />,
          ol: props => <ol {...props} className="list-decimal pl-5 my-1.5 space-y-0.5" />,
          li: props => <li {...props} className="leading-snug" />,
          h1: props => <h1 {...props} className="text-base font-bold text-white mt-3 mb-1" />,
          h2: props => <h2 {...props} className="text-sm font-bold text-white mt-3 mb-1" />,
          h3: props => <h3 {...props} className="text-sm font-semibold text-white mt-2 mb-1" />,
          h4: props => <h4 {...props} className="text-sm font-semibold text-slate-200 mt-2 mb-1" />,
          p: props => <p {...props} className="my-1.5" />,
          blockquote: props => (
            <blockquote
              {...props}
              className="border-l-2 border-indigo-500/50 pl-3 my-2 text-slate-400 italic"
            />
          ),
          table: props => (
            <div className="overflow-x-auto my-2">
              <table {...props} className="w-full text-xs border-collapse" />
            </div>
          ),
          th: props => <th {...props} className="border border-[#1e2433] px-2 py-1 text-left font-semibold bg-[#0a0f1e]" />,
          td: props => <td {...props} className="border border-[#1e2433] px-2 py-1" />,
          hr: () => <hr className="my-3 border-[#1e2433]" />,
          strong: props => <strong {...props} className="text-white font-semibold" />,
          em: props => <em {...props} className="text-slate-200" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
