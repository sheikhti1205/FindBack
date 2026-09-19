import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

/**
 * Shared safe Markdown renderer for untrusted user/AI content.
 * Raw HTML is never parsed (no rehype-raw), output is sanitized,
 * remote images are disabled, and only http/https/mailto links survive.
 */
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => t !== "img" && t !== "iframe"),
  attributes: {
    ...defaultSchema.attributes,
    a: [
      ...((defaultSchema.attributes?.a as unknown[] | undefined) ?? []),
      ["target", "_blank"],
      ["rel", "noopener", "noreferrer"],
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
  },
};

function isSafeHref(href?: string): boolean {
  if (!href) return false;
  return /^(https?:|mailto:)/i.test(href.trim());
}

/** Headings shift down so card content never competes with the page h1. */
const headingMap = { h1: "h3", h2: "h4", h3: "h4" } as const;

export const MarkdownView = memo(function MarkdownView({ text }: { text: string }) {
  return (
    <div className="fb-markdown break-words text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
        disallowedElements={["img", "iframe"]}
        unwrapDisallowed
        components={{
          h1: "h3",
          h2: "h4",
          h3: "h4",
          a: ({ href, children }) =>
            isSafeHref(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className="break-all underline">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: () => null,
          iframe: () => null,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table>{children}</table>
            </div>
          ),
          pre: ({ children }) => <pre className="overflow-x-auto">{children}</pre>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export { headingMap };
