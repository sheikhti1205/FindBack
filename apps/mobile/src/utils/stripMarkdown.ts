/**
 * Convert stored Markdown to plain text for semantic embedding input.
 * Embeddings must see readable words, not syntax clutter.
 */
export function stripMarkdown(md: string): string {
  return (
    md
      // fenced code blocks -> inner content
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```$/g, ""))
      // inline code -> content
      .replace(/`([^`]+)`/g, "$1")
      // images -> alt text only (remote images never load)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // links -> link text only
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // headings -> text
      .replace(/^#{1,6}\s+/gm, "")
      // blockquotes
      .replace(/^>\s?/gm, "")
      // list markers
      .replace(/^\s*([-*+]|\d+\.)\s+/gm, "")
      // task list boxes
      .replace(/\[[ xX]\]\s*/g, "")
      // table pipes -> spaces
      .replace(/\|/g, " ")
      // emphasis / strikethrough markers
      .replace(/(\*\*|__|\*|_|~~)([^*_~]+)\1/g, "$2")
      // horizontal rules
      .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, "")
      // collapse whitespace
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
