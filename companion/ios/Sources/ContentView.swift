import SwiftUI

struct ContentView: View {
    @AppStorage("serverUrl") private var serverUrl: String = "http://localhost:3000"
    @AppStorage("email") private var email: String = ""
    @AppStorage("sessionToken") private var sessionToken: String = ""
    @State private var password: String = ""
    @State private var teamOptions: [TeamOption] = []
    @State private var selectedTeamId: Int?
    @State private var status: String = "Sign in, then pick the challenge/team to sync into. Join challenges and teams in the web app first — this companion only syncs Apple Health data into a team you already belong to."
    @State private var isBusy = false

    private let health = HealthKitSync()

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("Server URL", text: $serverUrl)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    TextField("Email", text: $email)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                    SecureField("Password", text: $password)
                    Button("Sign in") { Task { await signIn() } }
                        .disabled(isBusy || serverUrl.isEmpty || email.isEmpty || password.isEmpty)
                }

                if !teamOptions.isEmpty {
                    Section("Sync into") {
                        Picker("Challenge — Team", selection: $selectedTeamId) {
                            ForEach(teamOptions) { option in
                                Text(option.label).tag(Optional(option.teamId))
                            }
                        }
                        Button("Sync Apple Health") { Task { await sync() } }
                            .disabled(isBusy || selectedTeamId == nil)
                    }
                }

                Section("Status") {
                    Text(status).font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Active Together")
            .disabled(isBusy)
        }
    }

    private func api() -> ActiveTogetherAPI? {
        guard let url = URL(string: serverUrl) else { return nil }
        return ActiveTogetherAPI(baseURL: url)
    }

    private func signIn() async {
        guard let api = api() else { status = "Enter a valid server URL."; return }
        isBusy = true
        defer { isBusy = false }
        do {
            let token = try await api.login(email: email, password: password)
            sessionToken = token
            let options = try await api.bootstrap(token: token)
            teamOptions = options
            selectedTeamId = options.first?.teamId
            status = options.isEmpty
                ? "Signed in, but you are not in any team yet. Join a challenge and a team in the web app, then sign in here again."
                : "Signed in. Found \(options.count) team membership(s)."
        } catch {
            status = "Sign in failed: \(error.localizedDescription)"
        }
    }

    private func sync() async {
        guard let api = api(), !sessionToken.isEmpty, let teamId = selectedTeamId,
              let team = teamOptions.first(where: { $0.teamId == teamId }) else {
            status = "Sign in and select a challenge/team before syncing."
            return
        }
        isBusy = true
        defer { isBusy = false }
        status = "Reading Apple Health…"
        do {
            try await health.requestAuthorization()
            let records = try await health.readRecentWorkouts(teamId: team.teamId, challengeId: team.challengeId)
            let result = try await api.importHealth(token: sessionToken, records: records)
            status = "Sync complete. Added \(result.added), skipped \(result.skipped)."
                + (team.measuresDistance && result.skipped > 0 ? " Workouts with no recorded distance are skipped in a distance challenge." : "")
        } catch {
            status = "Sync failed: \(error.localizedDescription)"
        }
    }
}

#Preview {
    ContentView()
}
