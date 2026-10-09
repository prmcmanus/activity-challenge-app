import SwiftUI
import WebKit

/// A page of the website inside the app (the privacy policy, by default), so reading it never sends anyone off
/// to Safari. The page opens with ?in_app=1, which hides the site's own header and footer; links to other pages
/// of the site stay here, and anything else (an email address, another site) opens outside.
struct PolicyView: View {
    var path = "/privacy.html"
    var title = "Privacy policy"
    @Environment(\.dismiss) private var dismiss
    @State private var loading = true
    @State private var failed = false
    var body: some View {
        NavigationStack {
            ZStack {
                WebPage(url: inAppURL(URL(string: serverURL + path)!), loading: $loading, failed: $failed)
                if loading { ProgressView() }
                if failed { Text("Couldn't load the page. Check your connection and try again.").multilineTextAlignment(.center).padding() }
            }
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

private func inAppURL(_ url: URL) -> URL {
    guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
    if !(c.queryItems ?? []).contains(where: { $0.name == "in_app" }) { c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "in_app", value: "1")] }
    return c.url ?? url
}

private struct WebPage: UIViewRepresentable {
    let url: URL
    @Binding var loading: Bool
    @Binding var failed: Bool
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let web = WKWebView()
        web.navigationDelegate = context.coordinator
        web.load(URLRequest(url: url))
        return web
    }
    func updateUIView(_ web: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let page: WebPage
        init(_ page: WebPage) { self.page = page }
        func webView(_ web: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let u = action.request.url else { return decisionHandler(.cancel) }
            let site = URL(string: serverURL)?.host
            if (u.scheme == "https" || u.scheme == "http") && u.host == site {
                // Another page of the site: stays here, still without the site's header.
                if (URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems ?? []).contains(where: { $0.name == "in_app" }) { return decisionHandler(.allow) }
                decisionHandler(.cancel); web.load(URLRequest(url: inAppURL(u))); return
            }
            if u.scheme == "about" { return decisionHandler(.allow) }
            UIApplication.shared.open(u)
            decisionHandler(.cancel)
        }
        func webView(_ web: WKWebView, didFinish navigation: WKNavigation!) { page.loading = false }
        func webView(_ web: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { page.loading = false; page.failed = true }
    }
}

/// Creating an account in the app: name, email and password, and on an invite-only site the invite code (filled
/// in already when an invite link brought them here). Signed in straight afterwards.
struct CreateAccountForm: View {
    @Environment(AppModel.self) private var model
    var backToSignIn: () -> Void
    @State private var name = ""
    @State private var email = ""
    @State private var password = ""
    @State private var invite = ""
    @State private var inviteOnly = false
    @State private var busy = false
    @State private var error: String?
    @State private var showPolicy = false
    var body: some View {
        VStack(spacing: 12) {
            Text("Create your account").font(.title3.bold()).frame(maxWidth: .infinity, alignment: .leading)
            TextField("Name", text: $name).textContentType(.name).textInputAutocapitalization(.words)
            TextField("Email", text: $email).textContentType(.username).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
            SecureField("Password (at least 8 characters)", text: $password).textContentType(.newPassword)
            if inviteOnly && model.pendingInvite == nil {
                TextField("Invite code", text: $invite).textInputAutocapitalization(.characters).autocorrectionDisabled()
                Text("Active Together is invite only: use the code from the invite someone sent you.").font(.caption).foregroundStyle(.secondary)
            }
            if let error { Text(error).foregroundStyle(.red).font(.subheadline) }
            Button {
                busy = true; error = nil
                Task {
                    let code = (model.pendingInvite ?? invite).trimmingCharacters(in: .whitespaces).uppercased()
                    error = await model.register(name: name, email: email, password: password, inviteCode: code.isEmpty ? nil : code)
                    busy = false
                }
            } label: { Group { if busy { ProgressView().tint(.white) } else { Text("Create account").bold() } }.frame(maxWidth: .infinity) }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty || email.isEmpty || password.count < 8)
            Text("By creating an account you agree to our privacy policy.").font(.footnote).foregroundStyle(.secondary)
            Button("Privacy policy") { showPolicy = true }.font(.footnote)
            Button("I have an account: sign in", action: backToSignIn).font(.footnote.bold())
        }
        .sheet(isPresented: $showPolicy) { PolicyView() }
        .task { inviteOnly = (try? await API(token: nil).inviteOnly()) ?? false }
    }
}
