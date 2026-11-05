import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowRight } from "lucide-react";
import { BrandMark } from "../components/BrandMark";
import { PRODUCT_NAME, WEBSITE_TRANSITION_NOTE } from "../brand";
import { completeOnboarding } from "../services/onboarding";
import { Onboarding } from "./Onboarding";
import "./PublicWelcome.css";

const chapters = [
  ["Report what happened.", "Lost or found, start with what you know. Add your own photos, a date and an approximate area. Keep identifying details private so the right person can describe them."],
  ["Search what you remember.", "A colour, a place, a few words. Search reports and narrow them by category, date and area. You can review and change the filters yourself."],
  ["A possible match is just that.", "Similar reports can offer a useful starting point. They are suggestions, not proof of ownership or a promise of recovery. Check the details before taking the next step."],
  ["Talk when both people want to.", "Start with a message request. The other person chooses whether to connect. Share photos or a meeting place only when you are comfortable."],
  ["Back where it belongs.", "Ask for a detail only the owner would know. Agree on a safe handover, then mark the return when it really happens."],
  ["You stay in control.", "Choose what you share. Manage your reports, block unwanted contact and report abuse. Your exact location is not something you have to make public."],
] as const;

/** Public product explanation, not a fabricated feed or an authentication gate. */
export function PublicWelcome() {
  const navigate = useNavigate();
  const hero = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const final = useRef<HTMLElement>(null);
  const [showSticky, setShowSticky] = useState(false);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    let pastHero = false, atFinal = false;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.target === hero.current) pastHero = !entry.isIntersecting && entry.boundingClientRect.top < 0;
        if (entry.target === final.current) atFinal = entry.isIntersecting;
      }
      setShowSticky(pastHero && !atFinal);
    });
    if (hero.current) observer.observe(hero.current);
    if (final.current) observer.observe(final.current);
    return () => observer.disconnect();
  }, []);

  function start() {
    // Browsing the public explanation never cancels a pending sign-in
    // destination: only the successful sign-in consumes it.
    completeOnboarding();
    navigate("/auth");
  }
  function chapter(id: string) {
    if (menu.current) menu.current.open = false;
    const heading = document.getElementById(id);
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
  }

  return <div className="nf-public">
    <a className="nf-public-skip" href="#how-it-works" onClick={event => { event.preventDefault(); chapter("how-it-works"); }}>Skip to how it works</a>
    <header className="nf-public-nav">
      <Link className="nf-public-brand" to="/" state={{ showPublic: true }}><BrandMark size={28} alt="" /><span>{PRODUCT_NAME}</span></Link>
      <nav aria-label="Public navigation">
        <span className="nf-public-desktop-links">
          <button onClick={() => chapter("how-it-works")}>How it works</button>
          <button onClick={() => chapter("safety")}>Safety</button>
          <button onClick={() => chapter("about-norfold")}>About</button>
        </span>
        <Link to="/auth">Sign in</Link>
        <button className="nf-public-action nf-public-desktop-cta" onClick={start}>Get started</button>
        <details ref={menu} className="nf-public-menu"><summary>Explore</summary><div>
          <button onClick={() => chapter("how-it-works")}>How it works</button>
          <button onClick={() => chapter("safety")}>Safety</button>
          <button onClick={() => chapter("about-norfold")}>About</button>
        </div></details>
      </nav>
    </header>
    <main>
      <div ref={hero} className="nf-public-hero">
        <Onboarding publicHero onComplete={() => navigate("/auth")} />
        <button className="nf-public-action nf-public-hero-cta" onClick={start}>Get started <ArrowRight size={18} aria-hidden="true" /></button>
      </div>
      <div className="nf-public-story">
        {chapters.map(([title, copy], index) => <section key={title} className="nf-public-chapter">
          <span className="nf-public-number" aria-hidden="true">0{index + 1}</span>
          <h2 id={index === 0 ? "how-it-works" : undefined} tabIndex={index === 0 ? -1 : undefined}>{title}</h2><p>{copy}</p>
        </section>)}
        <section className="nf-public-notes">
          <h2 id="safety" tabIndex={-1}>A safer return starts with care.</h2>
          <p>Meet in a public place. Don’t send money to prove ownership, or share passwords, verification codes or sensitive documents. If something feels wrong, stop and report it.</p>
          <Link to="/community-guidelines">Read the community guidelines <ArrowRight size={16} aria-hidden="true" /></Link>
          <h2 id="about-norfold" tabIndex={-1}>A place to begin looking.</h2>
          <p>Norfold is a lost-and-found network for reporting, matching and recovering items. It is currently in beta. It cannot guarantee a match, a response or a return.</p>
        </section>
        <section ref={final} className="nf-public-final">
          <h2>Let’s find a way back.</h2><p>Start with a report. Take the next step when you’re ready.</p>
          <button className="nf-public-action" onClick={start}>Get started <ArrowRight size={18} aria-hidden="true" /></button>
        </section>
      </div>
    </main>
    <footer className="nf-public-footer">
      <span>{PRODUCT_NAME}</span>
      <nav aria-label="Legal and information">
        <Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link><Link to="/community-guidelines">Community Guidelines</Link>
        <button onClick={() => chapter("safety")}>Safety</button><button onClick={() => chapter("about-norfold")}>About</button>
      </nav>
      <p>{WEBSITE_TRANSITION_NOTE}</p>
    </footer>
    {showSticky && <div className="nf-public-sticky"><button className="nf-public-action" onClick={start}>Get started <ArrowRight size={18} aria-hidden="true" /></button></div>}
  </div>;
}
