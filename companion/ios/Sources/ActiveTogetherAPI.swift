import Foundation

struct TeamOption: Identifiable, Hashable {
    let teamId: Int
    let teamName: String
    let challengeId: Int
    let challengeName: String
    var id: Int { teamId }
    var label: String { "\(challengeName) — \(teamName)" }
}

struct ImportResult {
    let added: Int
    let skipped: Int
}

enum APIError: LocalizedError {
    case server(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .server(let message): return message
        case .invalidResponse: return "The server returned an unexpected response."
        }
    }
}

final class ActiveTogetherAPI {
    let baseURL: URL

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    func login(email: String, password: String) async throws -> String {
        let json = try await request(path: "/api/login", method: "POST", token: nil, body: ["email": email, "password": password])
        guard let token = json["sessionToken"] as? String else { throw APIError.invalidResponse }
        return token
    }

    /// A team only appears here if this account is already a member of it — joining a
    /// challenge or team (by invite code) happens in the web app, not this sync-only companion.
    func bootstrap(token: String) async throws -> [TeamOption] {
        let json = try await request(path: "/api/mobile/bootstrap", method: "GET", token: token, body: nil)
        guard let challenges = json["challenges"] as? [[String: Any]] else { return [] }
        var options: [TeamOption] = []
        for challenge in challenges {
            guard let challengeId = challenge["id"] as? Int,
                  let challengeName = challenge["name"] as? String,
                  let teams = challenge["teams"] as? [[String: Any]] else { continue }
            for team in teams {
                guard let teamId = team["id"] as? Int, let teamName = team["name"] as? String else { continue }
                options.append(TeamOption(teamId: teamId, teamName: teamName, challengeId: challengeId, challengeName: challengeName))
            }
        }
        return options
    }

    func importHealth(token: String, records: [HealthRecord]) async throws -> ImportResult {
        let recordsData = try JSONEncoder().encode(records)
        let recordsArray = try JSONSerialization.jsonObject(with: recordsData)
        let json = try await request(path: "/api/health/import", method: "POST", token: token, body: ["source": "health_kit", "records": recordsArray])
        guard let added = json["added"] as? Int, let skipped = json["skipped"] as? Int else { throw APIError.invalidResponse }
        return ImportResult(added: added, skipped: skipped)
    }

    private func request(path: String, method: String, token: String?, body: [String: Any]?) async throws -> [String: Any] {
        let base = baseURL.absoluteString.hasSuffix("/") ? String(baseURL.absoluteString.dropLast()) : baseURL.absoluteString
        guard let url = URL(string: base + path) else { throw APIError.invalidResponse }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200...299).contains(http.statusCode) else {
            let message = (json["error"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Request failed with HTTP \(http.statusCode)"
            throw APIError.server(message)
        }
        return json
    }
}
