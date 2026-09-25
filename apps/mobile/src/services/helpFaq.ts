/** Deterministic, offline FindBack help; no provider or user credential required. */
export function builtInHelp(question: string): string {
  const q = question.toLowerCase();
  if (/report|lost|found/.test(q)) {
    return "To report an item, open the Report tab, choose Lost or Found, add a title, description, category, date and approximate location, then review and tap Publish. A photo is optional.";
  }
  if (/search|filter|find/.test(q)) {
    return "Open Search to search reports and filter by category, status, Lost or Found. Results come from FindBack listings, not from AI.";
  }
  if (/recover|status|closed|match/.test(q)) {
    return "Open your report and use its status control to mark the item Matched, Recovered or Closed when appropriate.";
  }
  if (/photo|image|upload/.test(q)) {
    return "You can attach a photo while preparing a report. It is uploaded when you publish. AI photo analysis is optional and sends the selected image to OpenRouter only with your consent.";
  }
  if (/verif|email|phone|otp|code/.test(q)) {
    return "Confirm your email with the one-time code sent at signup. Phone verification is not available in this build.";
  }
  if (/comment|rating|like/.test(q)) {
    return "Open a post to comment, react or rate it. Comments and counts update while the post is open.";
  }
  if (/location|map|gps/.test(q)) {
    return "Choose an approximate location from the map when reporting an item. FindBack does not track you in the background.";
  }
  return "I can help with FindBack reports, search, status changes, comments, photos and account verification. Try asking about one of those features.";
}
