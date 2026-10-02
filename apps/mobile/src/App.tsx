import { HashRouter, Navigate, Route, Routes } from "react-router";
import { MotionConfig } from "framer-motion";
import type { ReactNode } from "react";
import { AuthProvider } from "./auth";
import { ThemeProvider } from "./theme";
import { motionConfigValueFor, useAppearance } from "./appearance";
import { GuestOnly, RequireAuth } from "./components/Guards";
import { Shell } from "./components/Shell";
import { BackButtonHandler } from "./components/BackButtonHandler";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Splash } from "./screens/Splash";
import { SignIn } from "./screens/SignIn";
import { Register } from "./screens/Register";
import { Verify } from "./screens/Verify";
import { Home } from "./screens/Home";
import { SearchScreen } from "./screens/SearchScreen";
import { CreateReport } from "./screens/CreateReport";
import { PostDetail } from "./screens/PostDetail";
import { Profile } from "./screens/Profile";
import { ProfileEdit } from "./screens/ProfileEdit";
import { About } from "./screens/About";
import { MyPosts } from "./screens/MyPosts";
import { Help } from "./screens/Help";
import { AiConnection } from "./screens/AiConnection";
import { AiModels } from "./screens/AiModels";
import { Notifications } from "./screens/Notifications";
import { Capacitor } from "@capacitor/core";
import { ReportLinkHandler } from "./components/ReportLinkHandler";
import { PublicLanding } from "./screens/PublicLanding";
import { SharedReport } from "./screens/SharedReport";
import { useAuth } from "./auth";

function StartScreen() {
  const { user } = useAuth();
  if (!Capacitor.isNativePlatform() && !user) return <PublicLanding />;
  return <RequireAuth><Shell /></RequireAuth>;
}

/**
 * H1-motion: MotionConfig follows the ONE effective motion preference —
 * reduce→always, full→never, system→user (defers to the OS). Reactive via
 * useAppearance, so Quick Appearance changes apply without reload. Gesture
 * tracking stays enabled; only travel/animation degrades.
 */
function AppMotionConfig({ children }: { children: ReactNode }) {
  const { settings } = useAppearance();
  return (
    <MotionConfig reducedMotion={motionConfigValueFor(settings.reduceMotion)}>
      {children}
    </MotionConfig>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppMotionConfig>
        <HashRouter>
          <ReportLinkHandler />
          <BackButtonHandler />
          <ErrorBoundary>
           <Routes>
             <Route path="/shared/:id" element={<SharedReport />} />
             <Route path="/" element={<StartScreen />}>
               <Route index element={<Home />} />
             </Route>
            <Route path="/splash" element={<Splash />} />
            <Route
              path="/signin"
              element={
                <GuestOnly>
                  <SignIn />
                </GuestOnly>
              }
            />
            <Route
              path="/register"
              element={
                <GuestOnly>
                  <Register />
                </GuestOnly>
              }
            />
            <Route path="/verify" element={<Verify />} />
            <Route
              element={
                <RequireAuth>
                  <Shell />
                </RequireAuth>
              }
            >
              <Route path="/search" element={<SearchScreen />} />
              <Route path="/report" element={<CreateReport />} />
              <Route path="/posts/:id" element={<PostDetail />} />
              <Route path="/my" element={<MyPosts />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/profile/edit" element={<ProfileEdit />} />
              <Route path="/notifications" element={<Notifications />} />
              <Route path="/about" element={<About />} />
              <Route path="/help" element={<Help />} />
              <Route path="/ai-connection" element={<AiConnection />} />
              <Route path="/ai-models" element={<AiModels />} />
              <Route path="/offline-ai" element={<Navigate to="/ai-connection" replace />} />
            </Route>
            <Route path="*" element={<Navigate to="/splash" replace />} />
          </Routes>
          </ErrorBoundary>
        </HashRouter>
        </AppMotionConfig>
      </AuthProvider>
    </ThemeProvider>
  );
}
