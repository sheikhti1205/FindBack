/**
 * One sentence for one fact: a suggested category the catalogue does not release
 * is dropped, whichever op dropped it.
 *
 * The form can show this for either source (field extraction or classification),
 * and the person reading it does not care which op it came from — so there is
 * exactly one string here. Two byte-identical constants in two modules were only
 * a place for the wording to drift apart.
 */
export const DROPPED_CATEGORY_NOTE =
  "The suggested category isn't available yet, so it was left out. Pick a category manually.";
