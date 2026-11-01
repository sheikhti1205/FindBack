import { useEffect, useRef, useState } from "react";
import { PanelBottom, PanelLeft } from "lucide-react";
import { useAppearance, type NavLayout } from "../appearance";
import { MEDIUM_MAX_PX, useViewportWidth } from "./responsive";
import { Button } from "./Button";
import "./NavigationSetup.css";

/** First authenticated wide use, not a modal and never an account preference. */
export function NavigationSetup() {
  const { settings, update } = useAppearance();
  const width = useViewportWidth();
  const choseHere = useRef(false);
  const [finePointer, setFinePointer] = useState(() =>
    typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(pointer: fine)");
    const sync = () => setFinePointer(query.matches);
    sync(); query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);
  useEffect(() => {
    if (!settings.navLayoutChosen || !choseHere.current) return;
    choseHere.current = false;
    // The chosen button disappeared. Continue in the new canonical navigation,
    // rather than dropping keyboard/switch users back onto the document body.
    const nav = document.querySelector('nav[aria-label="Primary"]');
    (nav?.querySelector<HTMLAnchorElement>('[aria-current="page"]') ?? nav?.querySelector<HTMLAnchorElement>("a"))?.focus();
  }, [settings.navLayoutChosen]);
  const choose = (navLayout: NavLayout) => {
    choseHere.current = true;
    update({ navLayout, navLayoutChosen: true });
  };
  if (width < MEDIUM_MAX_PX || settings.navLayoutChosen) return null;
  return <section className="fb-navigation-setup" aria-label="Choose your navigation">
    <h2>Make room for what matters.</h2>
    <p>Choose navigation for this device. You can change it in Appearance.</p>
    <div className="fb-navigation-choices">
      <Button variant="outline" onClick={() => choose("rail")}><PanelLeft size={18} aria-hidden="true" />Side rail</Button>
      <Button variant="outline" onClick={() => choose("bottom")}><PanelBottom size={18} aria-hidden="true" />Bottom navigation</Button>
      <Button onClick={() => choose(finePointer ? "rail" : "bottom")}>Use recommended</Button>
    </div>
    <p className="fb-navigation-recommendation">{finePointer ? "Side rail gives wide screens more room for browsing." : "Bottom navigation keeps controls within easy touch reach."}</p>
  </section>;
}
