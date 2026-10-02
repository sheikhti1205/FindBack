import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { MapPin, Search, HeartHandshake } from "lucide-react";

export function PublicLanding() {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  return (
    <main className="min-h-screen bg-surface px-5 py-8 text-on-surface sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-outline-variant pb-5">
          <span className="text-xl font-semibold tracking-tight">FindBack</span>
          <Link className="inline-flex min-h-12 items-center rounded-m3-md border border-outline px-5 font-medium focus-visible:outline-2 focus-visible:outline-offset-4" to="/signin">Sign in</Link>
        </header>
        <section className="max-w-3xl py-16 sm:py-24">
          <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-on-surface-variant">Lost. Found. Reconnected.</p>
          <h1 ref={title} tabIndex={-1} className="text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">A little help finding<br className="hidden sm:block" /> what matters.</h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-on-surface-variant">Lost something? Found something that belongs to someone else? Share a report and help your community bring it home.</p>
          <Link to="/register" className="mt-8 inline-flex min-h-12 items-center rounded-m3-md bg-on-surface px-6 font-medium text-surface focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-on-surface">Create an account</Link>
        </section>
        <section aria-label="How FindBack works" className="grid gap-5 border-t border-outline-variant pt-8 sm:grid-cols-3">
          {[
            {Icon:Search, title:"Report lost or found", text:"Describe the item, add photos, and say when and where it happened."},
            {Icon:MapPin, title:"Look around", text:"Browse reports by category and location. See possible matches while viewing a report."},
            {Icon:HeartHandshake, title:"Help reconnect", text:"Comment on a report and share its link with someone who can help."},
          ].map(({Icon, title:heading, text}) => <article key={heading} className="rounded-m3-lg border border-outline-variant bg-surface-container-low p-6"><Icon aria-hidden="true" className="mb-5 h-7 w-7" /><h2 className="text-lg font-semibold">{heading}</h2><p className="mt-2 leading-relaxed text-on-surface-variant">{text}</p></article>)}
        </section>
        <footer className="mt-12 border-t border-outline-variant pt-5 text-sm leading-relaxed text-on-surface-variant">Report content requires a FindBack account. Photos upload only when you publish; AI features are optional. FindBack does not track your location in the background.</footer>
      </div>
    </main>
  );
}
