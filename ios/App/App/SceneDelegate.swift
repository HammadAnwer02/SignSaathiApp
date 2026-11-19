import UIKit
import WebKit
import Capacitor

/// iOS 27 won't launch an app that hasn't adopted the scene life cycle. The window, and the Capacitor bridge in it,
/// still come from Main.storyboard (Info.plist names it in the scene configuration). This hands Capacitor the links
/// and activities that now arrive through the scene instead of the app delegate.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?
    /// Someone practising along signs with both hands and never touches the phone, so while the page has the
    /// camera the screen stays on. The page lets the camera go when it leaves practice or the app goes away.
    private var cameraWatch: NSKeyValueObservation?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // code that still asks the app delegate for its window finds this one
        (UIApplication.shared.delegate as? AppDelegate)?.window = window
        // a cold launch from a link arrives here, not through the calls below
        connectionOptions.urlContexts.forEach(self.openURL)
        connectionOptions.userActivities.forEach(self.continueActivity)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        // the bridge's web view exists once the window is on screen
        guard cameraWatch == nil, let webView = (window?.rootViewController as? CAPBridgeViewController)?.webView else { return }
        cameraWatch = webView.observe(\.cameraCaptureState, options: [.initial, .new]) { _, _ in
            DispatchQueue.main.async {
                UIApplication.shared.isIdleTimerDisabled = webView.cameraCaptureState == .active
            }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        URLContexts.forEach(self.openURL)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        continueActivity(userActivity)
    }

    private func openURL(_ context: UIOpenURLContext) {
        var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
        if let source = context.options.sourceApplication { options[.sourceApplication] = source }
        if let annotation = context.options.annotation { options[.annotation] = annotation }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url, options: options)
    }

    private func continueActivity(_ activity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
}
