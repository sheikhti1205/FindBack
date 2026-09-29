import { HashRouter, Navigate, Route, Routes } from "react-router";
import { MotionConfig } from "framer-motion";
import { AuthProvider } from "./auth";
import { ThemeProvider } from "./theme";
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
import { Notifications } from "./screens/Notifications";

export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        {/* Wave A: the OS reduced-motion setting degrades all Motion
            transform/layout travel to instant centrally (opacity kept).
            Imperative motion consults shouldReduceMotion() instead. */}
        <MotionConfig reducedMotion="user">
        <HashRouter>
          <BackButtonHandler />
          <ErrorBoundary>
          <Routes>
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
              <Route index element={<Home />} />
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
              <Route path="/offline-ai" element={<Navigate to="/ai-connection" replace />} />
            </Route>
            <Route path="*" element={<Navigate to="/splash" replace />} />
          </Routes>
          </ErrorBoundary>
        </HashRouter>
        </MotionConfig>
      </AuthProvider>
    </ThemeProvider>
  );
}
