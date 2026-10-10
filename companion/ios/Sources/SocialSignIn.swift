import SwiftUI
import AuthenticationServices
import CryptoKit

/// "Continue with Google" (when the server has it set up) and, in the App Store build, "Sign in with Apple".
/// Each hands back the provider's ID token (and, from Apple the first time, the person's name) to `onToken`.
struct SocialButtons: View {
    var onToken: (_ provider: String, _ token: String, _ name: String?) -> Void
    @Environment(\.webAuthenticationSession) private var webAuth
    @State private var googleClient: String?
    @State private var error: String?
    var body: some View {
        VStack(spacing: 10) {
            if let googleClient {
                Button {
                    Task {
                        do { onToken("google", try await googleIdToken(clientId: googleClient, session: webAuth), nil) }
                        catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {}
                        catch { self.error = error.localizedDescription }
                    }
                } label: {
                    HStack(spacing: 10) { Image("GoogleG").resizable().frame(width: 18, height: 18); Text("Continue with Google").fontWeight(.medium) }
                        .frame(maxWidth: .infinity).frame(height: 44)
                }
                .buttonStyle(.bordered).tint(.primary)
            }
            if isAppStoreBuild {
                SignInWithAppleButton(.continue) { $0.requestedScopes = [.fullName, .email] } onCompletion: { result in
                    guard case .success(let auth) = result, let c = auth.credential as? ASAuthorizationAppleIDCredential,
                          let data = c.identityToken, let token = String(data: data, encoding: .utf8) else {
                        if case .failure(let e) = result, (e as? ASAuthorizationError)?.code != .canceled { error = e.localizedDescription }
                        return
                    }
                    let name = [c.fullName?.givenName, c.fullName?.familyName].compactMap { $0 }.joined(separator: " ")
                    onToken("apple", token, name.isEmpty ? nil : name)
                }
                .frame(height: 44)
            }
            if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            if googleClient != nil || isAppStoreBuild { Text("or with your email").font(.footnote).foregroundStyle(.secondary) }
        }
        .task { googleClient = try? await API(token: nil).googleIosClientId() }
    }
}

/// Google's sign-in page in Apple's secure browser sheet, using OAuth with PKCE as Google asks of iPhone apps
/// (no client secret). Returns Google's ID token, which our server checks.
func googleIdToken(clientId: String, session: WebAuthenticationSession) async throws -> String {
    // The iOS client's redirect: its ID backwards (com.googleusercontent.apps.NNNN), which Google allows for iPhone apps.
    let scheme = clientId.split(separator: ".").reversed().joined(separator: ".")
    let redirect = "\(scheme):/oauth2redirect"
    var bytes = [UInt8](repeating: 0, count: 32)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    let verifier = base64URL(Data(bytes))
    let challenge = base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    var auth = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
    auth.queryItems = [.init(name: "client_id", value: clientId), .init(name: "redirect_uri", value: redirect), .init(name: "response_type", value: "code"),
                       .init(name: "scope", value: "openid email profile"), .init(name: "code_challenge", value: challenge),
                       .init(name: "code_challenge_method", value: "S256"), .init(name: "prompt", value: "select_account")]
    let callback = try await session.authenticate(using: auth.url!, callbackURLScheme: scheme)
    guard let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value else {
        throw APIError(status: 0, message: "Google didn't return a sign-in")
    }
    var req = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
    req.httpMethod = "POST"
    req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    var form = URLComponents()
    form.queryItems = [.init(name: "code", value: code), .init(name: "client_id", value: clientId), .init(name: "code_verifier", value: verifier),
                       .init(name: "grant_type", value: "authorization_code"), .init(name: "redirect_uri", value: redirect)]
    req.httpBody = form.percentEncodedQuery?.data(using: .utf8)
    let (data, _) = try await URLSession.shared.data(for: req)
    guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any], let token = json["id_token"] as? String else {
        throw APIError(status: 0, message: "Signing in with Google didn't work. Please try again.")
    }
    return token
}

private func base64URL(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
