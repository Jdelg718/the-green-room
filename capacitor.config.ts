import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "net.greenroomai.GreenRoom",
  appName: "Green Room",
  webDir: "ios-web",
  includePlugins: [],
  ios: {
    allowsLinkPreview: false,
    loggingBehavior: "none",
  },
  cordova: {
    accessOrigins: [],
    preferences: {
      DisableDeploy: "true",
    },
  },
};

export default config;
