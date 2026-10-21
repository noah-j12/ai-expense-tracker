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

## 7. Create a key for the "choose an existing sheet" picker
1. **APIs & Services → Credentials → Create credentials → API key**. Copy it, then click **Edit API key**.
2. Application restrictions: **Websites** → add `https://noah-j12.github.io/*`.
3. API restrictions: **Restrict key** → tick **Google Picker API** and **Google Drive API** (the picker uses Drive to list files; without it, it says "The API developer key is invalid") → **Save**.

## 8. Find the project number
Cloud console home page → **Project info** card → **Project number**.

## 9. Send Claude the four values
Client ID, Client secret, API key, Project number. Claude puts them in `js/google-config.js` and publishes. None of them give access to anyone's data. Google designed this client type's "secret" to ship inside apps, and the API key only works from this app's website.
