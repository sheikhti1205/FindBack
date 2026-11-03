import type { ReactNode } from "react";
import { SettingsGroup, SettingsPage } from "../components/settings";

/**
 * The three consumer documents: Terms of use, Privacy policy and Community
 * guidelines.
 *
 * ONE owner for the wording. The three documents describe the same app, so
 * they live in one file and cannot drift apart.
 *
 * Copy follows current report/recovery, R4 messaging and M3 retention contracts.
 * Peer history is durable device data; optional cloud AI Chat is session memory.
 * Safety retention is deliberate, not a promise to erase every record.
 * Owner/legal release review remains separate from engineering verification.
 */

function Paragraph({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-on-surface-variant">{children}</p>;
}

/** Terms of use. */
export function Terms() {
  return (
    <SettingsPage
      title="Terms of use"
      description="What Norfold is, and what each of us is responsible for."
      backTo="/settings"
    >
      <SettingsGroup title="What Norfold is">
        <Paragraph>
          Norfold is a place to report a lost or found item, to search what other people have
          reported, and to discuss those reports. It is a record of what people say they have lost
          or found — it is not a guarantee that any item is really lost, really found, or really
          yours.
        </Paragraph>
        <Paragraph>
          These terms apply to everyone who uses Norfold, and this page is the full text of the
          terms that apply to you.
        </Paragraph>
      </SettingsGroup>

      <SettingsGroup title="What you post">
        <Paragraph>
          You are responsible for what you post: the report, the description, the photos you add and
          the comments you write are yours. Only post items you actually lost or found, and only
          photos you took yourself or have the right to share.
        </Paragraph>
        <Paragraph>
          Other readers can see your report, its photos and the comments you write, so keep it
          about the item rather than about people.
        </Paragraph>
        <Paragraph>
          You can edit or delete your own report, subject to recovery and safety restrictions,
          change its status when allowed, and delete your own comments. Recovery-linked ratings
          are available to the people involved in a completed return, not to every report reader.
        </Paragraph>
      </SettingsGroup>

      <SettingsGroup title="Optional AI features">
        <Paragraph>
          AI Chat is optional and works through the cloud provider you choose in Settings. The
          messages you send, and the conversation context needed to answer them, go to that
          provider. Possible Matches uses report text, category, date and location; its similarity
          scores are not probabilities. This beta does not compare photos or generate report fields.
        </Paragraph>
        <Paragraph>
          AI answers can be wrong, incomplete or out of date. Check anything important against the
          report itself.
        </Paragraph>
      </SettingsGroup>

      <SettingsGroup title="Messages and safety">
        <Paragraph>
          Private messages between people are separate from AI Chat. A message request starts
          with text; image sharing is available after connection. You can block a person or
          report abuse. Messages are not end-to-end encrypted, and reporting content can preserve
          a limited safety copy for authorized staff review.
        </Paragraph>
      </SettingsGroup>

      <SettingsGroup title="Availability and changes">
        <Paragraph>
          The app is provided as it is. We do not promise that a report will be seen, that a match
          will be found, or that the service will always be available.
        </Paragraph>
        <Paragraph>
          These terms can change as the app changes. The version shown here is the one that
          applies while you use the app.
        </Paragraph>
      </SettingsGroup>
    </SettingsPage>
  );
}

/** Privacy policy. */
export function PrivacyPolicy() {
  return (
    <SettingsPage
      title="Privacy policy"
      description="What Norfold keeps, where it keeps it, and what you can remove."
      backTo="/settings"
    >
      <SettingsGroup title="What stays on your phone">
        <Paragraph>
          Your settings, appearance and any downloaded text-search resources stay on your device.
          AI Chat conversations are held in memory while the app is open, separately for each
          account, and are gone when you close it. Private messages between people are stored on
          your device so accepted history can be read offline. The list of reports you save is
          kept on this phone too, separately for each account. This beta has no consumer Drive
          backup option; keep that in mind before clearing app data or changing phones.
        </Paragraph>
      </SettingsGroup>

      <SettingsGroup title="What Norfold stores on its servers">
        <Paragraph>
          Your account is stored on Norfold's servers. The reports you publish with their photos,
          and the comments people leave, are stored there so that other readers can see them and so
          you can use them on another device. The notifications sent to you are stored there too,
          for your account only. The list of reports you save is stored with your account when you
          are online, so you can open it on another device; it stays with your account, and no other
          reader can see it.
        </Paragraph>
      </SettingsGroup>

      <SettingsGroup title="Private messages">
        <Paragraph>
          Norfold uses temporary server delivery to your registered devices and private storage
          for shared images. Delivery copies are removed as devices acknowledge them or they
          expire; this is not a permanent server archive of your conversations. Push notifications
          wake the app without carrying message text. Messages are not end-to-end encrypted.
          The other person may keep copies, screenshots or saved files that Norfold cannot erase.
        </Paragraph>
      </SettingsGroup>

      <SettingsGroup title="What leaves your phone when you use AI chat">
        <Paragraph>
          Only when you write to the assistant: the message you send and the conversation context
          needed to reply go to the provider you chose, which handles them under its own terms.
          Optional on-device text similarity runs locally. Searching published reports still queries
          Norfold's servers. This beta has no local generative assistant or photo matcher.
        </Paragraph>
      </SettingsGroup>

      <SettingsGroup title="Who can see your reports">
        <Paragraph>
          Reports are meant to be found by other people, so other Norfold users can see your
          report, its photos and the comments on it when they have access. A shared report link can
          show a limited public preview without an account; it does not reveal contact details or
          exact location. Full details and private actions require sign-in and report access.
          Deleting, hiding or revoking the report also removes its public preview. Do not put
          anything private in a report, a comment or a photo.
        </Paragraph>
      </SettingsGroup>

      <SettingsGroup title="Recovery ratings">
        <Paragraph>
          After a completed recovery, the people involved can rate the return. These ratings
          contribute to reputation; they are not open ratings on arbitrary reports. Older report
          ratings may remain visible as historical data.
        </Paragraph>
      </SettingsGroup>

      <SettingsGroup title="Deleting your data">
        <Paragraph>
          Unconfirmed accounts that have never signed in and hold no content or stored files
          may be removed after 30 days. You can create an account again if that happens.
        </Paragraph>
        <Paragraph>
          You can delete your account from Settings → Account. That removes your account, your
          reports and their photos, comments and reactions. You can also delete your own comments;
          the person who published a report can delete comments on it. Deletion cannot erase
          copies already kept by another person.
        </Paragraph>
        <Paragraph>
          Limited safety records are retained after account deletion: reported-content evidence
          for up to 90 days, and appeal, moderation and audit records to preserve case decisions.
          Live account links are removed where possible, but some decision identifiers and the
          text supplied in an appeal remain. Do not include unnecessary personal information in
          an appeal or abuse report. Private support feedback is deleted with your account.
        </Paragraph>
      </SettingsGroup>
    </SettingsPage>
  );
}

/** Community guidelines. */
export function CommunityGuidelines() {
  return (
    <SettingsPage
      title="Community guidelines"
      description="How to post so that Norfold stays useful for everyone."
      backTo="/settings"
    >
      <SettingsGroup title="Search before you post">
        <Paragraph>
          One clear report per item helps far more than three similar ones. Search first: the item
          may already be listed. If it is, add a comment with what you know — and a photo, if you
          took one — instead of posting a second report.
        </Paragraph>
      </SettingsGroup>

      <SettingsGroup title="Post about your own item">
        <Paragraph>
          Describe what you actually lost or found, and say where and when. If you found something,
          say so plainly — a report that reads like a lost item sends people the wrong way.
        </Paragraph>
        <Paragraph>
          Use photos you took yourself, and check them before you post. Blur anything that shows
          addresses, papers, faces or serial numbers you would rather not publish.
        </Paragraph>
      </SettingsGroup>

      <SettingsGroup title="Be decent to other readers">
        <Paragraph>
          Comment on the item, not on the person. No harassment, no insults, no arguments with
          strangers, and no repeated comments trying to get attention.
        </Paragraph>
        <Paragraph>
          Do not post illegal or harmful content, do not impersonate anyone, and do not use the app
          to identify or confront the owner of an item.
        </Paragraph>
      </SettingsGroup>

      <SettingsGroup title="Using the app">
        <Paragraph>
          Keep it useful: one report per item, honest details, and photos that show the item. If a
          report turns out to be wrong, change its status from your own report so other readers
          know it is settled.
        </Paragraph>
      </SettingsGroup>
    </SettingsPage>
  );
}
