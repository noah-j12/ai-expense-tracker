// Google Cloud registration for "Connect with Google" (Google Sheets without a script).
// Fill these in from the Google Cloud console (see GOOGLE-SETUP.md). Until they're filled in,
// the app only offers the script method.
//
// The client secret for this client type ("TVs and Limited Input devices") isn't actually secret:
// Google issues it for apps that run on people's own devices and expects it to ship inside the app.

export const GOOGLE = {
  clientId: '',
  clientSecret: '',
  // For the "choose an existing sheet" picker:
  apiKey: '',
  projectNumber: '',
};

export const googleConfigured = () => Boolean(GOOGLE.clientId && GOOGLE.clientSecret);
export const pickerConfigured = () => googleConfigured() && Boolean(GOOGLE.apiKey && GOOGLE.projectNumber);
