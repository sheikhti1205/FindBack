import { memo } from "react";
import { Link } from "react-router";
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { motionDurations, pressFeedback } from "./uiMotion";
import { ReportReferenceCard } from "./ReportReferenceCard";
import { tryParseReportLink } from "../utils/reportLinks";

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

/**
 * Mention handle shape. Deliberately the exact server regex class
 * (`@([A-Za-z0-9_]{1,30})` in the comment-notify trigger) so client links and
 * server notifications agree on what counts as a mention.
 */
const MENTION_SPLIT_RE = /@([A-Za-z0-9_]{1,30})/g;
/** Internal profile hrefs produced by the mention plugin. */
const INTERNAL_MENTION_HREF_RE = /^\/u\/[A-Za-z0-9_]{1,30}\/?$/;

/** Minimal mdast structural typing so the plugin needs no new type deps. */
interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
}

/** Containers whose text must never become mention links (code/links/images). */
const MENTION_SKIP_TYPES = new Set([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
  "html",
]);

function splitTextNode(node: MdastNode): MdastNode[] {
  if (node.type !== "text" || typeof node.value !== "string") return [node];
  MENTION_SPLIT_RE.lastIndex = 0;
  const out: MdastNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_SPLIT_RE.exec(node.value)) !== null) {
    const handle = match[1] ?? "";
    if (match.index > cursor) {
      out.push({ type: "text", value: node.value.slice(cursor, match.index) });
    }
    out.push({
      type: "link",
      url: `/u/${handle}`,
      children: [{ type: "text", value: `@${handle}` }],
    });
    cursor = match.index + match[0].length;
  }
  if (cursor === 0) return [node];
  if (cursor < node.value.length) {
    out.push({ type: "text", value: node.value.slice(cursor) });
  }
  return out;
}

function visitMentions(node: MdastNode): void {
  if (!node.children) return;
  if (MENTION_SKIP_TYPES.has(node.type)) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text") return splitTextNode(child);
    visitMentions(child);
    return [child];
  });
}

/** Remark plugin turning @handle text into internal /u/<handle> links. */
function remarkMentionLinks() {
  return (tree: MdastNode) => {
    visitMentions(tree);
  };
}

export const MarkdownView = memo(function MarkdownView({
  text,
  linkMentions = false,
  unfurlReports = false,
}: {
  text: string;
  /** Opt-in @mention → /u/<handle> links (default off; other consumers unaffected). */
  linkMentions?: boolean;
  /**
   * Opt-in: a canonical public report link renders as the inline report card
   * (comment bodies only). Anything the parser rejects falls through to the
   * ordinary link, so an unsafe URL never becomes a card.
   */
  unfurlReports?: boolean;
}) {
  return (
    <div className="fb-markdown break-words text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={
          linkMentions ? [remarkGfm, remarkBreaks, remarkMentionLinks] : [remarkGfm, remarkBreaks]
        }
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
          a: ({ href, children }) => {
            if (linkMentions && href && INTERNAL_MENTION_HREF_RE.test(href)) {
              // W5: @mention links use the functional blue/teal family
              // (`--fb-mention`), never the user accent.
              return (
                <Link to={href} className="break-words font-medium text-mention underline">
                  {children}
                </Link>
              );
            }
            // Unfurl only after the mention branch and before the generic link:
            // a parsed canonical link becomes the one card; every rejection
            // (wrong origin, http, userinfo, bad query, non-UUID, unset origin)
            // falls through to the plain link below.
            const report = unfurlReports && href ? tryParseReportLink(href) : null;
            if (report) return <ReportReferenceCard postId={report.postId} />;
            if (isSafeHref(href)) {
              return (
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
              );
            }
            return <span>{children}</span>;
          },
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
