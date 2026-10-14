import packet from "../../../../../docs/evidence/model-license-packet.json";

interface DocumentSnapshot { readonly bytes: number; readonly sha256: string; readonly sources: readonly string[]; readonly text: string }
interface ModelNotices {
  readonly upstreamRepo: string; readonly revision: string;
  readonly artifacts: readonly { fileName: string; bytes: number; sha256: string }[];
  readonly attribution: string;
  readonly license: { readonly sha256: string; readonly source: string };
  readonly card: { readonly sha256: string; readonly source: string };
  readonly notices: readonly { readonly sha256: string; readonly source: string }[];
  readonly noticeInventory: string;
}
const models = packet.models as Readonly<Record<string, ModelNotices>>;
const documents = packet.documents as Readonly<Record<string, DocumentSnapshot>>;

/** Shipped text snapshots, never a remote lookup or an imported-trust upgrade. */
export function modelLicenseFor(modelId: string) {
  const model = models[modelId];
  if (!model) return undefined;
  const license = documents[model.license.sha256]; const card = documents[model.card.sha256];
  if (!license || !card) return undefined;
  return { ...model, licenseText: license.text, cardText: card.text, noticeTexts: model.notices.map((notice) => documents[notice.sha256]?.text ?? "") };
}
