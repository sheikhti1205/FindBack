import { memo } from "react";
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { motionDurations, pressFeedback } from "./uiMotion";

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

/** Headings shift down one level so card content never competes with the page h1,
 * while preserving distinct visual levels for editor H1/H2/H3 (ED-03).
 * Deeper source headings (h4–h6) demote one step for the same reason. */
const headingMap = { h1: "h2", h2: "h3", h3: "h4" } as const;

export const MarkdownView = memo(function MarkdownView({ text }: { text: string }) {
  return (
    <div className="fb-markdown break-words text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
        disallowedElements={["img", "iframe"]}
        unwrapDisallowed
        components={{
          h1: ({ children }) => <h2 className="fb-h1">{children}</h2>,
          h2: ({ children }) => <h3 className="fb-h2">{children}</h3>,
          h3: ({ children }) => <h4 className="fb-h3">{children}</h4>,
          h4: ({ children }) => <h5 className="fb-h4">{children}</h5>,
          h5: ({ children }) => <h6 className="fb-h5">{children}</h6>,
          h6: ({ children }) => <h6 className="fb-h6">{children}</h6>,
          // External links acknowledge the tap and then hand off to the
          // native surface — Motion never animates the hand-off itself. The
          // scale token is a no-op on inline boxes, so opacity carries the
          // acknowledgement there.
          a: ({ href, children }) =>
            isSafeHref(href) ? (
              <motion.a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                whileTap={{ ...pressFeedback.button, opacity: 0.7 }}
                transition={{ duration: motionDurations.instant }}
                className="break-all underline"
              >
                {children}
              </motion.a>
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
