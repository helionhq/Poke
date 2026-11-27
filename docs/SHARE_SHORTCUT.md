# Share to Poke (iOS Shortcut)

Poke has no share extension (brief §3.1). "Share to Poke" is a Shortcut that posts what you share
to the server, then opens Poke on the new message. It takes about three minutes to build once.

## 1. Get a share token

In the app: **Settings → Share token**. Poke makes a token that can only post shares: it can't read
the thread, the vault or anything else. The sheet shows it once, with buttons to copy the address
and the token. It also shows up under **Devices** as "Share Shortcut", where you can remove it. To
replace a token, make a new one and remove the old one.

## 2. Build the Shortcut

Open **Shortcuts** and tap **+**.

1. **Shortcut details** (the ⓘ or the name at the top): turn on **Show in Share Sheet**. Under
   **Share Sheet Types**, keep **Text**, **URLs**, **Images**, **Files** and **PDFs**. Turn the
   rest off. If nothing was shared, set it to **Continue**.
2. Add **Ask for Input**. Type: **Text**. Prompt: `Add a note?`. You can leave it empty when you
   share.
3. Add **Get Contents of URL**.
   - URL: `https://poke.arham.im/v1/share` (the address from step 1).
   - Method: **POST**.
   - Headers: add `Authorization` with the value `Bearer `, a space, then the token.
   - Request Body: **Form**. Add two fields:
     - `file`, type **File**, value **Shortcut Input**.
     - `note`, type **Text**, value **Provided Input** (the answer from step 2).
4. Add **Get Dictionary Value**: Get **Value** for key `deepLink` in **Contents of URL**.
5. Add **Open URLs** with **Dictionary Value**. Poke opens on what you shared.
6. Name it **Send to Poke** and pick an icon.

Now **Send to Poke** shows up in the share sheet of every app.

## What the server accepts

`POST /v1/share` with `Authorization: Bearer <share token>`:

- **Form (multipart):** any number of file fields (photos, PDFs, files) and text fields. A field
  named `note` goes first in the message. Shortcuts sends shared text and links as a small text
  file; a `text/plain` or `text/uri-list` file of 8 KB or less becomes message text instead of an
  attachment.
- **JSON:** `{ "text"?: string, "url"?: string | string[], "urls"?: string[], "note"?: string }`.

It answers `{ "messageId": "msg_…", "deepLink": "poke://thread?message=msg_…" }`. The message lands
in the thread as yours (origin "share"), files go to the Library, and Poke answers as usual.

## If it doesn't work

- **401:** the token is wrong or was removed. Make a new one.
- **403:** you used the app's own token. Share tokens are separate on purpose.
- **"Nothing to share":** the Shortcut sent an empty form. Check that `file` is set to Shortcut
  Input.
- Behind Cloudflare Access, add the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers
  too (the same service token the app uses).

Not yet tried on a phone: the exact Shortcuts action names (they change between iOS versions)
and how Shortcuts packs a shared URL. The server accepts both a text field and a text file, so
either way works.
