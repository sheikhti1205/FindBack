import { HashRouter, Navigate, Route, Routes } from "react-router";
import { AuthProvider } from "./auth";
import { ThemeProvider } from "./theme";
import { GuestOnly, RequireAuth } from "./components/Guards";
import { Shell } from "./components/Shell";
import { Splash } from "./screens/Splash";
import { SignIn } from "./screens/SignIn";
import { Register } from "./screens/Register";
import { Verify } from "./screens/Verify";
import { Home } from "./screens/Home";
import { SearchScreen } from "./screens/SearchScreen";
import { CreateReport } from "./screens/CreateReport";
import { PostDetail } from "./screens/PostDetail";
import { Profile } from "./screens/Profile";
import { MyPosts } from "./screens/MyPosts";
import { Help } from "./screens/Help";

export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <HashRouter>
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
            <Route
              path="/verify"
              element={
                <RequireAuth>
                  <Verify />
                </RequireAuth>
              }
            />
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
              <Route path="/help" element={<Help />} />
            </Route>
            <Route path="*" element={<Navigate to="/splash" replace />} />
          </Routes>
        </HashRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
