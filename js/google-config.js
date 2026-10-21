// Google Cloud registration for "Connect with Google" (Google Sheets without a script).
// Fill these in from the Google Cloud console (see GOOGLE-SETUP.md). Until they're filled in,
// the app only offers the script method.
//
// The client secret for this client type ("TVs and Limited Input devices") isn't actually secret:
// Google issues it for apps that run on people's own devices and expects it to ship inside the app.

export const GOOGLE = {
  clientId: '964305676640-t40935na6ombct5a74u4f2tn10rmdpv7.apps.googleusercontent.com',
  clientSecret: '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',
  // For the "choose an existing sheet" picker:
  apiKey: 'AIzaSyDpC6bVTMQES2TnHx25kpuIoKPNj7Gvvws', // restricted to this site and the Picker API
  projectNumber: '964305676640',
};

export const googleConfigured = () => Boolean(GOOGLE.clientId && GOOGLE.clientSecret);
export const pickerConfigured = () => googleConfigured() && Boolean(GOOGLE.apiKey && GOOGLE.projectNumber);
