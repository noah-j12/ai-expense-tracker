# One-time Google setup for "Connect with Google"

This registers the app with Google so people can connect Google Sheets from their phone with a normal Google sign-in and no "unverified app" warning. It's free, needs no billing account, and is done once, by the developer, not by each user. About 10 minutes on a computer.

The app only asks for Google's `drive.file` permission ("files this app creates or you pick"), which Google classifies as **non-sensitive**, so it doesn't need Google's app review.

## 1. Create a project
1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in with your Google account.
2. Top bar → project picker → **New project**. Name it `AI Expense Tracker` → **Create**, then make sure it's selected in the top bar.

## 2. Turn on three APIs
**APIs & Services → Library**, search for each and click **Enable**:
- Google Sheets API
- Google Drive API
- Google Picker API

## 3. Set up the sign-in screen
1. Left menu → **Google Auth Platform** (or **APIs & Services → OAuth consent screen**) → **Get started**.
2. App name: `AI Expense Tracker`. User support email: yours. **Next**.
3. Audience: **External**. **Next**. Contact email: yours. Agree → **Create**.
4. **Don't upload a logo.** A logo makes Google require a brand review.

## 4. Add the one permission
1. **Data Access → Add or remove scopes**.
2. In the filter, type `drive.file`. Tick **`.../auth/drive.file`** → **Update** → **Save**.
3. It should be listed under **Your non-sensitive scopes**. If it shows up as sensitive or restricted, stop and tell Claude.

## 5. Publish it
**Audience → Publish app → Confirm.** The status should read **In production**. (Leaving it in "Testing" would make connections expire after 7 days.) If Google says verification is required, stop and tell Claude.

## 6. Create the sign-in client
1. **Clients → Create client**.
2. Application type: **TVs and Limited Input devices**. Name: `AI Expense Tracker`. **Create**.
3. Copy the **Client ID** and **Client secret**.

## 7. Create the client for "choose a sheet you already have"
Choosing an existing sheet happens on Google's own page (Google's embedded file picker can't work in iPhone Home Screen apps). That page needs a second, web-type client:
1. **Clients → Create client**.
2. Application type: **Web application**. Name: `AI Expense Tracker picker`.
3. **Authorized redirect URIs → Add URI**: `https://noah-j12.github.io/ai-expense-tracker/picked.html`
4. **Create**, then copy the **Client ID**. Its secret isn't needed.

## 8. Send Claude the values
The TV client's Client ID and Client secret, and the web client's Client ID. Claude puts them in `js/google-config.js` and publishes. None of them give access to anyone's data. Google designed the TV client's "secret" to ship inside apps, and the web client is only used to open Google's picking page. (The project number is the digits at the start of the Client ID. No API key is needed.)
