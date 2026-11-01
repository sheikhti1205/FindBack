import { useId } from "react";
import { motion } from "framer-motion";
import { Check, Link2, MessageCircle } from "lucide-react";
import { useShouldReduceMotion } from "../uiMotion";
import "./RecoveryDemo.css";

/** Decorative example only: no user data, probabilities or outcome promises. */
function Backpack() {
  return <svg viewBox="0 0 160 140" fill="none" aria-hidden="true">
    <ellipse cx="80" cy="126" rx="48" ry="5" fill="currentColor" opacity=".08" />
    <path d="M66 29V21c0-13 28-13 28 0v8" stroke="currentColor" strokeWidth="6" />
    <path d="M44 53C21 51 20 109 39 118M116 53c23-2 24 56 5 65" stroke="currentColor" strokeWidth="9" opacity=".45" />
    <path d="M39 47c0-17 14-25 41-25s41 8 41 25v65c0 11-10 16-41 16s-41-5-41-16V47Z" fill="currentColor" opacity=".85" />
    <path d="M49 52c2-12 60-12 62 0" stroke="var(--fb-surface-container-low)" strokeWidth="2" opacity=".7" />
    <rect x="50" y="73" width="60" height="39" rx="10" fill="var(--fb-surface-container-low)" opacity=".7" />
    <path d="M57 84h46m-3 0v8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    <rect x="70" y="55" width="20" height="7" rx="2" fill="var(--fb-surface-container-low)" />
  </svg>;
}

/** One 4.4-second spatial story; the endpoint is the reduced-motion equivalent. */
export function RecoveryDemo() {
  const reduced = useShouldReduceMotion();
  const caption = useId();
  const reveal = (at: number) => reduced ? {
    initial: false as const, animate: { opacity: 1, y: 0 }, transition: { duration: 0 },
  } : {
    initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 },
    transition: { delay: at, duration: .28, ease: "easeOut" as const },
  };
  return <figure className="fb-recovery-demo" aria-label="Example recovery journey" aria-describedby={caption} data-motion={reduced ? "static" : "full"}>
    <div data-demo-visual aria-hidden="true">
      <div className="fb-recovery-reports">
        {(["lost", "found"] as const).map((kind, i) => <motion.div className="fb-recovery-report" key={kind}
          initial={false}
          animate={reduced ? { x: 0, opacity: 1 } : {
            x: [i ? 22 : -22, i ? 22 : -22, 0, 0], opacity: [0, 1, 1, 1],
          }}
          transition={reduced ? { duration: 0 } : { duration: 2.5, times: [0, i ? .4 : .16, .85, 1], ease: "easeInOut" }}>
          <span className={`fb-recovery-chip fb-recovery-chip--${kind}`}>{kind === "lost" ? "Lost" : "Found"}</span>
          <Backpack />
          <strong>{kind === "lost" ? "My backpack" : "A backpack found"}</strong>
          <span className="fb-recovery-area">Near the park</span>
        </motion.div>)}
      </div>
      <div className="fb-recovery-outcomes">
        <motion.div className="fb-recovery-outcome" {...reveal(2.4)}><Link2 size={19} /><span><strong>Possible match</strong><small>Compare the details</small></span></motion.div>
        <motion.div className="fb-recovery-outcome" {...reveal(3.2)}><MessageCircle size={19} /><span><strong>Arrange a handover</strong><small>Contact each other safely</small></span></motion.div>
        <motion.div className="fb-recovery-outcome fb-recovery-outcome--recovered" {...reveal(4.05)}><Check size={19} /><strong>Recovered</strong></motion.div>
      </div>
    </div>
    <figcaption id={caption}>Illustration, not a live report.</figcaption>
    <ol className="sr-only" aria-label="Report to recovery">
      <li>Report a lost or found item with a photo and details.</li>
      <li>Discover nearby reports and search for the item.</li>
      <li>Match: compare possible matches, not guaranteed results.</li>
      <li>Contact each other and agree a safe handover.</li>
      <li>Recover the item and mark the report recovered.</li>
    </ol>
  </figure>;
}
