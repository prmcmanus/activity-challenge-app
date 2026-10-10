import SwiftUI
import UserNotifications

/// Phone notifications through Apple's push service (ticket replies, being added to a challenge, challenges starting and
/// ending, a weekly summary). The app asks once the server says it can send them; the token goes to the server; a tapped
/// notification opens its challenge or ticket.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    /// The app's model, set when the app starts, for tokens and tapped notifications to reach.
    @MainActor static weak var model: AppModel?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in await AppDelegate.model?.registerPush(token) }
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}
    // Shown even while the app is open.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .sound] }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let url = response.notification.request.content.userInfo["url"] as? String
        await MainActor.run { AppDelegate.model?.pendingRoute = url }
    }
}

enum PushSetup {
    /// Asks (the system only asks once) and, if allowed, registers this phone with Apple for notifications.
    @MainActor static func ask() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in
            if ok { Task { @MainActor in UIApplication.shared.registerForRemoteNotifications() } }
        }
    }
}
