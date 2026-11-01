/** The request may have committed on the server even though its response was lost. */
export class PublishOutcomeUncertainError extends Error {
  constructor() {
    super("Publication outcome is uncertain. Check My Reports before trying again; your draft is safe.");
    this.name = "PublishOutcomeUncertainError";
  }
}

/** Publication was stopped before dispatch; staged bytes may be cleaned safely. */
export class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled. Your photos are kept — try again.");
    this.name = "UploadCancelledError";
  }
}
