import { LayoutGroup } from "framer-motion";
import { useNavigate } from "react-router";
import { PostDetail } from "../screens/PostDetail";
import { AdaptiveTaskSurface } from "./AdaptiveTaskSurface";

/** Same business/content owner as the direct route; no second report implementation. */
export function PostModal() {
  const navigate = useNavigate();
  return <AdaptiveTaskSurface open title="Report" width="report" onClose={() => { void navigate(-1); }}>
    <LayoutGroup id="contextual-report"><PostDetail contextual /></LayoutGroup>
  </AdaptiveTaskSurface>;
}
