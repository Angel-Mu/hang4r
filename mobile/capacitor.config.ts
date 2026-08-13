import type { CapacitorConfig } from '@capacitor/cli'
import { KeyboardResize } from '@capacitor/keyboard'

const config: CapacitorConfig = {
  appId: 'dev.hang4r.mobile',
  appName: 'hang4r',
  webDir: 'dist',
  ios: { contentInset: 'never' },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#0d0d14',
      showSpinner: false
    },
    Keyboard: { resize: KeyboardResize.Body }
  }
}

export default config
