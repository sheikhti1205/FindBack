/** The request may have committed on the server even though its response was lost. */
export class PublishOutcomeUncertainError extends Error {
  constructor() {
    super("Publication outcome is uncertain. Check My Reports before trying again; your draft is safe.");
    this.name = "PublishOutcomeUncertainError";
  }
}
