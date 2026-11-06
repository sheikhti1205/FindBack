import { createHashRouter, Navigate, Route, RouterProvider, Routes, useLocation } from "react-router";
import { MotionConfig } from "framer-motion";
import { useEffect, type ReactNode } from "react";
import { AuthProvider } from "./auth";
import { ThemeProvider } from "./theme";
import { motionConfigValueFor, useAppearance } from "./appearance";
import { GuestOnly, NativeOnly, OnboardingRoute, RequireAdmin, RequireAuth } from "./components/Guards";
import { Shell } from "./components/Shell";
import { BackButtonHandler } from "./components/BackButtonHandler";
import { AccountDeletionFeedback } from "./components/AccountDeletionFeedback";
import { ReportDeletionFeedbackProvider } from "./components/ReportDeletionFeedback";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Splash } from "./screens/Splash";
import { AuthGateway } from "./screens/AuthGateway";
import { CompleteProfileRoute } from "./screens/CompleteProfile";
import { SignIn } from "./screens/SignIn";
import { Register } from "./screens/Register";
import { Verify } from "./screens/Verify";
import { ForgotPassword } from "./screens/ForgotPassword";
import { Recovery } from "./screens/Recovery";
import { Home } from "./screens/Home";
import { SearchScreen } from "./screens/SearchScreen";
import { CreateReport } from "./screens/CreateReport";
import { PostDetail } from "./screens/PostDetail";
import { Profile } from "./screens/Profile";
import { ProfileEdit } from "./screens/ProfileEdit";
import { PublicProfile } from "./screens/PublicProfile";
import { About } from "./screens/About";
import { Updates } from "./screens/Updates";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { NativeUpdateLifecycle } from "./services/updates/nativeRuntime";
import { MyPosts } from "./screens/MyPosts";
import { EditReport } from "./screens/EditReport";
import { SavedReports } from "./screens/SavedReports";
import { Help } from "./screens/Help";
import { AiConnection } from "./screens/AiConnection";
import { CloudModels } from "./screens/CloudModels";
import { LocalIntelligence } from "./screens/LocalIntelligence";
import { DownloadedModels } from "./screens/DownloadedModels";
import { Notifications } from "./screens/Notifications";
import { Settings } from "./screens/Settings";
import { AccountSettings } from "./screens/AccountSettings";
import { Devices } from "./screens/Devices";
import { BackupSettings } from "./screens/BackupSettings";
import { AppearanceSettings } from "./screens/AppearanceSettings";
import { AccessibilitySettings } from "./screens/AccessibilitySettings";
import { FeedLayoutSettings } from "./screens/FeedLayoutSettings";
import { MediaSettings } from "./screens/MediaSettings";
import { NotificationPreferences } from "./screens/NotificationPreferences";
import { PrivacySettings } from "./screens/PrivacySettings";
import { AiSettings } from "./screens/AiSettings";
import { AiPrivacy } from "./screens/AiPrivacy";
import { HelpGuide } from "./screens/HelpGuide";
import { AdminTeam } from "./screens/AdminTeam";
import { AdminBootstrap } from "./screens/AdminBootstrap";
import { BlockedUsers } from "./screens/BlockedUsers";
import { SafetyReports } from "./screens/SafetyReports";
import { FeedbackForm } from "./screens/FeedbackForm";
import { MyAppeals } from "./screens/MyAppeals";
import { StaffAppeals, StaffAppeal } from "./screens/StaffAppeals";
import { StaffFeedback, StaffFeedbackDetail } from "./screens/StaffFeedback";
import { Returns } from "./screens/Returns";
import { ModerationQueue } from "./screens/ModerationQueue";
import { RequireCapability } from "./components/RequireCapability";
import { AdminInvite } from "./screens/AdminInvite";
import { AdminAuditLog } from "./screens/AdminAuditLog";
import { CommunityGuidelines, PrivacyPolicy, Terms } from "./screens/Legal";
import { Diagnostics } from "./screens/Diagnostics";
import { ReportLinkHandler } from "./components/ReportLinkHandler";
import { ChatPushLinkHandler } from "./components/ChatPushLinkHandler";
import { AuthLinkBootstrap } from "./components/AuthLinkBootstrap";
import { SharedReport } from "./screens/SharedReport";
// L-FIXTURE additive-only: deterministic visual preflight route (static,
// network-free). No guards changed; the route mounts no data-bound screens.
import { FixtureRoute } from "./fixture/FixtureRoute";
import { useAuth } from "./auth";
import { SavedReportsProvider } from "./hooks/useSavedReports";
import { Connections, LegacyChatsRedirect, MessagingThread } from "./screens/Messaging";
import { MessagingPrivacy } from "./screens/MessagingPrivacy";
import { MessagingLifecycle } from "./components/MessagingLifecycle";
import { postBackgroundLocation, PostNavigationProvider } from "./components/PostNavigation";
import { PostModal } from "./components/PostModal";
import { UserIdentityProvider } from "./components/UserIdentityTrigger";
import { PeerIdentityActions } from "./components/PeerIdentityActions";
import { SignedOutEntry } from "./screens/RememberedAccounts";
import { clearAuthReturnTo, getAuthReturnRoute, peekAuthReturnTo } from "./utils/authReturnTo";

