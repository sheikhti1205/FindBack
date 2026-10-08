/** Small bounded namespace-aware XML reader; no DOM dependency, DTD or external entity support. */
export const CAMERA_NS = "http://ns.google.com/photos/1.0/camera/";
export const CONTAINER_NS = "http://ns.google.com/photos/1.0/container/";
export const ITEM_NS = "http://ns.google.com/photos/1.0/container/item/";
const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
interface Node { name: string; key: string; attrs: Map<string, string>; children: Node[]; text: string; ns: Map<string, string> }
const key = (uri: string, name: string) => `${uri}|${name}`;
const invalid = () => new Error("Invalid motion metadata");
function unescapeXml(value: string): string {
  return value.replace(/&([^;]+);/g, (_, entity: string) => {
    const values: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entity in values) return values[entity]!;
    if (/^#(?:\d+|x[\da-fA-F]+)$/.test(entity)) {
      const code = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
    }
    throw invalid();
  });
}
function parse(header: string): Node[] {
  if (header.includes("<!DOCTYPE") || header.includes("<!ENTITY")) throw invalid();
  const roots: Node[] = [];
  const stack: Node[] = [];
  const tokens = /<(?:!--[\s\S]*?--|\?[\s\S]*?\?|!\[CDATA\[[\s\S]*?\]\]|\/?[A-Za-z_][\w:.-]*(?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
  let end = 0; let count = 0;
  for (const match of header.matchAll(tokens)) {
    const token = match[0];
    if (stack.length) stack.at(-1)!.text += header.slice(end, match.index);
    end = match.index! + token.length;
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("<![CDATA[")) { if (stack.length) stack.at(-1)!.text += token.slice(9, -3); continue; }
    if (token.startsWith("</")) {
      if (stack.pop()?.name !== token.slice(2, -1).trim()) throw invalid();
      continue;
    }
    const name = /^<([\w:.-]+)/.exec(token)?.[1];
    if (!name || ++count > 512 || stack.length > 32) throw invalid();
    const ns = new Map(stack.at(-1)?.ns);
    const raw = new Map<string, string>();
    let rest = token.slice(name.length + 1).replace(/\/?\s*>$/, "");
    const attrs = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    rest = rest.replace(attrs, (_, attr: string, double: string | undefined, single: string | undefined) => {
      if (raw.has(attr)) throw invalid();
      raw.set(attr, unescapeXml(double ?? single ?? "")); return "";
    });
    if (rest.trim()) throw invalid();
    for (const [attr, value] of raw) {
      if (attr === "xmlns") ns.set("", value);
      else if (attr.startsWith("xmlns:")) ns.set(attr.slice(6), value);
    }
    const expanded = (name: string, attribute = false) => {
      const parts = name.split(":");
      if (parts.length > 2) throw invalid();
      if (parts.length === 2) {
        const uri = ns.get(parts[0]!); if (!uri) throw invalid();
        return key(uri, parts[1]!);
      }
      return key(attribute ? "" : ns.get("") ?? "", name);
    };
    const node: Node = { name, key: expanded(name), ns, attrs: new Map(), children: [], text: "" };
    for (const [attr, value] of raw) {
      if (attr === "xmlns" || attr.startsWith("xmlns:")) continue;
      const attribute = expanded(attr, true);
      if (node.attrs.has(attribute)) throw invalid();
      node.attrs.set(attribute, value);
    }
    if (stack.length) stack.at(-1)!.children.push(node); else roots.push(node);
    if (!/\/\s*>$/.test(token)) stack.push(node);
  }
  if (stack.length) throw invalid();
  return roots;
}
function walk(nodes: readonly Node[]): Node[] { return nodes.flatMap((node) => [node, ...walk(node.children)]); }
function property(nodes: readonly Node[], uri: string, name: string): string | null {
  const wanted = key(uri, name); const values: string[] = [];
  for (const node of nodes) {
    if (node.attrs.has(wanted)) values.push(node.attrs.get(wanted)!);
    if (node.key === wanted) values.push(unescapeXml(node.text.trim()));
  }
  if (values.length > 1) throw invalid();
  return values[0] ?? null;
}
export interface MotionXmp {
  mode: "none" | "disabled" | "modern" | "legacy";
  offset: string | null;
  items: readonly { mime: string | null; semantic: string | null; length: string | null; padding: string | null }[];
}
export function readMotionXmp(header: string): MotionXmp {
  const nodes = walk(parse(header));
  const flag = property(nodes, CAMERA_NS, "MotionPhoto");
  const result: MotionXmp = { mode: "none", offset: null, items: [] };
  if (flag !== null && !/^\+?0*1$/.test(flag.trim())) return { ...result, mode: "disabled" };
  const legacy = flag === null && property(nodes, CAMERA_NS, "MicroVideo") === "1";
  const directories = nodes.filter((node) => node.key === key(CONTAINER_NS, "Directory"));
  if (flag === null && !legacy) return result;
  if (flag === null && directories.length === 0) return { ...result, mode: "legacy", offset: property(nodes, CAMERA_NS, "MicroVideoOffset") };
  if (directories.length !== 1) throw invalid();
  const sequences = directories[0]!.children.filter((node) => node.key === key(RDF_NS, "Seq"));
  if (sequences.length !== 1) throw invalid();
  const entries = sequences[0]!.children;
  if (entries.length < 2 || entries.length > 16 || entries.some((node) => node.key !== key(RDF_NS, "li"))) throw invalid();
  const items = entries.map((entry) => {
    const resources = entry.children.filter((node) => node.key === key(CONTAINER_NS, "Item"));
    if (resources.length !== 1) throw invalid();
    const fields = walk(resources);
    return { mime: property(fields, ITEM_NS, "Mime"), semantic: property(fields, ITEM_NS, "Semantic"), length: property(fields, ITEM_NS, "Length"), padding: property(fields, ITEM_NS, "Padding") };
  });
  return { ...result, mode: "modern", items };
}
