// Markdown rendering (react-markdown with remark-gfm), ported from gongiskhan/jevellan at 8e2788ec
// (apps/web/src/markdown.tsx) without the evidence and file-pointer hooks of the old engine. Raw HTML is skipped,
// links keep react-markdown's safe URL transform (http(s), mailto, site paths and anchors; D-065) and open outside
// links in a new tab; images render only from this site (an outside image becomes a link, so a report cannot make
// the page fetch from elsewhere).

import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const sameSite = (src: string) => src.startsWith('/') && !src.startsWith('//');

export default function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={defaultUrlTransform}
        skipHtml
        components={{
          a: ({ href, children: label }) => (
            <a href={href} target={href?.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer">
              {label}
            </a>
          ),
          img: ({ src, alt }) =>
            typeof src === 'string' && sameSite(src) ? (
              <img src={src} alt={alt ?? ''} />
            ) : (
              <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noopener noreferrer">
                {alt || (typeof src === 'string' ? src : 'image')}
              </a>
            ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