function StartScreen() {
  const { user, booting, bootError, needsProfile } = useAuth();
  const location = useLocation();
  if (booting || (bootError && !user)) return <Splash />;
  if (user) return <Shell />;
  if (needsProfile) return <Navigate to="/complete-profile" replace />;
  // An explicit "show me Home" is a presentation choice, not auth authority: it
  // is settled ahead of a protected destination so a signed-out reader can read
  // the public page without losing where they were headed. Only a successful
  // sign-in consumes that destination.
  const showPublic = (location.state as { showPublic?: unknown } | null)?.showPublic === true;
  if (!showPublic && getAuthReturnRoute() !== "/") return <Navigate to="/auth" replace />;
  return <SignedOutEntry />;
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

// Created once by the entrypoint, outside StrictMode's render cycle. Keep the
// existing descendant route tree; a data router enables supported blockers
// for every navigation source (links, imperative navigation and history POP).
export function createAppRouter() {
  // Direct public links work on the existing hash-routed web/native app.
  // Deliberately do not reinterpret provider callbacks, share paths or queries.
  if (!window.location.hash && ["/privacy", "/terms", "/community-guidelines"].includes(window.location.pathname)) {
    window.history.replaceState(window.history.state, "", `/${window.location.search}#${window.location.pathname}`);
  }
  return createHashRouter([{ path: "*", element: <AppRouteTree /> }]);
}

export function App({ router }: { router: ReturnType<typeof createAppRouter> }) {
  return (
    <ThemeProvider>
      <AuthProvider>
        <MessagingLifecycle />
        {/* The ONE owner of saved-report state. It lives inside the auth
            provider because a save belongs to an ACCOUNT, and it wraps the
            router so the feed, the detail screen and the saved-reports screen
            all read the same truth. */}
        <SavedReportsProvider>
        <AppMotionConfig>
        <RouterProvider router={router} />
        </AppMotionConfig>
        </SavedReportsProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

function AppRouteTree() {
  const location = useLocation();
  const { user, booting, needsProfile } = useAuth();
  useEffect(() => {
    if (user && peekAuthReturnTo() === `${location.pathname}${location.search}${location.hash}`) clearAuthReturnTo();
  }, [user, location.pathname, location.search, location.hash]);
  const background = postBackgroundLocation(location, user?.id ?? null);
  return (
    <>
          <AuthLinkBootstrap />
          <ReportLinkHandler />
          <ChatPushLinkHandler />
          <BackButtonHandler />
          <NativeUpdateLifecycle />
          {user && !booting && !needsProfile ? <UpdatePrompt /> : null}
          <ErrorBoundary>
            <AccountDeletionFeedback />
            <ReportDeletionFeedbackProvider>
             <UserIdentityProvider actions={PeerIdentityActions}><PostNavigationProvider value={user?.id ?? null}>
            <Routes location={background ?? location}>
              <Route path="/shared/:id" element={<SharedReport />} />
              <Route path="/privacy" element={<main className="nf-public-document"><PrivacyPolicy publicView /></main>} />
              <Route path="/terms" element={<main className="nf-public-document"><Terms publicView /></main>} />
              <Route path="/community-guidelines" element={<main className="nf-public-document"><CommunityGuidelines publicView /></main>} />
             <Route path="/" element={<StartScreen />}>
               <Route index element={<Home />} />
             </Route>
            <Route path="/splash" element={<Splash />} />
            <Route path="/onboarding" element={<OnboardingRoute />} />
            <Route
              path="/auth"
              element={
                <GuestOnly>
                  <AuthGateway />
                </GuestOnly>
              }
            />
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
            {/* L-FIXTURE additive-only: static visual preflight (no auth).
                FB-AUD-07: dev/audit-only — import.meta.env.DEV is
                statically false in production builds, so the route is
                compiled out of prod while dev + test keep working. */}
            {import.meta.env.DEV ? (
              <Route path="/__fixture" element={<FixtureRoute />} />
            ) : null}
            {/* W0-C (S3) additive-only: social profile completion. Unchanged
                guards everywhere else; the wrapper redirects to /auth when no
                seed is present. */}
            <Route path="/complete-profile" element={<CompleteProfileRoute />} />
            <Route path="/forgot" element={<ForgotPassword />} />
            <Route path="/recovery" element={<Recovery />} />
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
              <Route path="/my/:id/edit" element={<EditReport />} />
              <Route path="/saved" element={<SavedReports />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/profile/edit" element={<ProfileEdit />} />
              <Route path="/u/:username" element={<PublicProfile />} />
              <Route path="/notifications" element={<Notifications />} />
              <Route path="/chats" element={<Connections />}>
                <Route path=":conversationId" element={<MessagingThread />} />
              </Route>
              <Route path="/connections" element={<LegacyChatsRedirect />} />
              <Route path="/connections/:conversationId" element={<LegacyChatsRedirect />} />
              <Route path="/about" element={<About />} />
              <Route path="/help" element={<Help />} />
              <Route path="/ai-connection" element={<AiConnection />} />
                <Route path="/ai-models" element={<NativeOnly><Navigate to="/settings/local-intelligence" replace /></NativeOnly>} />
               <Route path="/offline-ai" element={<NativeOnly><Navigate to="/settings/local-intelligence" replace /></NativeOnly>} />
              <Route path="/settings" element={<Settings />}>
              {/* Eligibility and the claim itself are server-controlled. An
                  existing admin role must not be required to reach setup. */}
              <Route path="/settings/administrator" element={<AdminBootstrap />} />
              <Route path="/settings/account" element={<AccountSettings />} />
              <Route path="/settings/devices" element={<Devices />} />
              <Route path="/settings/backup" element={<BackupSettings />} />
              <Route path="/settings/appearance" element={<AppearanceSettings />} />
              <Route path="/settings/accessibility" element={<AccessibilitySettings />} />
              <Route path="/settings/feed-layout" element={<FeedLayoutSettings />} />
              <Route path="/settings/media" element={<MediaSettings />} />
              <Route path="/settings/notifications" element={<NotificationPreferences />} />
              <Route path="/settings/privacy" element={<PrivacySettings />} />
              <Route path="/settings/privacy/messages" element={<MessagingPrivacy />} />
              <Route path="/settings/privacy/blocked" element={<BlockedUsers />} />
              <Route path="/settings/privacy/reports" element={<SafetyReports />} />
              <Route path="/settings/privacy/appeals" element={<MyAppeals />} />
              <Route path="/settings/feedback" element={<FeedbackForm />} />
              <Route path="/settings/returns" element={<Returns />} />
              <Route path="/settings/moderation/queue" element={<RequireCapability capability="reports_review"><ModerationQueue /></RequireCapability>} />
              <Route path="/settings/moderation/appeals" element={<StaffAppeals />} />
              <Route path="/settings/moderation/appeals/:appealId" element={<StaffAppeal />} />
              <Route path="/settings/moderation/feedback" element={<StaffFeedback />} />
              <Route path="/settings/moderation/feedback/:feedbackId" element={<StaffFeedbackDetail />} />
              <Route path="/settings/ai" element={<AiSettings />} />
              <Route path="/settings/ai/connections" element={<AiConnection />} />
              <Route path="/settings/ai/chat-models" element={<CloudModels />} />
              <Route path="/settings/ai/privacy" element={<AiPrivacy />} />
               <Route path="/settings/ai/models" element={<NativeOnly><Navigate to="/settings/local-intelligence" replace /></NativeOnly>} />
              <Route path="/settings/local-intelligence" element={<NativeOnly><LocalIntelligence /></NativeOnly>} />
              <Route path="/settings/local-intelligence/downloads" element={<NativeOnly><DownloadedModels /></NativeOnly>} />
              <Route path="/settings/help" element={<HelpGuide />} />
              {/* Staff console. The Settings row is role-gated and these routes
                  are guarded too, so a typed URL never reaches the console. */}
              <Route path="/settings/team" element={<RequireAdmin><AdminTeam /></RequireAdmin>} />
              <Route path="/settings/team/invite" element={<RequireAdmin><AdminInvite /></RequireAdmin>} />
              <Route path="/settings/team/audit" element={<RequireAdmin><AdminAuditLog /></RequireAdmin>} />
              <Route path="/settings/updates" element={<Updates />} />
              <Route path="/settings/about" element={<About />} />
              <Route path="/settings/terms" element={<Terms />} />
              <Route path="/settings/privacy-policy" element={<PrivacyPolicy />} />
              <Route path="/settings/community-guidelines" element={<CommunityGuidelines />} />
              <Route path="/settings/diagnostics" element={<Diagnostics />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/splash" replace />} />
           </Routes>
            {background && <Routes location={location}>
              <Route path="/posts/:id" element={<RequireAuth><PostModal /></RequireAuth>} />
            </Routes>}
             </PostNavigationProvider></UserIdentityProvider>
            </ReportDeletionFeedbackProvider>
          </ErrorBoundary>
    </>
  );
}
