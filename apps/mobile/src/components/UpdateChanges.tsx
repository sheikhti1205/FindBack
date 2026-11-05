import { Link } from "react-router";
import { destinationFor } from "../services/destinations";
import { featureAvailability } from "../services/updates/availability";
import type { FeatureAnnouncement, FeatureContext } from "../services/updates/types";

/** Informational changes stay readable; only accepted, usable destinations link. */
export function UpdateChanges({ features, context }: { features: readonly FeatureAnnouncement[]; context: FeatureContext }) {
  if (features.length === 0) return null;
  return <ul className="mt-2 space-y-2">
    {features.map(feature => {
      const availability = featureAvailability(feature, context);
      return <li key={feature.id} className="text-sm text-on-surface-variant">
        <p>{feature.summary}</p>
        {availability.kind === "available"
          ? <Link className="inline-flex min-h-11 items-center underline underline-offset-4" to={availability.route}>
            {destinationFor(feature.destinationId)?.title}
          </Link>
          : <p className="mt-1 text-xs">Not available in this build.</p>}
      </li>;
    })}
  </ul>;
}
