import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { RecoveryDemo } from "../components/onboarding/RecoveryDemo";
import "./PublicLanding.css";

export function PublicLanding() {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  return (
    <main className="fb-public-landing">
      <div className="fb-landing-canvas">
        <header className="fb-landing-header">
          <span className="fb-landing-wordmark">FindBack<span aria-hidden="true">.</span></span>
          <Link className="fb-landing-signin" to="/signin">Sign in</Link>
        </header>
        <section className="fb-landing-hero">
          <div className="fb-landing-invitation">
            <p className="fb-landing-eyebrow">Lost something? Found something?</p>
            <h1 ref={title} tabIndex={-1}>Report it.<br />{" "}Match it.<br />{" "}<span>Return it.</span></h1>
            <p className="fb-landing-description">A little help bringing things home. Share a report, find a possible match, and reconnect with the person on the other side.</p>
            <Link to="/register" className="fb-landing-cta">Create an account</Link>
          </div>
          <RecoveryDemo />
        </section>
        <section aria-label="How FindBack works" className="fb-landing-details">
          {[
            {title:"Start with a photo.", text:"Describe what was lost or found, when it happened, and the approximate area. Review before you publish."},
            {title:"Discover a familiar detail.", text:"Browse nearby reports or search for an item. Compare possible matches to see what lines up."},
            {title:"Bring it back, together.", text:"Contact each other, confirm the details and agree a safe handover. Then mark the report recovered."},
          ].map(({title:heading, text}, i) => <article key={heading}><span aria-hidden="true" className="fb-landing-step">0{i+1}</span><h2>{heading}</h2><p>{text}</p></article>)}
        </section>
        <section className="fb-landing-close" aria-label="Get started"><h2>One report could be the way back.</h2><Link to="/register" className="fb-landing-cta">Create an account</Link></section>
        <footer className="fb-landing-footer">You choose what to share. No background location tracking. Possible matches are suggestions, not guarantees.</footer>
      </div>
    </main>
  );
}
