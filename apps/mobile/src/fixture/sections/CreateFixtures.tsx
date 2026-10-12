import { useState } from "react";
import type { Category } from "@findback/shared";
import { Button } from "../../components/Button";
import { CategoryField } from "../../components/CategoryField";
import { TextField } from "../../components/Fields";
import { MapEmbed } from "../../components/MapEmbed";
import { EmptyState, Spinner } from "../../components/PostCard";
import { Segmented, STATUS_OPTIONS, POST_TYPE_OPTIONS } from "../../components/Segmented";
import { FixtureFrame, FixtureSection } from "../FixtureSection";
import { LONG_LOCATION, LONG_TITLE } from "../posts";

function noop(): void {}

/** Static create-report form built ONLY from production field components. */
function CreateForm({
  title = "",
  category = "" as Category | "",
  notes = "",
}: {
  title?: string;
  category?: Category | "";
  notes?: string;
}) {
  const [type, setType] = useState<"LOST" | "FOUND">("LOST");
  const [status, setStatus] = useState<
    "OPEN" | "MATCHED" | "RECOVERED" | "CLOSED"
  >("OPEN");
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        value={type}
        onChange={setType}
        options={POST_TYPE_OPTIONS}
        ariaLabel="Report type"
      />
      <TextField
        label="Title"
        value={title}
        onChange={noop}
        placeholder="What was lost or found?"
      />
      <CategoryField value={category} onChange={noop} />
      <TextField
        label="Location"
        value=""
        onChange={noop}
        placeholder="Where did it happen?"
      />
      <MapEmbed lat={null} lng={null} label={null} />
      <TextField
        label="Notes"
        value={notes}
        onChange={noop}
        placeholder="Extra details that help identify it"
      />
      <Segmented
        value={status}
        onChange={setStatus}
        options={STATUS_OPTIONS}
        ariaLabel="Report status"
      />
      <Button onClick={noop}>Publish report</Button>
    </div>
  );
}

/**
 * Create-report preflight. Uses the ACTUAL field components the
 * `CreateReport` screen is built from (`Segmented`, `TextField`,
 * `CategoryField`, `MapEmbed`, `Button`) with deterministic values — the
 * data-bound screen itself needs auth + media intake and cannot render
 * statically (recorded in README product gaps if that ever changes).
 */
export function CreateFixtures() {
  return (
    <FixtureSection
      id="create"
      title="Create report"
      description="Production form fields (type, title, category, location, notes, status, submit) across states."
    >
      <FixtureFrame section="create" variant="normal">
        <CreateForm />
      </FixtureFrame>
      <FixtureFrame section="create" variant="loading">
        <Spinner label="Preparing…" />
      </FixtureFrame>
      <FixtureFrame section="create" variant="empty">
        <EmptyState
          title="Start a report"
          subtitle="Add photos, then describe the item."
        />
      </FixtureFrame>
      <FixtureFrame section="create" variant="error">
        <CreateForm />
      </FixtureFrame>
      <FixtureFrame section="create" variant="long-content">
        <CreateForm
          title={LONG_TITLE}
          category="Phones & Tablets"
          notes={LONG_LOCATION}
        />
      </FixtureFrame>
      <FixtureFrame section="create" variant="large-text">
        <CreateForm title="Keys with a red fob" category="Keys" />
      </FixtureFrame>
      <FixtureFrame section="create" variant="dark">
        <CreateForm title="Keys with a red fob" category="Keys" />
      </FixtureFrame>
      <FixtureFrame section="create" variant="amoled">
        <CreateForm />
      </FixtureFrame>
      <FixtureFrame section="create" variant="small-width">
        <CreateForm title={LONG_TITLE} notes={LONG_LOCATION} />
      </FixtureFrame>
    </FixtureSection>
  );
}
