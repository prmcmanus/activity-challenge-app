import AuthenticationServices
import UIKit

/// Passkeys through Apple's AuthenticationServices, for the website's account: the replies come back as the WebAuthn JSON
/// the server checks (base64url fields).
final class PasskeyFlow: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var done: ((Result<ASAuthorization, Error>) -> Void)?
    private static var running: PasskeyFlow?

    private func run(_ request: ASAuthorizationRequest) async throws -> ASAuthorization? {
        do {
            return try await withCheckedThrowingContinuation { (c: CheckedContinuation<ASAuthorization, Error>) in
                done = { c.resume(with: $0) }
                PasskeyFlow.running = self
                let ctl = ASAuthorizationController(authorizationRequests: [request])
                ctl.delegate = self; ctl.presentationContextProvider = self
                ctl.performRequests()
            }
        } catch let e as ASAuthorizationError where e.code == .canceled { return nil }
    }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) { done?(.success(authorization)); done = nil; PasskeyFlow.running = nil }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) { done?(.failure(error)); done = nil; PasskeyFlow.running = nil }
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
    }

    private static func data(_ b64url: String) -> Data {
        var s = b64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        return Data(base64Encoded: s) ?? Data()
    }
    private static func b64(_ d: Data) -> String { d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }

    /// Signing in: the passkey's signed reply, or nil if cancelled.
    @MainActor static func assertion(challenge: String, rpId: String) async throws -> [String: Any]? {
        let req = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId).createCredentialAssertionRequest(challenge: data(challenge))
        guard let a = try await PasskeyFlow().run(req)?.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else { return nil }
        return ["id": b64(a.credentialID), "rawId": b64(a.credentialID), "type": "public-key",
                "response": ["clientDataJSON": b64(a.rawClientDataJSON), "authenticatorData": b64(a.rawAuthenticatorData), "signature": b64(a.signature), "userHandle": b64(a.userID)]]
    }
    /// Adding one: the new passkey's reply, or nil if cancelled.
    @MainActor static func registration(challenge: String, rpId: String, userId: String, name: String) async throws -> [String: Any]? {
        let req = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId).createCredentialRegistrationRequest(challenge: data(challenge), name: name, userID: data(userId))
        guard let r = try await PasskeyFlow().run(req)?.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration, let att = r.rawAttestationObject else { return nil }
        return ["id": b64(r.credentialID), "rawId": b64(r.credentialID), "type": "public-key", "response": ["clientDataJSON": b64(r.rawClientDataJSON), "attestationObject": b64(att)]]
    }
}
