// Google Cloud registration for "Connect with Google" (Google Sheets without a script).
// Fill these in from the Google Cloud console (see GOOGLE-SETUP.md). Until they're filled in,
// the app only offers the script method.
//
// The client secret for this client type ("TVs and Limited Input devices") isn't actually secret:
// Google issues it for apps that run on people's own devices and expects it to ship inside the app.

export const GOOGLE = {
  clientId: '964305676640-t40935na6ombct5a74u4f2tn10rmdpv7.apps.googleusercontent.com',
  clientSecret: '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',
  // "Choose a sheet you already have": a Web application client in the same project, used only to open
  // Google's own file-picking page. Its redirect URI is picked.html. No secret is needed (no code exchange).
  pickerClientId: '964305676640-en8kqh4uo73jdrt2or4l0k6854s1curg.apps.googleusercontent.com',
  projectNumber: '964305676640',
};

export const googleConfigured = () => Boolean(GOOGLE.clientId && GOOGLE.clientSecret);
export const pickerConfigured = () => googleConfigured() && Boolean(GOOGLE.pickerClientId);
export const PICKED_PAGE = new URL('picked.html', location.href.split('#')[0]).href;
