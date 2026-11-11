# Chrome Web Store — permission justifications

The review asks for a reason for each permission. These are the answers.

## `cookies`

To read the sign-in cookies of the specific sites the person picks in the Mafold
desktop app, and hand them to that app on the same machine. This is the
extension's single purpose. Cookies for any other site are never read — see the
host-permission answer below.

## `nativeMessaging`

To talk to the Mafold desktop app on the same computer, over a local
native-messaging host (`com.mafold.import`) that the app installs. This is how
the app tells the extension which sites the person picked, and how the picked
sites' cookies are returned to the app. It replaces any network call: the data
goes app ↔ extension locally and never leaves the machine.

## `storage`

To hold, in `chrome.storage.session` (memory only, cleared when Chrome closes),
the current list of sites the app has asked about, so the popup and the service
worker agree on what the person is approving. No sign-in data is stored.

## Host permissions — `optional_host_permissions: *://*/*`, requested per site

Host access is **not** granted at install. When the person approves an import in
the extension popup, the extension requests host permission for **only the sites
they picked** (the exact host and its parent domain, https only). Chrome shows
its own prompt for those hosts. The broad `*://*/*` pattern is declared only so
that any site the person chooses can be requested at that moment; the extension
never holds access to all sites, and never reads a site that wasn't picked and
approved.

## Remote code

None. All code is in the package. No `eval`, no remotely hosted scripts, no
network fetches.

## Data use (Privacy practices tab)

- **Authentication information (cookies):** collected, to hand to the person's
  own Mafold desktop app on the same machine. **Not** sold or transferred to a
  third party. **Not** used for anything beyond the single purpose. **Not** sent
  to any server — it moves locally, over native messaging, to an app the person
  installed.
- No web history, no page content, no personal communications, no location, no
  analytics.
